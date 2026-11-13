/** 场次与模特域：可见性过滤、详情判权、余量、后台场次/时段/分档价格 CRUD。 */
import type { Express } from 'express';
import { Router } from 'express';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  EVENT_TRANSITIONS,
  adminEventListQuerySchema,
  assertTransition,
  eventCreateSchema,
  eventPatchSchema,
  modelProfileUpsertSchema,
  pageQuerySchema,
  satisfiesLevel,
  satisfiesVisibility,
  type AdminEventListQuery,
  type EventCreatePayload,
  type EventDto,
  type EventPatchPayload,
  type ModelProfileUpsertPayload,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate, optionalAuthenticate } from '../middleware/auth';
import { requireCapabilities, visibilityFilter } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import {
  eventDtoOf, modelDtoOf, pageArgsOf, paginatedOf, priceDtoOf, sessionDtoOf, type EventRow,
} from '../domain/dto';
import { applyLedgerEntry } from '../domain/ledger';
import { decideRegistration } from '../domain/policy';
import { releaseCouponOf } from './coupons.module';
import { fromSqlDateTime, toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

const sqlTime = (iso: string): string => toSqlDateTime(new Date(iso));
const isoTime = (sql: string): string => fromSqlDateTime(sql).toISOString();
const currentLevel = () => getIdentity()?.level ?? 'NONE';
const hasBalance = () => currentLevel() === 'VIP' || currentLevel() === 'SVIP';
/** 点3：身高/三围等敏感身体数据仅 VIP/SVIP 可见；公开端按当前等级判定，后台恒 true */
const memberBody = () => satisfiesLevel(currentLevel(), 'VIP');

interface SessionRow extends RowDataPacket {
  id: string; event_id: string; label: string; start_at: string; end_at: string;
  capacity: number; capacity_used: number; status: string; sort_no: number;
  created_at: string; updated_at: string;
}

async function loadEvent(id: string): Promise<EventRow> {
  const [rows] = await pool.execute<EventRow[]>(
    'SELECT * FROM events WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id],
  );
  const row = rows[0];
  if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
  return row;
}

async function loadSessions(eventId: string): Promise<SessionRow[]> {
  const [rows] = await pool.execute<SessionRow[]>(
    'SELECT * FROM event_sessions WHERE event_id = ? ORDER BY sort_no ASC, id ASC', [eventId],
  );
  return rows;
}

async function loadPrices(eventId: string): Promise<RowDataPacket[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM event_prices WHERE event_id = ?', [eventId],
  );
  return rows;
}

/** 组装完整 DTO（模特 + 时段 + 分档价）。列表场景为 N+1，数据量小可接受。 */
async function withRelations(row: EventRow, includeBody = false): Promise<EventDto> {
  const modelRows = row.model_id
    ? (await pool.execute<RowDataPacket[]>(
        'SELECT * FROM model_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1', [row.model_id],
      ))[0]
    : [];
  const [sessions, prices] = await Promise.all([loadSessions(String(row.id)), loadPrices(String(row.id))]);
  return eventDtoOf(
    row,
    modelRows[0] ? modelDtoOf(modelRows[0], includeBody) : null,
    sessions.map(sessionDtoOf),
    prices.map(priceDtoOf),
  );
}

