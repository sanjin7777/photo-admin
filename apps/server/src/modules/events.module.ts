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
  normalizeModelIds,
  pageQuerySchema,
  publicEventListQuerySchema,
  satisfiesLevel,
  satisfiesVisibility,
  type AdminEventListQuery,
  type EventCreatePayload,
  type EventDto,
  type EventParticipantsDto,
  type EventPatchPayload,
  type ModelProfileUpsertPayload,
  type ModelProfileDto,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate, optionalAuthenticate } from '../middleware/auth';
import { requireCapabilities, visibilityFilter } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { rawBodyOf, validateBody, validateQuery } from '../middleware/validate';
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
/**
 * 一次性取某个场次的全部模特。
 *
 * 以 event_models 为权威；关联表为空时（旧数据 / 迁移未回填）回退到 events.model_id，
 * 保证任何历史场次都至少能显示主模特，不会因为漏回填而「模特消失」。
 */
async function loadEventModels(eventId: string, fallbackModelId: string | null): Promise<RowDataPacket[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT mp.*, em.wardrobe_urls AS em_wardrobe_urls, em.photo_urls AS em_photo_urls,
            em.sort_no AS em_sort_no
       FROM event_models em
       JOIN model_profiles mp ON mp.id = em.model_id AND mp.deleted_at IS NULL
      WHERE em.event_id = ?
      ORDER BY em.sort_no ASC, em.model_id ASC`,
    [eventId],
  );
  if (rows.length) return rows;
  if (!fallbackModelId) return [];
  const [one] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM model_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [fallbackModelId],
  );
  return one;
}

/** 把库里的 wardrobe_urls（JSON 列）解析成字符串数组；任何异常都当空处理 */
function parseUrlArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 把模特行映射成「模特档案 + 本场次照片 + 本场次服装」。
 *
 * 回退顺序：
 *   照片：该模特自己的 → 整场 posterUrls（首张）→ 模特档案首张图
 *   服装：该模特自己的 → 整场 wardrobeUrls
 *
 * 这样单模特老数据、以及后台只填了一组图的场次，表现与升级前一致。
 */
function modelSlotsOf(
  modelRows: RowDataPacket[],
  eventPhotos: string[],
  eventWardrobes: string[],
): Array<{ model: ModelProfileDto; photoUrls: string[]; wardrobeUrls: string[] }> {
  return modelRows.map((r) => {
    const ownPhoto = parseUrlArray(r.em_photo_urls);
    const profilePhoto = parseUrlArray(r.photo_urls);
    const photo = ownPhoto.length
      ? ownPhoto
      : eventPhotos.length
        ? eventPhotos.slice(0, 1)
        : profilePhoto.slice(0, 1);
    const own = parseUrlArray(r.em_wardrobe_urls);
    return {
      model: modelDtoOf(r, false),
      photoUrls: photo,
      wardrobeUrls: own.length ? own : eventWardrobes,
    };
  });
}

/**
 * 批量版：后台/前台列表页一次查多场，避免 N+1。
 * 返回 Map<eventId, ModelProfileDto[]>。
 */
async function loadModelsForEvents(
  eventIds: string[],
  includeBody: boolean,
  fallback: Map<string, string | null>,
): Promise<Map<string, ModelProfileDto[]>> {
  const out = new Map<string, ModelProfileDto[]>();
  if (!eventIds.length) return out;
  const placeholders = eventIds.map(() => '?').join(',');
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT em.event_id, mp.*
       FROM event_models em
       JOIN model_profiles mp ON mp.id = em.model_id AND mp.deleted_at IS NULL
      WHERE em.event_id IN (${placeholders})
      ORDER BY em.event_id ASC, em.sort_no ASC, em.model_id ASC`,
    eventIds,
  );
  for (const r of rows) {
    const key = String(r.event_id);
    const list = out.get(key) ?? [];
    list.push(modelDtoOf(r, includeBody));
    out.set(key, list);
  }
  // 关联表缺行的场次回退主模特，逻辑与 loadEventModels 一致
  const missing = eventIds.filter((eid) => !out.has(eid) && fallback.get(eid));
  if (missing.length) {
    const missPlaceholders = missing.map(() => '?').join(',');
    const [fbRows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM model_profiles WHERE deleted_at IS NULL AND id IN (${missPlaceholders})`,
      missing.map((eid) => String(fallback.get(eid))),
    );
    const byId = new Map(fbRows.map((r) => [String(r.id), r]));
    for (const eid of missing) {
      const row = byId.get(String(fallback.get(eid)));
      if (row) out.set(eid, [modelDtoOf(row, includeBody)]);
    }
  }
  return out;
}

async function withRelations(row: EventRow, includeBody = false): Promise<EventDto> {
  const [modelRows, sessions, prices] = await Promise.all([
    loadEventModels(String(row.id), row.model_id == null ? null : String(row.model_id)),
    loadSessions(String(row.id)),
    loadPrices(String(row.id)),
  ]);
  /**
   * includeBody 控制模特档案里是否带三围等敏感字段。
   * 这里按它重新映射一次档案，服装仍用 modelSlotsOf 算好的结果。
   */
  const eventWardrobes = parseUrlArray(row.wardrobe_urls);
  const eventPhotos = parseUrlArray(row.poster_urls);
  const slots = modelSlotsOf(modelRows, eventPhotos, eventWardrobes);
  const models = modelRows.map((m) => modelDtoOf(m, includeBody));
  return eventDtoOf(
    row,
    models[0] ?? null,
    sessions.map(sessionDtoOf),
    prices.map(priceDtoOf),
    models,
    slots.map((s) => ({
      modelId: s.model.id,
      photoUrls: s.photoUrls,
      wardrobeUrls: s.wardrobeUrls,
    })),
  );
}

/**
 * 代拍时段的默认参数。
 *
 * 代拍独立于任何常规时段，但仍需要一个「可报名的实体」来承载容量、积分与票根，
 * 因此复用一个 kind='PROXY' 的 event_sessions 行：
 *   - 时间取整场的起止（start_at/end_at 非空约束），不参与常规时段排序；
 *   - 容量按常规时段总容量给，避免代拍名额被常规时段挤占或反之；
 *   - sort_no 固定 999，让它永远排在常规时段之后。
 */
const PROXY_LABEL = '代拍';
const PROXY_SORT = 999;

function proxySessionOf(
  sessions: EventCreatePayload['sessions'],
  startAt: string,
  endAt: string,
): { label: string; startAt: string; endAt: string; capacity: number } {
  const total = sessions.reduce((s, x) => s + Number(x.capacity), 0);
  return {
    label: PROXY_LABEL,
    startAt,
    endAt,
    capacity: Math.max(1, total || 1),
  };
}

async function replaceRelations(
  conn: PoolConnection,
  eventId: string,
  sessions: EventCreatePayload['sessions'],
  prices: EventCreatePayload['prices'],
  now: string,
  allowProxyShoot: boolean,
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
  // 支持代拍的场次自动挂一个代拍项：价格与正常报名一致，所以不单独建价格档
  if (allowProxyShoot) {
    const ordered = [...sessions].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first && last) {
      const proxy = proxySessionOf(sessions, sqlTime(first.startAt), sqlTime(last.endAt));
      await conn.execute(
        `INSERT INTO event_sessions
          (event_id, kind, label, start_at, end_at, capacity, sort_no, created_at, updated_at)
         VALUES (?, 'PROXY', ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, proxy.label, proxy.startAt, proxy.endAt, proxy.capacity, PROXY_SORT, now, now],
      );
    }
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
  allowProxyShoot: boolean,
  /**
   * 两个列表各自独立提交。
   *
   * 以前这个函数被强制要求「时段和价格必须一起传」，因为价格是整体替换的：
   * 只传时段时 prices 缺失，会把 event_prices 删空。
   * 现在分开处理 —— 只传时段就完全不动价格表，只传价格就完全不动时段表，
   * 这样「只想改金额」「只想改时间段」都不会被无故拦截。
   */
  opts: { syncSessions?: boolean; syncPrices?: boolean } = {},
): Promise<void> {
  const syncSessions = opts.syncSessions ?? true;
  const syncPrices = opts.syncPrices ?? true;
  /**
   * 代拍行由服务端维护，前端不会提交它。
   * 若直接参与下面的「未提交即删除」逻辑，每次编辑场次都会把代拍连同其报名一起删掉，
   * 所以这里先把它从 existing 里摘出来单独处理。
   */
  const proxyRows = existing.filter((s) => String((s as { kind?: string }).kind ?? 'NORMAL') === 'PROXY');
  const normalExisting = existing.filter((s) => String((s as { kind?: string }).kind ?? 'NORMAL') !== 'PROXY');

  const byId = new Map(normalExisting.map((s) => [String(s.id), s]));
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

  /* ---------------- 代拍行：按开关增删，不动常规时段 ---------------- */
  const proxyLive = proxyRows.length ? (liveBySession.get(String(proxyRows[0]!.id)) ?? 0) : 0;
  if (!allowProxyShoot && proxyRows.length) {
    if (proxyLive > 0) {
      throw new AppError(
        BIZ_CODES.ILLEGAL_TRANSITION,
        `已有 ${proxyLive} 条代拍报名，不能关闭本场的代拍`,
      );
    }
    await conn.execute('DELETE FROM event_sessions WHERE event_id = ? AND kind = ?', [eventId, 'PROXY']);
  }
  // 只改价格时不碰代拍行：时段列表没提交，代拍范围无从推导
  if (syncSessions && allowProxyShoot && !proxyRows.length) {
    const ordered = [...sessions].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first && last) {
      const proxy = proxySessionOf(sessions, sqlTime(first.startAt), sqlTime(last.endAt));
      await conn.execute(
        `INSERT INTO event_sessions
          (event_id, kind, label, start_at, end_at, capacity, sort_no, created_at, updated_at)
         VALUES (?, 'PROXY', ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, proxy.label, proxy.startAt, proxy.endAt, proxy.capacity, PROXY_SORT, now, now],
      );
    }
  } else if (syncSessions && allowProxyShoot && proxyRows.length) {
    // 常规时段调整后，代拍的时间范围与容量要跟着走；容量不得低于已报名数
    const ordered = [...sessions].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first && last) {
      const total = sessions.reduce((s, x) => s + Number(x.capacity), 0);
      const capacity = Math.max(proxyLive, Math.max(1, total || 1));
      await conn.execute(
        `UPDATE event_sessions SET start_at = ?, end_at = ?, capacity = ?, updated_at = ?
          WHERE id = ? AND event_id = ?`,
        [sqlTime(first.startAt), sqlTime(last.endAt), capacity, now, String(proxyRows[0]!.id), eventId],
      );
    }
  }

  /**
   * 只改价格时，完全不动时段表：
   * 不做「未提交即删除」、不更新容量，也不会因为 sessions 是空数组而把时段删光。
   */
  if (syncSessions) {
    const removed = normalExisting.filter((s) => !kept.has(String(s.id)));
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
  }

  /**
   * 价格不参与报名历史，整体替换即可；报名时已把当时的退款规则快照写入 registrations。
   * 只在本次确实提交了价格时才替换 —— 否则只改时段会把价格删空。
   */
  if (syncPrices) {
    await conn.execute('DELETE FROM event_prices WHERE event_id = ?', [eventId]);
    for (const p of prices) {
      await conn.execute(
        'INSERT INTO event_prices (event_id, level, price_cent, unit_label) VALUES (?, ?, ?, ?)',
        [eventId, p.level, p.priceCent, p.unitLabel],
      );
    }
  }
}

/**
 * 同步场次的模特列表（多对多）。
 *
 * 语义：`modelIds` 是**权威全量**，传入什么就是什么（含主模特）。
 * `events.model_id` 同步写成列表首项，作为向后兼容的冗余字段——
 * 投票关联、海报主图、模特照片库仍按「单人」读取，靠它定位主模特。
 *
 * `wardrobes` 与 `modelIds` 按下标对应，存每位模特在本场次的当日服装图。
 * 对应位置缺省时写 JSON null，读取端会回退到 events.wardrobe_urls。
 */
async function replaceEventModels(
  conn: PoolConnection,
  eventId: string,
  modelIds: string[],
  now: string,
  wardrobes: Array<string[] | undefined> | undefined = undefined,
  photos: Array<string[] | undefined> | undefined = undefined,
): Promise<void> {
  await conn.execute('DELETE FROM event_models WHERE event_id = ?', [eventId]);
  for (const [i, modelId] of modelIds.entries()) {
    const own = wardrobes?.[i];
    // 空数组与「没传」等价：都存 NULL，靠读取端统一回退
    const wardrobeJson = own && own.length ? JSON.stringify(own) : null;
    const ownPhoto = photos?.[i];
    const photoJson = ownPhoto && ownPhoto.length ? JSON.stringify(ownPhoto) : null;
    await conn.execute(
      `INSERT IGNORE INTO event_models
         (event_id, model_id, sort_no, wardrobe_urls, photo_urls, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, modelId, i, wardrobeJson, photoJson, now],
    );
  }
  // 冗余列跟随首项：没有模特时置空
  await conn.execute(
    'UPDATE events SET model_id = ? WHERE id = ?',
    [modelIds[0] ?? null, eventId],
  );
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
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'DRAFT',?,?)`,
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
    await replaceRelations(conn, eventId, p.sessions, p.prices, now, p.allowProxyShoot);
    await replaceEventModels(
      conn, eventId, normalizeModelIds(p), now, p.modelWardrobes, p.modelPhotos,
    );
    return eventId;
  });
}

async function patchEvent(
  id: string,
  patch: EventPatchPayload,
  /** 原始请求体：用于区分「字段缺省」与「显式传 false」（Zod 的 default 会抹平这个差异） */
  rawBody: Record<string, unknown> = {},
): Promise<string> {
  const row = await loadEvent(id);

  // 派生字段只读：容量/总价/起止时间由时段与分档价推导，避免与真实排期脱节
  for (const key of ['capacity', 'feeCent', 'startAt', 'endAt'] as const) {
    if (patch[key] !== undefined) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, `${key} 由时段与价格自动推导，请修改时段或分档价`);
    }
  }
  /**
   * 时段与价格**可以分开提交**：只改金额、只改时间段都是合法操作。
   * 这里只拦「两个都没带却想动排期」的情况（那种请求本身没有意义）。
   */
  if (patch.sessions !== undefined && patch.prices === undefined
    && Object.prototype.hasOwnProperty.call(rawBody, 'prices')) {
    throw new AppError(BIZ_CODES.INVALID_PARAM, 'prices 传了空值，请给出完整的分档价格');
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
    // modelId 不在这里写：它由 replaceEventModels 跟随 modelIds 同步，
    // 单独写会和关联表产生不一致（列表里有 A,B 但主模特被改成 C）
    sceneId: 'scene_id', registrationOpenAt: 'registration_open_at',
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

  /** 本次是否提交了时段列表（决定代拍行的补齐逻辑走哪个分支） */
  const wantsRelations = Array.isArray(patch.sessions);
  await withTransaction(async (conn) => {
    // 锁住本场次全部时段：与报名时对单个时段加的 FOR UPDATE 串行，避免「刚删完又有人报进被删时段」
    const [lockedRows] = await conn.execute<SessionRow[]>(
      'SELECT * FROM event_sessions WHERE event_id = ? ORDER BY sort_no ASC, id ASC FOR UPDATE', [id],
    );

    /**
     * 单独关闭代拍（patch 只带 allowProxyShoot、不带 sessions）也必须拦住：
     * 否则 events.allow_proxy_shoot 变成 0，但代拍时段行与已有报名还留在库里，
     * 数据自相矛盾——前台看不到入口，后台却显示有人报了「代拍」。
     *
     * 注意：`eventPatchSchema` 由 `eventCreateBaseSchema.partial()` 得来，
     * 而 allowProxyShoot 在原 schema 上带 `.default(false)`，partial 后**缺省时仍会注入 false**。
     * 因此这里不能只判 `=== false`，还要确认请求体里真的带了这个字段。
     */
    const explicitProxyOff = patch.allowProxyShoot === false
      && Object.prototype.hasOwnProperty.call(rawBody, 'allowProxyShoot');
    if (explicitProxyOff) {
      const proxyIds = lockedRows
        .filter((s) => String((s as { kind?: string }).kind ?? 'NORMAL') === 'PROXY')
        .map((s) => String(s.id));
      if (proxyIds.length) {
        const [liveRows] = await conn.execute<RowDataPacket[]>(
          `SELECT COUNT(*) AS cnt FROM registrations
            WHERE event_id = ? AND session_id IN (${proxyIds.map(() => '?').join(',')})
              AND status IN ${LIVE_REG_STATUSES}`,
          [id, ...proxyIds],
        );
        const live = Number(liveRows[0]?.cnt ?? 0);
        if (live > 0) {
          throw new AppError(
            BIZ_CODES.ILLEGAL_TRANSITION,
            `已有 ${live} 条代拍报名，不能关闭本场的代拍`,
          );
        }
        // 没有报名就顺手清掉残留的代拍行，避免出现「开关已关但行还在」
        await conn.execute(
          `DELETE FROM event_sessions WHERE event_id = ? AND id IN (${proxyIds.map(() => '?').join(',')})`,
          [id, ...proxyIds],
        );
      }
    }

    if (sets.length) {
      await conn.execute(`UPDATE events SET ${sets.join(', ')}, version = version + 1 WHERE id = ?`, [...values, id]);
    }

    /**
     * 只切开关、不带 sessions 的编辑也要把代拍行补齐/清掉。
     *
     * 后台「编辑场次」表单在没改时段时，sessions 的 diff 为空，patch 里就只有 allowProxyShoot。
     * 若只在下面「配了 sessions」的分支里处理代拍，勾选后开关变成 1 但代拍项从未生成，
     * 表现就是：后台显示已勾选，前台和手动录入都没有代拍入口。
     */
    const hasProxyFlag = Object.prototype.hasOwnProperty.call(rawBody, 'allowProxyShoot');
    if (hasProxyFlag && !wantsRelations) {
      const proxyIds = lockedRows
        .filter((s) => String((s as { kind?: string }).kind ?? 'NORMAL') === 'PROXY')
        .map((s) => String(s.id));
      const now = toSqlDateTime();
      if (patch.allowProxyShoot === true && !proxyIds.length) {
        // 用库中现有的常规时段推导代拍的时间范围与容量
        const normals = lockedRows.filter(
          (s) => String((s as { kind?: string }).kind ?? 'NORMAL') !== 'PROXY',
        );
        if (normals.length) {
          const starts = normals.map((s) => String(s.start_at)).sort();
          const ends = normals.map((s) => String(s.end_at)).sort();
          const total = normals.reduce((s, x) => s + Number(x.capacity), 0);
          await conn.execute(
            `INSERT INTO event_sessions
              (event_id, kind, label, start_at, end_at, capacity, sort_no, created_at, updated_at)
             VALUES (?, 'PROXY', ?, ?, ?, ?, ?, ?, ?)`,
            [id, PROXY_LABEL, starts[0], ends[ends.length - 1], Math.max(1, total), PROXY_SORT, now, now],
          );
        }
      }
    }

    /**
     * 模特列表同步。
     *
     * 只有本次 patch 确实带了相关字段才动关联表，避免「只改标题」把模特清空。
     * 判据用原始请求体：`modelIds` 在 schema 上是 optional，缺省即 undefined，
     * 但为了和 allowProxyShoot 的 `.default()` 行为保持一致，仍以 rawBody 为准。
     *
     * `modelWardrobes` / `modelPhotos` 也单独判：后台可能只改某位模特的服装或照片
     * 而不动模特列表，这时也必须落库，否则用户改完保存后毫无变化。
     */
    const hasModelIdsField = Object.prototype.hasOwnProperty.call(rawBody, 'modelIds')
      || Object.prototype.hasOwnProperty.call(rawBody, 'modelId');
    const hasWardrobeField = Object.prototype.hasOwnProperty.call(rawBody, 'modelWardrobes');
    const hasPhotoField = Object.prototype.hasOwnProperty.call(rawBody, 'modelPhotos');
    if (hasModelIdsField || hasWardrobeField || hasPhotoField) {
      const [currentRows] = await conn.execute<RowDataPacket[]>(
        'SELECT model_id, sort_no, wardrobe_urls, photo_urls FROM event_models WHERE event_id = ? ORDER BY sort_no',
        [id],
      );
      const currentIds = currentRows.map((r) => String(r.model_id));
      const prevWardrobe = new Map(currentRows.map((r) => [String(r.model_id), parseUrlArray(r.wardrobe_urls)]));
      const prevPhoto = new Map(currentRows.map((r) => [String(r.model_id), parseUrlArray(r.photo_urls)]));

      const nextModels = hasModelIdsField
        ? normalizeModelIds({
            modelId: (patch as { modelId?: string | null }).modelId,
            modelIds: (patch as { modelIds?: string[] }).modelIds,
          })
        : currentIds;

      // 仅传 modelId 且与现列表首项不同 → 视为「替换主模特，保留其余」；
      // 其余情况按全量替换处理。
      const onlyModelId = !Object.prototype.hasOwnProperty.call(rawBody, 'modelIds');
      const merged = (hasModelIdsField && onlyModelId)
        ? (nextModels.length
            ? [nextModels[0]!, ...currentIds.filter((m) => m !== nextModels[0])]
            : [])
        : nextModels;

      /**
       * 按模特 id 对应，而不是按数组下标：
       * 前端删掉第一位模特后下标整体左移，按下标取会把 A 的衣服套到 B 身上。
       * 提交仍是「与 modelIds 同序的平行数组」（后端契约简单），
       * 这里先转成 Map 再按 id 取，避免顺序变化造成串图。
       */
      const requestIds = hasModelIdsField
        ? normalizeModelIds({
            modelId: (patch as { modelId?: string | null }).modelId,
            modelIds: (patch as { modelIds?: string[] }).modelIds,
          })
        : currentIds;

      const buildMap = (
        submitted: string[][] | undefined,
      ): Map<string, string[]> => {
        const out = new Map<string, string[]>();
        if (!submitted) return out;
        requestIds.forEach((mid, i) => {
          const v = submitted[i];
          if (v !== undefined) out.set(mid, v);
        });
        return out;
      };

      const wardrobeMap = buildMap((patch as { modelWardrobes?: string[][] }).modelWardrobes);
      const photoMap = buildMap((patch as { modelPhotos?: string[][] }).modelPhotos);

      const wardrobes = merged.map((mid) =>
        // 本次提交了就用提交值；否则保持库里原值
        (hasWardrobeField && wardrobeMap.has(mid) ? wardrobeMap.get(mid) : prevWardrobe.get(mid)),
      );
      const photos = merged.map((mid) =>
        (hasPhotoField && photoMap.has(mid) ? photoMap.get(mid) : prevPhoto.get(mid)),
      );

      await replaceEventModels(conn, id, merged, toSqlDateTime(), wardrobes, photos);
    }

  /**
   * 时段与价格分开提交也允许：
   * · 只带 sessions → 只同步时段（价格表完全不动）
   * · 只带 prices   → 只同步价格（时段表完全不动）
   * · 都带          → 两者一起同步
   *
   * 早期这里要求两者必须同时出现，是为了防止「只传时段把价格删空」；
   * 现在 syncRelations 用 syncSessions / syncPrices 分开控制表操作，那个前提已经不成立，
   * 于是不再需要这个限制 —— 运营只想改个金额时不该被拦住。
   */
  const wantsSessions = Array.isArray(patch.sessions);
  const wantsPrices = Array.isArray(patch.prices);
  if (wantsSessions || wantsPrices) {
    const now = toSqlDateTime();
    /**
     * 代拍开关可能没在本次 patch 里传（只改了时段）。
     * 必须与库中现值合并后再传给 syncRelations，否则「没传」会被当成「关掉代拍」。
     *
     * 判据用「原始请求体里有没有这个字段」，而不是 `patch.allowProxyShoot !== undefined`：
     * schema 上的 `.default(false)` 经 partial() 后仍会注入 false，导致缺省被误判为显式关闭。
     */
    const [flagRows] = await conn.execute<RowDataPacket[]>(
      'SELECT allow_proxy_shoot FROM events WHERE id = ?', [id],
    );
    const hasProxyField = Object.prototype.hasOwnProperty.call(rawBody, 'allowProxyShoot');
    const allowProxy = hasProxyField
      ? Boolean(patch.allowProxyShoot)
      : Boolean(flagRows[0]?.allow_proxy_shoot);

    await syncRelations(
      conn, id,
      // 没提交的那一侧传空数组，但对应 sync 开关为 false，函数内部不会碰那张表
      wantsSessions ? patch.sessions! : [],
      wantsPrices ? patch.prices! : [],
      lockedRows, now, allowProxy,
      { syncSessions: wantsSessions, syncPrices: wantsPrices },
    );

    // 派生字段要跟着变化的那一侧重算：只改价格时容量与起止时间保持不变
    const [aggRows] = await conn.execute<RowDataPacket[]>(
      `SELECT
         (SELECT MIN(start_at) FROM event_sessions WHERE event_id = ? AND kind <> 'PROXY') AS min_start,
         (SELECT MAX(end_at)   FROM event_sessions WHERE event_id = ? AND kind <> 'PROXY') AS max_end,
         (SELECT COALESCE(SUM(capacity),0) FROM event_sessions WHERE event_id = ? AND kind <> 'PROXY') AS total_capacity,
         (SELECT price_cent FROM event_prices WHERE event_id = ? AND level = 'PUBLIC' LIMIT 1) AS public_price,
         (SELECT fee_cent FROM events WHERE id = ?) AS fee_cent`,
      [id, id, id, id, id],
    );
    const agg = aggRows[0];
    const minStart = agg?.min_start ? String(agg.min_start) : null;
    const maxEnd = agg?.max_end ? String(agg.max_end) : null;
    const totalCapacity = Number(agg?.total_capacity ?? 0);
    /**
     * 公开价回退顺序：event_prices 的 PUBLIC 档 → events.fee_cent（既有的兼容列）。
     * 只改了 VIP/SVIP 价格时 PUBLIC 可能没变，仍取库里的值即可。
     */
    const publicPrice = agg?.public_price != null
      ? Number(agg.public_price)
      : Number(agg?.fee_cent ?? 0);

    if (minStart && maxEnd) {
      await conn.execute(
        'UPDATE events SET start_at = ?, end_at = ?, capacity = ?, fee_cent = ? WHERE id = ?',
        [minStart, maxEnd, totalCapacity, publicPrice, id],
      );
    }
  }
  });
  return id;
}

export function mountEvents(app: Express): void {
  const pub = Router();
  pub.use(optionalAuthenticate);

  pub.get('/', validateQuery(publicEventListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const scope = ((req.query as { scope?: string }).scope ?? 'upcoming') as 'upcoming' | 'past';
    const identity = getIdentity();

    /**
     * 历史活动只对已登录用户开放：
     * 游客请求 past 时不返回数据（而不是 403），前端据此保持「暂无历史活动」的
     * 中性空态，不暴露「这里有一块内容但你无权看」的存在性信息。
     */
    if (scope === 'past' && !identity) {
      sendOk(res, paginatedOf([], 0, page, pageSize));
      return;
    }

    const { clause, params } = visibilityFilter(currentLevel());

    // 「近期」= 尚未开始；「历史」= 已经开始。以场次开始时间为准，
    // 正在进行中的活动算历史，避免出现「即将开始」却已开演的错位。
    const now = toSqlDateTime();
    const timeClause = scope === 'past' ? 'start_at <= ?' : 'start_at > ?';
    // 历史按「最近结束优先」，近期按「最早开始优先」
    const orderBy = scope === 'past' ? 'start_at DESC' : 'start_at ASC';
    const where = `deleted_at IS NULL AND status <> 'DRAFT' AND ${clause} AND ${timeClause}`;
    const whereParams = [...params, now];

    const [rows] = await pool.execute<EventRow[]>(
      `SELECT * FROM events WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...whereParams, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM events WHERE ${where}`, whereParams,
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

    /**
     * 逐时段判定，而不是只挑「第一个 OPEN 时段」。
     *
     * 原实现取 `sessions.find(s => s.status === 'OPEN')`，第一个时段满员时
     * canRegister 直接为 false —— 导致「第1场已满、第2/3场还有位」时
     * 登记按钮整体禁用，用户无法报名任何一个时段。
     */
    const eventInput = {
      status: row.status, visibility: row.visibility,
      registerMinLevel: (row.register_min_level ?? 'NONE') as EventDto['registerMinLevel'],
      registrationOpenAt: isoTime(row.registration_open_at),
      registrationCloseAt: isoTime(row.registration_close_at),
    };
    const level = currentLevel();
    const feeCent = Number(row.fee_cent);
    const sessionChecks = sessions.map((s) => {
      const decision = decideRegistration({
        event: eventInput,
        session: {
          status: s.status, startAt: isoTime(s.start_at), endAt: isoTime(s.end_at),
          capacity: Number(s.capacity), capacityUsed: Number(s.capacity_used),
          kind: String((s as { kind?: string }).kind ?? 'NORMAL'),
        },
        level, priceCent: feeCent,
        hasBalance: hasBalance(), availableCent: available,
      });
      return {
        sessionId: String(s.id),
        canRegister: decision.ok,
        reasonCode: decision.reasonCode,
      };
    });

    // 只要还有任意一个时段可报，就允许进入登记流程（具体时段由前端选择）
    const canRegister = sessionChecks.some((c) => c.canRegister);
    // reasonCode 取「最相关」的：能报就是 null；都不能报则用第一个可判定时段的理由
    const reasonCode = canRegister
      ? null
      : (sessionChecks.find((c) => c.reasonCode != null)?.reasonCode ?? BIZ_CODES.EVENT_NOT_OPEN);
    // 余量只统计常规时段：代拍不限人数，把它的容量算进来会让「余 N 席」虚高
    const normalSessions = sessions.filter((s) => String((s as { kind?: string }).kind ?? 'NORMAL') !== 'PROXY');
    const totalCapacity = normalSessions.reduce((s, x) => s + Number(x.capacity), 0) || Number(row.capacity);
    const totalUsed = normalSessions.reduce((s, x) => s + Number(x.capacity_used), 0) || Number(row.capacity_used);
    /**
     * 该用户被回避名单拦下的时段。只回 id，不回「被谁排除」——
     * 前端把时段标成「暂不可选」，措辞中性，不制造会员之间的对立。
     */
    let restrictedSessionIds: string[] = [];
    if (identity) {
      const [avoidRows] = await pool.execute<RowDataPacket[]>(
        `SELECT a.session_id
           FROM session_avoid_rules a
           JOIN event_sessions s ON s.id = a.session_id
          WHERE s.event_id = ? AND a.blocked_user_id = ? AND a.revoked_at IS NULL`,
        [String(row.id), identity.userId],
      );
      restrictedSessionIds = avoidRows.map((r) => String(r.session_id));
    }
    sendOk(res, {
      eventId: String(row.id), capacity: totalCapacity, capacityUsed: totalUsed,
      remaining: Math.max(0, totalCapacity - totalUsed),
      canRegister,
      reasonCode,
      // 逐时段的可报状态：前端据此禁用「已满/已开始」的单个时段，而不是整体禁用按钮
      sessionChecks,
      // 「积分不足」时前端要能算出差额，所以把余额与实际应付价一并下发；
      // 普通用户没有积分账户，按 null 返回，前端据此显示「线下支付」而非「差多少分」。
      balanceCent: identity && hasBalance() ? available : null,
      priceCent: Number(row.fee_cent),
      restrictedSessionIds,
    });
  }));

  /**
   * SVIP 专属：看看「登记中的场次」都有谁登记了。
   *
   * 隐私边界（重要）：
   *   - 只返回昵称，**绝不返回 wechat_id / user_id**，避免被用来反查账号或私联；
   *   - 已取消 / 退款中的登记不出现，避免把「取消过的人」也挂在名单上；
   *   - 单时段最多返回 60 个昵称，超出用 moreCount 表示，防止满员场次把响应撑大。
   */
  pub.get('/:id/participants', authenticate, requireCapabilities('event:participants:view'), asyncHandler(async (req, res) => {
    const row = await loadEvent(req.params.id);
    // 草稿/已取消按不存在处理，与详情页口径一致
    if (row.status === 'DRAFT' || row.status === 'CANCELLED') throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (!satisfiesVisibility(currentLevel(), row.visibility)) throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT);

    const eventId = String(row.id);
    // 只对「登记中」（尚未开始）的场次开放；已开始/已结束不再展示名单
    if (fromSqlDateTime(row.start_at).getTime() <= Date.now()) {
      const empty: EventParticipantsDto = { eventId, available: false, sessions: [] };
      sendOk(res, empty);
      return;
    }

    const MAX_PER_SESSION = 60;
    const sessions = await loadSessions(eventId);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT r.session_id, u.nickname
         FROM registrations r
         JOIN users u ON u.id = r.user_id
        WHERE r.event_id = ?
          AND r.session_id IS NOT NULL
          AND r.status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETED')
        ORDER BY r.created_at ASC`,
      [eventId],
    );

    const bySession = new Map<string, string[]>();
    for (const r of rows) {
      const key = String(r.session_id);
      const nick = String(r.nickname ?? '').trim() || '会员';
      const list = bySession.get(key);
      if (list) list.push(nick); else bySession.set(key, [nick]);
    }

    const sessionsOut = sessions.map((s) => {
      const all = bySession.get(String(s.id)) ?? [];
      return {
        sessionId: String(s.id),
        label: String(s.label ?? ''),
        count: all.length,
        nicknames: all.slice(0, MAX_PER_SESSION),
        moreCount: Math.max(0, all.length - MAX_PER_SESSION),
      };
    });

    const dto: EventParticipantsDto = { eventId, available: true, sessions: sessionsOut };
    sendOk(res, dto);
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
    const id = await patchEvent(req.params.id, req.body as EventPatchPayload, rawBodyOf(req));
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
      `SELECT mp.*, u.wechat_id AS bound_wechat_id, u.nickname AS bound_nickname
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
    // 身高/三围属敏感个人信息：只有运营明确勾选「已取得本人单独同意」才留痕
    const consentAt = b.bodyDataConsent === true ? now : null;
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO model_profiles
         (user_id, stage_name, height_cm, measurements_json, portfolio_url, photo_urls, social_accounts,
          portrait_auth_status, body_data_consent_at, body_data_consent_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.userId || null, b.stageName, b.heightCm ?? null,
        b.measurements ? JSON.stringify(b.measurements) : null,
        b.portfolioUrl ?? null,
        JSON.stringify(b.photoUrls ?? []), socialJson(b.socialAccounts),
        b.portraitAuthStatus ?? 'GRANTED',
        consentAt, consentAt ? (b.bodyDataConsentNote ?? null) : null, now, now],
    );
    const newId = String(result.insertId);
    await auditOf(res)?.({ action: 'MODEL_PROFILE_UPSERT', targetType: 'model', targetId: newId });
    sendOk(res, { id: newId }, 201);
  }));

  adminModels.patch('/:id', validateBody(modelProfileUpsertSchema.partial()), asyncHandler(async (req, res) => {
    const b = req.body as Partial<ModelProfileUpsertPayload>;
    const stamp = toSqlDateTime();
    // 同意留痕只「授予」或「撤销」，不传则保持原值（COALESCE 无法表达「置空」，故分两步）
    const consentAt = b.bodyDataConsent === true ? stamp : null;
    await pool.execute(
      `UPDATE model_profiles SET
         stage_name = COALESCE(?, stage_name),
         height_cm = COALESCE(?, height_cm),
         measurements_json = COALESCE(?, measurements_json),
         portfolio_url = COALESCE(?, portfolio_url),
         photo_urls = COALESCE(?, photo_urls),
         social_accounts = COALESCE(?, social_accounts),
         portrait_auth_status = COALESCE(?, portrait_auth_status),
         body_data_consent_at = COALESCE(?, body_data_consent_at),
         body_data_consent_note = COALESCE(?, body_data_consent_note),
         user_id = COALESCE(?, user_id),
         updated_at = ?
       WHERE id = ?`,
      [b.stageName ?? null, b.heightCm ?? null,
        b.measurements ? JSON.stringify(b.measurements) : null,
        b.portfolioUrl ?? null,
        b.photoUrls ? JSON.stringify(b.photoUrls) : null,
        b.socialAccounts ? socialJson(b.socialAccounts) : null,
        b.portraitAuthStatus ?? null,
        consentAt,
        consentAt ? (b.bodyDataConsentNote ?? null) : null,
        // 只支持「改绑到另一个用户」；不传保持原绑定，不再被空值误清
        b.userId ?? null,
        stamp, req.params.id],
    );
    // 明确撤销同意：清空留痕（法规要求可撤回，撤回后不应继续保留「已同意」标记）
    if (b.bodyDataConsent === false) {
      await pool.execute(
        'UPDATE model_profiles SET body_data_consent_at = NULL, body_data_consent_note = NULL WHERE id = ?',
        [req.params.id],
      );
    }
    await auditOf(res)?.({ action: 'MODEL_PROFILE_UPSERT', targetType: 'model', targetId: req.params.id });
    sendOk(res, { id: req.params.id });
  }));

  app.use(`${API_BASE_PATH}/events`, pub);
  app.use(`${API_BASE_PATH}/models`, models);
  app.use(`${API_BASE_PATH}/admin/events`, admin);
  app.use(`${API_BASE_PATH}/admin/models`, adminModels);
}