async function replaceRelations(
  conn: PoolConnection,
  eventId: string,
  sessions: EventCreatePayload['sessions'],
  prices: EventCreatePayload['prices'],
  now: string,
): Promise<void> {
  await conn.execute('DELETE FROM event_sessions WHERE event_id = ?', [eventId]);
  await conn.execute('DELETE FROM event_prices WHERE event_id = ?', [eventId]);
  for (const [i, s] of sessions.entries()) {
    await conn.execute(
      `INSERT INTO event_sessions (event_id, label, start_at, end_at, capacity, sort_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, s.label, sqlTime(s.startAt), sqlTime(s.endAt), s.capacity, i, now, now],
    );
  }
  for (const p of prices) {
    await conn.execute(
      'INSERT INTO event_prices (event_id, level, price_cent, unit_label) VALUES (?, ?, ?, ?)',
      [eventId, p.level, p.priceCent, p.unitLabel],
    );
  }
}

/**
 * 仍占名额/仍需履约的报名状态；已失效、已退款、已取消不再阻挡排期调整。
 * WAITLISTED / OFFERED 是候补下线前的存量状态：历史行仍可能占着名额，
 * 因此继续计入，避免把容量压到历史报名人数以下。
 */
const LIVE_REG_STATUSES =
  "('WAITLISTED','OFFERED','CONFIRMED','REFUND_PENDING','CHECKED_IN','COMPLETED')";

/**
 * 编辑场次时按时段 id 做增改删，绝不整表重建：
 * 整表重建会让 registrations.session_id 指向被删的行，历史报名直接失去时段信息。
 * 有报名的时段不能删，容量也不能压到已报名人数以下。
 */
async function syncRelations(
  conn: PoolConnection,
  eventId: string,
  sessions: EventCreatePayload['sessions'],
  prices: EventCreatePayload['prices'],
  existing: SessionRow[],
  now: string,
): Promise<void> {
  const byId = new Map(existing.map((s) => [String(s.id), s]));
  const kept = new Set<string>();
  for (const s of sessions) {
    if (!s.id) continue;
    if (!byId.has(s.id)) throw new AppError(BIZ_CODES.INVALID_PARAM, '时段不属于该场次，请刷新后重试');
    if (kept.has(s.id)) throw new AppError(BIZ_CODES.INVALID_PARAM, '时段重复提交，请刷新后重试');
    kept.add(s.id);
  }

  const [countRows] = await conn.execute<RowDataPacket[]>(
    `SELECT session_id, COUNT(*) AS cnt FROM registrations
      WHERE event_id = ? AND session_id IS NOT NULL AND status IN ${LIVE_REG_STATUSES}
      GROUP BY session_id`,
    [eventId],
  );
  const liveBySession = new Map(countRows.map((r) => [String(r.session_id), Number(r.cnt)]));

  const removed = existing.filter((s) => !kept.has(String(s.id)));
  for (const s of removed) {
    const cnt = liveBySession.get(String(s.id)) ?? 0;
    if (cnt > 0) {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, `时段「${s.label}」还有 ${cnt} 人报名，不能删除`);
    }
  }
  if (removed.length) {
    await conn.execute(
      `DELETE FROM event_sessions WHERE event_id = ? AND id IN (${removed.map(() => '?').join(',')})`,
      [eventId, ...removed.map((s) => String(s.id))],
    );
  }

  for (const [i, s] of sessions.entries()) {
    const capacity = Math.max(1, Number(s.capacity));
    if (s.id) {
      const old = byId.get(s.id)!;
      // 容量口径取「计数器」与「真实在册报名」的较大值，避免计数器滞后时压穿
      const used = Math.max(Number(old.capacity_used), liveBySession.get(s.id) ?? 0);
      if (capacity < used) {
        throw new AppError(
          BIZ_CODES.CAPACITY_BELOW_USED, `时段「${s.label}」已有 ${used} 人报名，容量不能小于 ${used}`,
        );
      }
      await conn.execute(
        `UPDATE event_sessions SET label = ?, start_at = ?, end_at = ?, capacity = ?, sort_no = ?, updated_at = ?
          WHERE id = ? AND event_id = ?`,
        [s.label, sqlTime(s.startAt), sqlTime(s.endAt), capacity, i, now, s.id, eventId],
      );
    } else {
      await conn.execute(
        `INSERT INTO event_sessions (event_id, label, start_at, end_at, capacity, sort_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, s.label, sqlTime(s.startAt), sqlTime(s.endAt), capacity, i, now, now],
      );
    }
  }

  // 价格不参与报名历史，整体替换即可；报名时已把当时的退款规则快照写入 registrations
  await conn.execute('DELETE FROM event_prices WHERE event_id = ?', [eventId]);
  for (const p of prices) {
    await conn.execute(
      'INSERT INTO event_prices (event_id, level, price_cent, unit_label) VALUES (?, ?, ?, ?)',
      [eventId, p.level, p.priceCent, p.unitLabel],
    );
  }
}

async function createEvent(p: EventCreatePayload): Promise<string> {
  const now = toSqlDateTime();
  return withTransaction(async (conn) => {
    const ordered = [...p.sessions].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const totalCapacity = ordered.reduce((s, x) => s + x.capacity, 0);
    const publicPrice = p.prices.find((x) => x.level === 'PUBLIC')?.priceCent ?? p.feeCent ?? 0;

    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO events
        (title, subtitle, description, cover_url, poster_urls, wardrobe_urls, venue_urls, venue, scene, notice,
         ratio_label, model_count, allow_proxy_shoot, private_booking_note, model_id, scene_id,
         registration_open_at, registration_close_at, start_at, end_at, visibility, register_min_level,
         fee_cent, capacity, capacity_used, allow_coupon, refund_policy, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,'DRAFT',?,?)`,
      [
        p.title, p.subtitle ?? null, p.description ?? null, p.coverUrl ?? null,
        JSON.stringify(p.posterUrls ?? []), JSON.stringify(p.wardrobeUrls ?? []),
        JSON.stringify(p.venueUrls ?? []),
        p.venue, p.scene ?? null, p.notice ?? null,
        p.ratioLabel ?? null, p.modelCount, p.allowProxyShoot ? 1 : 0, p.privateBookingNote ?? null,
        p.modelId ?? null, p.sceneId ?? null,
        sqlTime(p.registrationOpenAt), sqlTime(p.registrationCloseAt),
        sqlTime(p.startAt ?? first.startAt), sqlTime(p.endAt ?? last.endAt),
        p.visibility, p.registerMinLevel, publicPrice, totalCapacity,
        p.allowCoupon ? 1 : 0, JSON.stringify(p.refundPolicy), now, now,
      ],
    );
    const eventId = String(result.insertId);
    await replaceRelations(conn, eventId, p.sessions, p.prices, now);
    return eventId;
  });
}

async function patchEvent(id: string, patch: EventPatchPayload): Promise<string> {
  const row = await loadEvent(id);

  // 派生字段只读：容量/总价/起止时间由时段与分档价推导，避免与真实排期脱节
  for (const key of ['capacity', 'feeCent', 'startAt', 'endAt'] as const) {
    if (patch[key] !== undefined) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, `${key} 由时段与价格自动推导，请修改时段或分档价`);
    }
  }
  if (Boolean(patch.sessions) !== Boolean(patch.prices)) {
    throw new AppError(BIZ_CODES.INVALID_PARAM, '修改时段必须同时提交分档价格');
  }

  /**
   * PATCH 可能只带部分字段，必须与库中现值合并后重新走完整时间链校验：
   * 报名开始 < 报名截止 < 每个时段开始 < 时段结束。
   */
  const [existingRows] = await pool.execute<SessionRow[]>(
    'SELECT * FROM event_sessions WHERE event_id = ? ORDER BY sort_no ASC, id ASC', [id],
  );
  const openAt = patch.registrationOpenAt ?? isoTime(row.registration_open_at);
  const closeAt = patch.registrationCloseAt ?? isoTime(row.registration_close_at);
  if (Date.parse(openAt) >= Date.parse(closeAt)) {
    throw new AppError(BIZ_CODES.INVALID_PARAM, '报名截止必须晚于报名开始');
  }
  const chain = patch.sessions
    ?? existingRows.map((s) => ({
      label: s.label, startAt: isoTime(s.start_at), endAt: isoTime(s.end_at), capacity: Number(s.capacity),
    }));
  chain.forEach((s, i) => {
    const name = s.label ? `「${s.label}」` : `第 ${i + 1} 个时段`;
    if (Date.parse(s.startAt) >= Date.parse(s.endAt)) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, `时段${name}结束必须晚于开始`);
    }
    if (Date.parse(closeAt) > Date.parse(s.startAt)) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, `报名截止不能晚于时段${name}的开始时间`);
    }
  });
  if (patch.prices) {
    const levels = patch.prices.map((p) => p.level);
    if (new Set(levels).size !== levels.length) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '价格档位不可重复');
    }
  }

  const columns: Record<string, string> = {
    title: 'title', subtitle: 'subtitle', description: 'description', coverUrl: 'cover_url',
    posterUrls: 'poster_urls', wardrobeUrls: 'wardrobe_urls', venueUrls: 'venue_urls', venue: 'venue', scene: 'scene',
    notice: 'notice', ratioLabel: 'ratio_label', modelCount: 'model_count',
    allowProxyShoot: 'allow_proxy_shoot', privateBookingNote: 'private_booking_note',
    modelId: 'model_id', sceneId: 'scene_id', registrationOpenAt: 'registration_open_at',
    registrationCloseAt: 'registration_close_at', visibility: 'visibility', registerMinLevel: 'register_min_level',
    allowCoupon: 'allow_coupon', refundPolicy: 'refund_policy',
  };
  const source = patch as Record<string, unknown>;
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = source[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    if (key.endsWith('At')) values.push(sqlTime(value as string));
    else if (key === 'refundPolicy' || key === 'posterUrls' || key === 'wardrobeUrls' || key === 'venueUrls') values.push(JSON.stringify(value));
    else if (key === 'allowProxyShoot' || key === 'allowCoupon') values.push(value ? 1 : 0);
    else values.push(value as string | number | null);
  }

  const wantsRelations = Boolean(patch.sessions);
  await withTransaction(async (conn) => {
    // 锁住本场次全部时段：与报名时对单个时段加的 FOR UPDATE 串行，避免「刚删完又有人报进被删时段」
    const [lockedRows] = await conn.execute<SessionRow[]>(
      'SELECT * FROM event_sessions WHERE event_id = ? ORDER BY sort_no ASC, id ASC FOR UPDATE', [id],
    );
    if (sets.length) {
      await conn.execute(`UPDATE events SET ${sets.join(', ')}, version = version + 1 WHERE id = ?`, [...values, id]);
    }
    if (wantsRelations && patch.sessions && patch.prices) {
      const now = toSqlDateTime();
      await syncRelations(conn, id, patch.sessions, patch.prices, lockedRows, now);
      const ordered = [...patch.sessions].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      const totalCapacity = ordered.reduce((s, x) => s + x.capacity, 0);
      const publicPrice = patch.prices.find((x) => x.level === 'PUBLIC')?.priceCent ?? 0;
      await conn.execute(
        'UPDATE events SET start_at = ?, end_at = ?, capacity = ?, fee_cent = ? WHERE id = ?',
        [sqlTime(ordered[0]!.startAt), sqlTime(ordered[ordered.length - 1]!.endAt), totalCapacity, publicPrice, id],
      );
    }
  });
  return id;
}

export function mountEvents(app: Express): void {
  const pub = Router();
  pub.use(optionalAuthenticate);

  pub.get('/', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { clause, params } = visibilityFilter(currentLevel());
    const [rows] = await pool.execute<EventRow[]>(
      `SELECT * FROM events WHERE deleted_at IS NULL AND status <> 'DRAFT' AND ${clause}
        ORDER BY start_at ASC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM events WHERE deleted_at IS NULL AND status <> 'DRAFT' AND ${clause}`, params,
    );
    const list = await Promise.all(rows.map((r) => withRelations(r, memberBody())));
    sendOk(res, paginatedOf(list, Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  pub.get('/:id/availability', asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    // 草稿只有后台可见：前台按不存在处理，避免提前暴露未发布的排期
    if (row.status === 'DRAFT') throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (!satisfiesVisibility(currentLevel(), row.visibility)) throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT);
    const sessions = await loadSessions(String(row.id));
    const identity = getIdentity();
    let available = 0;
    if (identity && hasBalance()) {
      const [bal] = await pool.execute<RowDataPacket[]>(
        'SELECT available_cent FROM balance_accounts WHERE user_id = ?', [identity.userId],
      );
      available = Number(bal[0]?.available_cent ?? 0);
    }
    const target = sessions.find((s) => s.status === 'OPEN') ?? sessions[0];
    const decision = target
      ? decideRegistration({
          event: {
            status: row.status, visibility: row.visibility,
            registerMinLevel: (row.register_min_level ?? 'NONE') as EventDto['registerMinLevel'],
            registrationOpenAt: isoTime(row.registration_open_at),
            registrationCloseAt: isoTime(row.registration_close_at),
          },
          session: {
            status: target.status, startAt: isoTime(target.start_at), endAt: isoTime(target.end_at),
            capacity: Number(target.capacity), capacityUsed: Number(target.capacity_used),
          },
          level: currentLevel(), priceCent: Number(row.fee_cent),
          hasBalance: hasBalance(), availableCent: available,
        })
      : { ok: false, reasonCode: BIZ_CODES.EVENT_NOT_OPEN };
    const totalCapacity = sessions.reduce((s, x) => s + Number(x.capacity), 0) || Number(row.capacity);
    const totalUsed = sessions.reduce((s, x) => s + Number(x.capacity_used), 0) || Number(row.capacity_used);
    sendOk(res, {
      eventId: String(row.id), capacity: totalCapacity, capacityUsed: totalUsed,
      remaining: Math.max(0, totalCapacity - totalUsed),
      canRegister: decision.ok,
      reasonCode: decision.reasonCode,
    });
  }));

  pub.get('/:id', asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    if (row.status === 'DRAFT') throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (!satisfiesVisibility(currentLevel(), row.visibility)) throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT);
    sendOk(res, await withRelations(row, memberBody()));
  }));

  const models = Router();
  models.use(optionalAuthenticate);
  models.get('/', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { clause, params } = visibilityFilter(currentLevel());
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM model_profiles WHERE deleted_at IS NULL AND ${clause} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    sendOk(res, paginatedOf(rows.map((r) => modelDtoOf(r, memberBody())), rows.length, page, pageSize));
  }));
  models.get('/:id/events', asyncHandler(async (req, res) => {
    const { clause, params } = visibilityFilter(currentLevel());
    const [rows] = await pool.execute<EventRow[]>(
      `SELECT * FROM events WHERE deleted_at IS NULL AND status <> 'DRAFT' AND model_id = ? AND ${clause}
        ORDER BY start_at ASC`,
      [req.params.id, ...params],
    );
    sendOk(res, paginatedOf(await Promise.all(rows.map((r) => withRelations(r, memberBody()))), rows.length, 1, 20));
  }));
  models.get('/:id', asyncHandler(async (req, res) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM model_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1', [req.params.id],
    );
    if (!rows[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    sendOk(res, modelDtoOf(rows[0], memberBody()));
  }));

  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:event:write'));
  admin.get('/', validateQuery(adminEventListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { status, visibility, keyword } = req.query as AdminEventListQuery;
    const conds: string[] = ['deleted_at IS NULL'];
    const params: string[] = [];
    if (status) { conds.push('status = ?'); params.push(status); }
    if (visibility) { conds.push('visibility = ?'); params.push(visibility); }
    if (keyword) { conds.push('(title LIKE ? OR venue LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const [rows] = await pool.execute<EventRow[]>(
      `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM events ${where}`, params);
    sendOk(res, paginatedOf(await Promise.all(rows.map((r) => withRelations(r, true))), Number(counts[0]?.total ?? 0), page, pageSize));
  }));
  admin.post('/', validateBody(eventCreateSchema), asyncHandler(async (req, res) => {
    const id = await createEvent(req.body as EventCreatePayload);
    // 新建一律落草稿：前台不可见、不可报名，确认排期后在列表点「发布」
    await auditOf(res)?.({ action: 'EVENT_STATUS_CHANGE', targetType: 'event', targetId: id, after: { status: 'DRAFT' } });
    sendOk(res, await withRelations(await loadEvent(id), true), 201);
  }));
  admin.post('/:id/publish', asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    if (row.status !== 'DRAFT') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '只有草稿场次可以发布');
    }
    assertTransition(EVENT_TRANSITIONS, 'DRAFT', 'REGISTRATION_OPEN');
    // 发布即进入「报名中」：是否真的能报仍由报名开始/截止时间与时段状态把关
    await pool.execute(
      "UPDATE events SET status = 'REGISTRATION_OPEN', updated_at = ? WHERE id = ? AND status = 'DRAFT'",
      [toSqlDateTime(), row.id],
    );
    await auditOf(res)?.({
      action: 'EVENT_STATUS_CHANGE', targetType: 'event', targetId: String(row.id),
      before: { status: 'DRAFT' }, after: { status: 'REGISTRATION_OPEN' },
    });
    sendOk(res, await withRelations(await loadEvent(String(row.id)), true));
  }));
  admin.patch('/:id', validateBody(eventPatchSchema), asyncHandler(async (req, res) => {
    const id = await patchEvent(req.params.id, req.body as EventPatchPayload);
    sendOk(res, await withRelations(await loadEvent(id), true));
  }));
  /**
   * 取消场次：已确认/已签到/退款待审的报名按「主办方取消」全额退款。
   * 会员解冻报名时冻结的余额，非会员为线下退款（只记账单与状态）。
   * 加锁顺序：events → registrations → refund_orders → balance_accounts。
   */
  admin.post('/:id/cancel', asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    assertTransition(EVENT_TRANSITIONS, row.status as EventDto['status'], 'CANCELLED');
    const actorId = getIdentity()?.userId ?? null;
    const now = toSqlDateTime();
    await withTransaction(async (conn) => {
      const [locked] = await conn.execute<EventRow[]>('SELECT * FROM events WHERE id = ? FOR UPDATE', [row.id]);
      const current = locked[0];
      if (!current) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
      assertTransition(EVENT_TRANSITIONS, current.status as EventDto['status'], 'CANCELLED');

      await conn.execute("UPDATE events SET status = 'CANCELLED', updated_at = ? WHERE id = ?", [now, current.id]);
      // 候补下线后不会再有新的 WAITLISTED/OFFERED 行；这里仍清一次历史存量，
      // 让它们在统计与列表里落到终态，而不是长期悬在「候补中」。
      await conn.execute(
        "UPDATE registrations SET status = 'EXPIRED' WHERE event_id = ? AND status IN ('WAITLISTED','OFFERED')",
        [current.id],
      );
      const [regs] = await conn.execute<RowDataPacket[]>(
        `SELECT * FROM registrations
          WHERE event_id = ? AND status IN ('CONFIRMED','CHECKED_IN','REFUND_PENDING')
          FOR UPDATE`,
        [current.id],
      );
      for (const reg of regs) {
        const regId = String(reg.id);
        const fee = Number(reg.fee_cent ?? 0);
        // 已有待审退款单则复用（避免同一笔退款留两条记录），否则补一条已完成的退款单
        const [active] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM refund_orders
            WHERE registration_id = ? AND status IN ('REQUESTED','APPROVED','REFUNDING')
            FOR UPDATE`,
          [regId],
        );
        let refundId: string;
        if (active[0]) {
          refundId = String(active[0].id);
          await conn.execute(
            `UPDATE refund_orders
                SET amount_cent = ?, status = 'REFUNDED', reviewed_by = ?, reviewed_at = ?,
                    review_remark = ?, updated_at = ?
              WHERE id = ?`,
            [fee, actorId, now, '场次取消，全额退款', now, refundId],
          );
        } else {
          const [inserted] = await conn.execute<ResultSetHeader>(
            `INSERT INTO refund_orders
               (registration_id, amount_cent, reason, status, requested_by, reviewed_by, reviewed_at,
                review_remark, created_at, updated_at)
             VALUES (?, ?, '场次取消', 'REFUNDED', ?, ?, ?, '场次取消，全额退款', ?, ?)`,
            [regId, fee, reg.user_id, actorId, now, now, now],
          );
          refundId = String(inserted.insertId);
        }
        if (reg.payment_status === 'NOT_REQUIRED' && fee > 0) {
          const ledger = await applyLedgerEntry(conn, {
            userId: String(reg.user_id), op: 'UNFREEZE', amountCent: fee,
            bizType: 'REFUND', bizId: refundId, operatorId: actorId, remark: '场次取消全额退款',
          });
          // 会员回充：账本落定即资金到账，settled_* 同步写入（与非会员线下退款区分开）
          await conn.execute(
            'UPDATE refund_orders SET balance_txn_id = ?, settled_by = ?, settled_at = ? WHERE id = ?',
            [ledger.txnId, actorId, now, refundId],
          );
        }
        // REFUND_PENDING 在用户申请时已释放过名额，这里只回收仍占位的已确认报名
        if ((reg.status === 'CONFIRMED' || reg.status === 'CHECKED_IN') && reg.session_id) {
          await conn.execute(
            'UPDATE event_sessions SET capacity_used = capacity_used - 1 WHERE id = ? AND capacity_used > 0',
            [reg.session_id],
          );
        }
        await conn.execute(
          "UPDATE registrations SET status = 'REFUNDED', payment_status = 'REFUNDED', cancel_reason = COALESCE(cancel_reason, '场次取消') WHERE id = ?",
          [regId],
        );
        // 场次取消等同退款完成，券一并退回（未过期可再用）
        await releaseCouponOf(conn, regId);
      }
    });
    await auditOf(res)?.({
      action: 'EVENT_STATUS_CHANGE', targetType: 'event', targetId: String(row.id),
      before: { status: row.status }, after: { status: 'CANCELLED' },
    });
    sendOk(res, { id: String(row.id) });
  }));

  /**
   * 恢复已取消的场次。
   * 报名截止前恢复为「报名中」（窗口未开始时仍由时间校验挡住），截止后恢复为「已发布」。
   * 取消时被置为 EXPIRED 的历史候补不会自动恢复——那批名额已经释放，需要用户重新报名。
   */
  admin.post('/:id/restore', asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    if (row.status !== 'CANCELLED') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '只有已取消的场次可以恢复');
    }
    const parse = (v: unknown): number => new Date(`${String(v).replace(' ', 'T')}Z`).getTime();
    const now = Date.now();
    const target: EventDto['status'] = now < parse(row.registration_close_at) ? 'REGISTRATION_OPEN' : 'PUBLISHED';
    assertTransition(EVENT_TRANSITIONS, 'CANCELLED', target);

    await pool.execute('UPDATE events SET status = ?, updated_at = ? WHERE id = ?', [target, toSqlDateTime(), row.id]);
    await auditOf(res)?.({
      action: 'EVENT_STATUS_CHANGE', targetType: 'event', targetId: String(row.id),
      before: { status: 'CANCELLED' }, after: { status: target },
    });
    sendOk(res, { id: String(row.id), status: target });
  }));

  const adminModels = Router();
  adminModels.use(authenticate, requireCapabilities('admin:model:write'));

  /** 社媒账号统一存 JSON；空数组存 NULL，便于「未填写」与「填了但空」区分 */
  const socialJson = (list: ModelProfileUpsertPayload['socialAccounts'] | undefined): string | null => {
    const cleaned = (list ?? []).filter((s) => s.handle.trim());
    return cleaned.length ? JSON.stringify(cleaned) : null;
  };

  /** 模特列表（后台）：不按可见性过滤，运营要能看到全部建档模特；带出绑定微信号，前端无需再拉用户列表 */
  adminModels.get('/', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT mp.*, u.wechat_id AS bound_wechat_id
         FROM model_profiles mp
         LEFT JOIN users u ON u.id = mp.user_id AND u.deleted_at IS NULL
        WHERE mp.deleted_at IS NULL
        ORDER BY mp.id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM model_profiles WHERE deleted_at IS NULL',
    );
    sendOk(res, paginatedOf(rows.map((r) => modelDtoOf(r, true)), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  adminModels.post('/', validateBody(modelProfileUpsertSchema), asyncHandler(async (req, res) => {
    const b = req.body as ModelProfileUpsertPayload;
    const now = toSqlDateTime();
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO model_profiles
         (user_id, stage_name, height_cm, measurements_json, portfolio_url, photo_urls, social_accounts, portrait_auth_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.userId || null, b.stageName, b.heightCm ?? null,
        b.measurements ? JSON.stringify(b.measurements) : null,
        b.portfolioUrl ?? null,
        JSON.stringify(b.photoUrls ?? []), socialJson(b.socialAccounts),
        b.portraitAuthStatus ?? 'GRANTED', now, now],
    );
    const newId = String(result.insertId);
    await auditOf(res)?.({ action: 'MODEL_PROFILE_UPSERT', targetType: 'model', targetId: newId });
    sendOk(res, { id: newId }, 201);
  }));

  adminModels.patch('/:id', validateBody(modelProfileUpsertSchema.partial()), asyncHandler(async (req, res) => {
    const b = req.body as Partial<ModelProfileUpsertPayload>;
    await pool.execute(
      `UPDATE model_profiles SET
         stage_name = COALESCE(?, stage_name),
         height_cm = COALESCE(?, height_cm),
         measurements_json = COALESCE(?, measurements_json),
         portfolio_url = COALESCE(?, portfolio_url),
         photo_urls = COALESCE(?, photo_urls),
         social_accounts = COALESCE(?, social_accounts),
         portrait_auth_status = COALESCE(?, portrait_auth_status),
         user_id = COALESCE(?, user_id),
         updated_at = ?
       WHERE id = ?`,
      [b.stageName ?? null, b.heightCm ?? null,
        b.measurements ? JSON.stringify(b.measurements) : null,
        b.portfolioUrl ?? null,
        b.photoUrls ? JSON.stringify(b.photoUrls) : null,
        b.socialAccounts ? socialJson(b.socialAccounts) : null,
        b.portraitAuthStatus ?? null,
        // 只支持「改绑到另一个用户」；不传保持原绑定，不再被空值误清
        b.userId ?? null,
        toSqlDateTime(), req.params.id],
    );
    await auditOf(res)?.({ action: 'MODEL_PROFILE_UPSERT', targetType: 'model', targetId: req.params.id });
    sendOk(res, { id: req.params.id });
  }));

  app.use(`${API_BASE_PATH}/events`, pub);
  app.use(`${API_BASE_PATH}/models`, models);
  app.use(`${API_BASE_PATH}/admin/events`, admin);
  app.use(`${API_BASE_PATH}/admin/models`, adminModels);
}
