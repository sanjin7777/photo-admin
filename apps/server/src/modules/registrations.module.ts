/**
 * 报名 / 取消 / 收款确认（核心事务）。
 *
 * 容量以「时段」为准；金额按会员等级取价。
 * 会员（VIP/SVIP）：报名冻结余额，payment_status=NOT_REQUIRED，状态直接 CONFIRMED；
 * 非会员：不扣余额，payment_status=UNPAID，状态先落 PENDING_PAYMENT（待支付），
 *         由运营在后台确认收款后才转 CONFIRMED；收款前可直接取消（无资金可退）。
 * 固定加锁顺序：events → event_sessions → registrations → balance_accounts。
 *
 * 候补（WAITLISTED/OFFERED）已于 2026-11 整体下线：满员即拒绝，不做排队与递补。
 * 历史库里可能仍残留这两种状态的报名，代码保留其枚举与展示，但不再产生新的。
 */
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  IDEMPOTENCY_KEY_HEADER,
  REGISTRATION_TRANSITIONS,
  adminRegistrationActionSchema,
  adminRegistrationBatchSchema,
  adminRegistrationCreateSchema,
  adminRegistrationListQuerySchema,
  adminRegistrationLookupQuerySchema,
  adminUserOptionsQuerySchema,
  assertTransition,
  couponDiscountOf,
  pageQuerySchema,
  registrationCancelSchema,
  registrationCreateSchema,
  satisfiesVisibility,
  type AdminRegistrationActionPayload,
  type AdminRegistrationBatchPayload,
  type AdminRegistrationBatchResult,
  type AdminRegistrationCreatePayload,
  type AdminRegistrationListQuery,
  type AdminRegistrationLookupQuery,
  type AdminUserOptionsQueryInput,
  type MemberLevel,
  type RegistrationCancelPayload,
  type RegistrationCreatePayload,
  type ScheduleConflictDto,
  type RegistrationBatchDto,
  type RegistrationDto,
  type RegistrationStatus,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { effectiveLevel } from '../db/identity';
import { claimIdempotency, completeIdempotency, requestHash, scopedIdempotencyKey } from '../db/idempotency';
import { authenticate } from '../middleware/auth';
import { requireAnyCapability, requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import {
  eventDtoOf, pageArgsOf, paginatedOf, registrationDtoOf, sessionDtoOf,
  type EventRow, type RegistrationRow,
} from '../domain/dto';
import { applyLedgerEntry } from '../domain/ledger';
import { releaseCouponOf } from './coupons.module';
import { canCancel, decideRegistration, pickPrice, refundAmountOf } from '../domain/policy';
import { fromSqlDateTime, localDayRangeUtc, toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

const isoTime = (sql: string): string => fromSqlDateTime(sql).toISOString();
const isMember = (level: MemberLevel): boolean => level === 'VIP' || level === 'SVIP';

interface SessionRow extends RowDataPacket {
  id: string; event_id: string; label: string; start_at: string; end_at: string;
  capacity: number; capacity_used: number; status: string; sort_no: number;
}

/** 同一账号在同一场次的累计活跃名额上限，防止批量报名刷占名额 */
const MAX_SEATS_PER_EVENT = 20;

async function createRegistration(
  userId: string, level: MemberLevel, eventId: string, sessionId: string, idempotencyKey: string,
  ignoreConflict = false, seats = 1, couponIds: string[] = [],
): Promise<RegistrationBatchDto> {
  const scope = 'registration:create';
  // 幂等键按用户隔离，避免猜到他人 key 时回放他人响应
  const scopedKey = scopedIdempotencyKey(userId, idempotencyKey);
  // 券的提交顺序不影响金额，排序后再进 hash，避免「同一组券换顺序」被判成新请求
  const sortedCouponIds = [...couponIds].sort();
  // hash 覆盖 seats / ignoreConflict / couponIds：同键不同参必须报幂等冲突，而不是静默复用
  const hash = requestHash('POST', `${API_BASE_PATH}/registrations`, {
    eventId, sessionId, seats, ignoreConflict, couponIds: sortedCouponIds,
  });
  return withTransaction(async (conn) => {
    const claim = await claimIdempotency(conn, { key: scopedKey, scope, hash });
    if (claim.replay) {
      // 缓存里存的是业务数据（RegistrationBatchDto），不是完整响应包；
      // 路由层会再 sendOk 包一层，这里直接返回即可，避免双重包裹。
      return claim.replay.data as RegistrationBatchDto;
    }

    const [eventRows] = await conn.execute<EventRow[]>('SELECT * FROM events WHERE id = ? FOR UPDATE', [eventId]);
    const event = eventRows[0];
    if (!event) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (!satisfiesVisibility(level, event.visibility)) throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT);

    const [sessionRows] = await conn.execute<SessionRow[]>(
      'SELECT * FROM event_sessions WHERE id = ? AND event_id = ? FOR UPDATE', [sessionId, eventId],
    );
    const session = sessionRows[0];
    if (!session) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);

    /**
     * 同一时段的其它报名冲突检测。
     * 用户第一次提交时把冲突项回给前端做二次确认；确认后带 ignoreConflict=true 再来一次。
     * 只算仍然占位的状态：待支付/已确认/已签到；已取消、已退款、退款待审的不算。
     *
     * 代拍不参与时间冲突：代拍独立于常规时段，本来就是「不用亲自到场」，
     * 因此既不该被常规报名挡住，也不该挡住别人的常规报名。
     */
    const isProxy = String((session as { kind?: string }).kind ?? 'NORMAL') === 'PROXY';
    if (!ignoreConflict && !isProxy) {
      const [conflictRows] = await conn.execute<RowDataPacket[]>(
        `SELECT r.id AS registration_id, e.id AS event_id, e.title AS event_title,
                s.label AS session_label, s.start_at, s.end_at
           FROM registrations r
           JOIN event_sessions s ON s.id = r.session_id
           JOIN events e ON e.id = r.event_id
          WHERE r.user_id = ?
            AND r.status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')
            AND r.session_id <> ?
            AND s.kind <> 'PROXY'
            AND s.start_at < ? AND s.end_at > ?`,
        [userId, sessionId, session.end_at, session.start_at],
      );
      if (conflictRows.length) {
        const toIso = (v: unknown): string => new Date(`${String(v).replace(' ', 'T')}Z`).toISOString();
        const conflicts: ScheduleConflictDto[] = conflictRows.map((c) => ({
          registrationId: String(c.registration_id),
          eventId: String(c.event_id),
          eventTitle: String(c.event_title),
          sessionLabel: String(c.session_label),
          startAt: toIso(c.start_at),
          endAt: toIso(c.end_at),
        }));
        throw new AppError(BIZ_CODES.SCHEDULE_CONFLICT, undefined, { conflicts });
      }
    }

    const [priceRows] = await conn.execute<RowDataPacket[]>(
      'SELECT level, price_cent FROM event_prices WHERE event_id = ?', [eventId],
    );
    const priceCent = pickPrice(
      priceRows.map((r) => ({ level: String(r.level), priceCent: Number(r.price_cent) })),
      level,
    );

    /**
     * 优惠券：每名额最多一张，按提交顺序逐张套在名额上；券数少于名额数时，
     * 多出的名额按原价。金额一律服务端重算，前端只传券 id。
     */
    if (sortedCouponIds.length > seats) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '优惠券数量不能超过报名名额数');
    }
    const discounts = new Array<number>(seats).fill(0);
    if (sortedCouponIds.length) {
      if (!event.allow_coupon) throw new AppError(BIZ_CODES.COUPON_NOT_ALLOWED);
      const placeholders = sortedCouponIds.map(() => '?').join(',');
      // FOR UPDATE：防止同一张券被并发报名重复核销
      const [couponRows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM coupons WHERE user_id = ? AND id IN (${placeholders}) FOR UPDATE`,
        [userId, ...sortedCouponIds],
      );
      const byId = new Map(couponRows.map((c) => [String(c.id), c]));
      sortedCouponIds.forEach((id, i) => {
        const coupon = byId.get(id);
        if (!coupon) throw new AppError(BIZ_CODES.COUPON_INVALID, '优惠券不存在或不属于当前账号');
        if (coupon.status !== 'UNUSED') {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」不可用`);
        }
        const expiresAt = coupon.expires_at
          ? Date.parse(`${String(coupon.expires_at).replace(' ', 'T')}Z`)
          : null;
        if (expiresAt != null && expiresAt <= Date.now()) {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」已过期`);
        }
        if (Number(coupon.min_spend_cent ?? 0) > priceCent) {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」未达到最低消费门槛`);
        }
        discounts[i] = couponDiscountOf({
          type: coupon.type,
          discountBp: coupon.discount_bp == null ? null : Number(coupon.discount_bp),
          amountCent: coupon.amount_cent == null ? null : Number(coupon.amount_cent),
          maxDiscountCent: coupon.max_discount_cent == null ? null : Number(coupon.max_discount_cent),
        }, priceCent);
      });
    }

    const member = isMember(level);
    let available = 0;
    if (member) {
      const [bal] = await conn.execute<RowDataPacket[]>(
        'SELECT available_cent FROM balance_accounts WHERE user_id = ?', [userId],
      );
      available = Number(bal[0]?.available_cent ?? 0);
    }

    const decision = decideRegistration({
      event: {
        status: event.status, visibility: event.visibility,
        registerMinLevel: event.register_min_level,
        registrationOpenAt: isoTime(event.registration_open_at),
        registrationCloseAt: isoTime(event.registration_close_at),
      },
      session: {
        status: session.status, startAt: isoTime(session.start_at), endAt: isoTime(session.end_at),
        capacity: Number(session.capacity), capacityUsed: Number(session.capacity_used),
        kind: String((session as { kind?: string }).kind ?? 'NORMAL'),
      },
      level, priceCent, hasBalance: member, availableCent: available,
      payableCent: Math.max(0, priceCent - (discounts[0] ?? 0)),
    });
    if (!decision.ok) throw new AppError(decision.reasonCode ?? BIZ_CODES.EVENT_NOT_OPEN);

    // 多名额：同一用户可对同一场次持有多条记录，仅限制累计活跃名额，防止刷占名额
    // 待支付同样占位：不能靠「先登记不付钱」绕过上限
    const [activeRows] = await conn.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM registrations
        WHERE event_id = ? AND user_id = ?
          AND status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')`,
      [eventId, userId],
    );
    if (Number(activeRows[0]?.cnt ?? 0) + seats > MAX_SEATS_PER_EVENT) {
      throw new AppError(BIZ_CODES.SEATS_EXCEEDED, `同一场次累计最多报名 ${MAX_SEATS_PER_EVENT} 个名额`);
    }
    // 会员余额必须覆盖整批折后金额，整单成功或整单失败，不允许半批扣款
    const payableCent = Math.max(0, priceCent * seats - discounts.reduce((s, d) => s + d, 0));
    if (member && payableCent > 0 && available < payableCent) {
      throw new AppError(BIZ_CODES.BALANCE_INSUFFICIENT, '积分不足，请减少报名人数');
    }

    /**
     * 时段级回避名单：该时段不接受本人报名。
     * 文案刻意中性——不告诉用户「被某位会员排除」，只说这个时段不可选，
     * 换一个时段就能正常报名。
     */
    const [avoidRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM session_avoid_rules WHERE session_id = ? AND blocked_user_id = ? AND revoked_at IS NULL LIMIT 1',
      [sessionId, userId],
    );
    if (avoidRows[0]) throw new AppError(BIZ_CODES.SESSION_RESTRICTED);

    /**
     * 代拍不限人数：它不占用任何常规时段，摄影师按单量排期即可。
     * 因此跳过容量校验与计数器累加，避免「代拍名额满了」这种没有意义的拦截。
     */
    const isProxySession = String((session as { kind?: string }).kind ?? 'NORMAL') === 'PROXY';

    if (!isProxySession) {
      const remaining = Number(session.capacity) - Number(session.capacity_used);
      // 满员即拒（候补已下线）：先给出可读文案，真正的一致性仍靠下面的条件更新兜底
      if (remaining < seats) {
        throw new AppError(BIZ_CODES.EVENT_FULL, '剩余名额不足，请减少报名人数');
      }
      // 整批原子扣减；并发下扣减失败也直接报满员
      const [cap] = await conn.execute<ResultSetHeader>(
        'UPDATE event_sessions SET capacity_used = capacity_used + ? WHERE id = ? AND capacity_used + ? <= capacity',
        [seats, sessionId, seats],
      );
      if (cap.affectedRows !== 1) throw new AppError(BIZ_CODES.EVENT_FULL);
    }

    const now = toSqlDateTime();
    const paymentStatus = member ? 'NOT_REQUIRED' : 'UNPAID';
    // 会员扣积分即确认；非会员先「待支付」占住名额，运营确认收款后才转 CONFIRMED
    const regStatus = member ? 'CONFIRMED' : 'PENDING_PAYMENT';
    const created: RegistrationDto[] = [];
    for (let i = 0; i < seats; i += 1) {
      const discountCent = discounts[i] ?? 0;
      const feeCent = Math.max(0, priceCent - discountCent);
      const couponId = sortedCouponIds[i] ?? null;
      const [inserted] = await conn.execute<ResultSetHeader>(
        `INSERT INTO registrations
          (event_id, session_id, user_id, status, payment_status,
           fee_cent, original_fee_cent, discount_cent, coupon_id,
           refund_policy_snapshot, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, sessionId, userId, regStatus, paymentStatus,
          feeCent, priceCent, discountCent, couponId,
          JSON.stringify(event.refund_policy), scopedKey, now, now],
      );
      const regId = String(inserted.insertId);

      // 券已在本事务里 FOR UPDATE 锁过，条件更新只是兜底并发
      if (couponId) {
        const [claimed] = await conn.execute<ResultSetHeader>(
          "UPDATE coupons SET status = 'USED', used_registration_id = ?, used_at = ? WHERE id = ? AND status = 'UNUSED'",
          [regId, now, couponId],
        );
        if (claimed.affectedRows !== 1) throw new AppError(BIZ_CODES.COUPON_INVALID);
      }

      // 每条独立冻结，bizId 用各自的报名 ID，退款/对账可逐条追溯
      if (member && feeCent > 0) {
        const ledger = await applyLedgerEntry(conn, {
          userId, op: 'FREEZE', amountCent: feeCent,
          bizType: 'REGISTRATION', bizId: regId, idempotencyKey: scopedKey, remark: '报名冻结',
        });
        await conn.execute('UPDATE registrations SET balance_txn_id = ? WHERE id = ?', [ledger.txnId, regId]);
      }

      const [rows] = await conn.execute<RegistrationRow[]>(
        `SELECT r.*, u.wechat_id AS user_wechat_id, u.nickname AS user_nickname, c.title AS coupon_title
           FROM registrations r
           LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN coupons c ON c.id = r.coupon_id
          WHERE r.id = ?`,
        [regId],
      );
      created.push(registrationDtoOf(rows[0]!, eventDtoOf(event), sessionDtoOf(session)));
    }
    const batch: RegistrationBatchDto = { registrations: created, seats };
    // 缓存「业务数据」而非完整响应包：重放时本函数返回 batch，路由层再 sendOk 包一层。
    // 若这里存 successResponse(batch)，重放取 .data 会得到整个响应包，造成双重包裹。
    await completeIdempotency(conn, scopedKey, batch);
    return batch;
  });
}

async function cancelRegistration(userId: string, regId: string, reason?: string): Promise<{ eventId: string }> {
  const [pre] = await pool.execute<RegistrationRow[]>('SELECT * FROM registrations WHERE id = ?', [regId]);
  const preRow = pre[0];
  if (!preRow) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
  if (String(preRow.user_id) !== userId) throw new AppError(BIZ_CODES.RESOURCE_NOT_OWNED);

  const eventId = String(preRow.event_id);
  await withTransaction(async (conn) => {
    const [eventRows] = await conn.execute<EventRow[]>('SELECT * FROM events WHERE id = ? FOR UPDATE', [eventId]);
    const event = eventRows[0];
    if (!event) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    const [rows] = await conn.execute<RegistrationRow[]>('SELECT * FROM registrations WHERE id = ? FOR UPDATE', [regId]);
    const reg = rows[0];
    if (!reg) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);

    // 已进入退款流程或已终态时，重复取消视为幂等成功——
    // 否则会撞上「不允许从 REFUND_PENDING 迁移到 REFUND_PENDING」这种自迁移报错。
    const settled: RegistrationStatus[] = ['REFUND_PENDING', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'COMPLETED'];
    if (settled.includes(reg.status as RegistrationStatus)) return;

    // 已收款/已入积分的取消走退款流程（会员回充余额、非会员线下退）。
    // 待支付与历史候补没有资金流动：直接 CANCELLED，退名额、退券，不产生退款单。
    const noMoney = reg.status === 'PENDING_PAYMENT' || reg.status === 'WAITLISTED';
    const target: RegistrationStatus = noMoney ? 'CANCELLED' : 'REFUND_PENDING';
    assertTransition(REGISTRATION_TRANSITIONS, reg.status as RegistrationStatus, target);

    if (target === 'CANCELLED' && reg.status === 'PENDING_PAYMENT') {
      if (reg.session_id) {
        // 待支付同样占过名额，取消必须归还（代拍不占名额，不减）
        await conn.execute(
          "UPDATE event_sessions SET capacity_used = capacity_used - 1 WHERE id = ? AND kind <> 'PROXY' AND capacity_used > 0",
          [reg.session_id],
        );
      }
      // 钱还没收，不存在「退款待审期间券被挪用」的风险，直接退券
      await releaseCouponOf(conn, regId);
    }

    if (target === 'REFUND_PENDING') {
      const snapshot = reg.refund_policy_snapshot ?? { freeCancelBeforeHours: 24, feeRatio: 0 };
      const [sessRows] = await conn.execute<RowDataPacket[]>(
        'SELECT start_at FROM event_sessions WHERE id = ?', [reg.session_id],
      );
      const startAt = String(sessRows[0]?.start_at ?? event.start_at);
      if (!canCancel(snapshot.freeCancelBeforeHours, startAt)) {
        throw new AppError(BIZ_CODES.REFUND_WINDOW_CLOSED);
      }
      const amount = refundAmountOf(Number(reg.fee_cent), snapshot.feeRatio);
      const now = toSqlDateTime();
      await conn.execute(
        "INSERT INTO refund_orders (registration_id, amount_cent, reason, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'REQUESTED', ?, ?, ?)",
        [regId, amount, reason ?? null, userId, now, now],
      );
      if (reg.session_id) {
        // 代拍不占名额、从不累加 capacity_used，退名额时也不能减（否则会把常规时段的计数减错）
        await conn.execute(
          "UPDATE event_sessions SET capacity_used = capacity_used - 1 WHERE id = ? AND kind <> 'PROXY' AND capacity_used > 0",
          [reg.session_id],
        );
      }
    }
    await conn.execute('UPDATE registrations SET status = ?, cancel_reason = ? WHERE id = ?', [target, reason ?? null, regId]);

    /**
     * 发起人自己取消后，他为这个时段设置的回避规则一并失效。
     * 否则人已经不来了，名单还挂在那里继续拦别人，对第三方不公平也不好解释。
     */
    if (reg.session_id) {
      const stamp = toSqlDateTime();
      await conn.execute(
        `UPDATE session_avoid_rules
            SET revoked_at = ?, revoked_by = ?, updated_at = ?
          WHERE session_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
        [stamp, userId, stamp, String(reg.session_id), userId],
      );
    }
  });
  return { eventId };
}

/**
 * 后台手动录入（线下报名 / 补录）。
 *
 * 与线上自助登记**对齐**的部分（这里刻意复用同一套口径与同一批校验）：
 * - 按账号当前等级取价；
 * - 每名额最多一张优惠券，门槛/有效期/归属/场次开关全部校验，金额服务端重算；
 * - 支持多名额，累计不超过 MAX_SEATS_PER_EVENT；
 * - 选「扣积分」时走同一套账本 FREEZE 流水，报名记录里能追到 balance_txn_id。
 *
 * 只有两点不同，都是补录场景的必要放宽：
 * - 不拦截报名窗口与时段冲突（线下补录常常晚于线上截止）；
 * - 结算方式由运营显式指定，而不是由「是否有余额」推定（现场可能已收现金、也可能是赠票）。
 *
 * 依赖 payload 已通过 adminRegistrationCreateSchema 校验（券数 ≤ 名额数、券不重复）。
 */
async function createManualRegistration(
  payload: AdminRegistrationCreatePayload,
): Promise<{ registrations: RegistrationDto[]; warnings: string[] }> {
  const seats = payload.seats;
  const sortedCouponIds = [...payload.couponIds].sort();
  const settleMode = payload.settleMode;

  return withTransaction(async (conn) => {
    const now = toSqlDateTime();
    const [userRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id, wechat_id, status FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1',
      [payload.wechatId],
    );
    const user = userRows[0];
    if (!user) {
      throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${payload.wechatId}」不存在，请先在「用户管理」新增账号`);
    }
    if (user.status !== 'ACTIVE') throw new AppError(BIZ_CODES.INVALID_PARAM, '该账号已冻结，不能录入报名');
    const userId = String(user.id);

    const [levelRows] = await conn.execute<RowDataPacket[]>(
      "SELECT level FROM memberships WHERE user_id = ? AND status = 'ACTIVE' AND start_at <= ? AND expire_at > ?",
      [userId, now, now],
    );
    const level = effectiveLevel(levelRows.map((r) => ({ level: String(r.level) })));
    const member = isMember(level);

    const [eventRows] = await conn.execute<EventRow[]>('SELECT * FROM events WHERE id = ? FOR UPDATE', [payload.eventId]);
    const event = eventRows[0];
    if (!event) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '草稿或已取消的场次不能录入报名');
    }
    if (!satisfiesVisibility(level, event.visibility)) {
      throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT, '该账号等级不满足场次可见性；如需补录请先调整会员等级');
    }

    const [sessionRows] = await conn.execute<SessionRow[]>(
      'SELECT * FROM event_sessions WHERE id = ? AND event_id = ? FOR UPDATE', [payload.sessionId, payload.eventId],
    );
    const session = sessionRows[0];
    if (!session) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (session.status !== 'OPEN') throw new AppError(BIZ_CODES.INVALID_PARAM, '该时段已关闭，不能录入报名');
    // 线下补录允许晚于报名截止，但时段结束后不能再补，否则无法到场也占不到名额
    if (Date.parse(isoTime(session.end_at)) <= Date.now()) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '该时段已结束，不能补录报名');
    }

    const [priceRows] = await conn.execute<RowDataPacket[]>(
      'SELECT level, price_cent FROM event_prices WHERE event_id = ?', [payload.eventId],
    );
    const priceCent = pickPrice(
      priceRows.map((r) => ({ level: String(r.level), priceCent: Number(r.price_cent) })),
      level,
    );

    /* ---------------- 优惠券：与自助登记逐条对齐 ---------------- */
    const discounts = new Array<number>(seats).fill(0);
    if (sortedCouponIds.length) {
      if (!event.allow_coupon) {
        throw new AppError(BIZ_CODES.COUPON_NOT_ALLOWED, '该场次已关闭优惠券使用');
      }
      const placeholders = sortedCouponIds.map(() => '?').join(',');
      // FOR UPDATE：防止同一张券被并发录入重复核销
      const [couponRows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM coupons WHERE user_id = ? AND id IN (${placeholders}) FOR UPDATE`,
        [userId, ...sortedCouponIds],
      );
      const byId = new Map(couponRows.map((c) => [String(c.id), c]));
      sortedCouponIds.forEach((id, i) => {
        const coupon = byId.get(id);
        if (!coupon) throw new AppError(BIZ_CODES.COUPON_INVALID, '优惠券不存在或不属于该账号');
        if (coupon.status !== 'UNUSED') {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」不可用`);
        }
        const expiresAt = coupon.expires_at
          ? Date.parse(`${String(coupon.expires_at).replace(' ', 'T')}Z`)
          : null;
        if (expiresAt != null && expiresAt <= Date.now()) {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」已过期`);
        }
        if (Number(coupon.min_spend_cent ?? 0) > priceCent) {
          throw new AppError(BIZ_CODES.COUPON_INVALID, `优惠券「${coupon.title}」未达到最低消费门槛`);
        }
        discounts[i] = couponDiscountOf({
          type: coupon.type,
          discountBp: coupon.discount_bp == null ? null : Number(coupon.discount_bp),
          amountCent: coupon.amount_cent == null ? null : Number(coupon.amount_cent),
          maxDiscountCent: coupon.max_discount_cent == null ? null : Number(coupon.max_discount_cent),
        }, priceCent);
      });
    }

    /* ---------------- 结算方式与余额 ---------------- */
    if (settleMode === 'CREDIT' && !member) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '该账号不是 VIP/SVIP，没有积分账户，无法按「扣积分」结算');
    }
    const grossCent = priceCent * seats;
    // 免费票：整单记 0 消耗，折扣列记为全额减免，便于列表里看出「免了多少」
    const totalDiscount = settleMode === 'FREE'
      ? grossCent
      : discounts.reduce((s, d) => s + d, 0);
    const payableCent = Math.max(0, grossCent - totalDiscount);

    let available = 0;
    if (member) {
      const [bal] = await conn.execute<RowDataPacket[]>(
        'SELECT available_cent FROM balance_accounts WHERE user_id = ?', [userId],
      );
      available = Number(bal[0]?.available_cent ?? 0);
    }
    if (settleMode === 'CREDIT' && payableCent > available) {
      throw new AppError(
        BIZ_CODES.BALANCE_INSUFFICIENT,
        `该账号可用积分不足（可用 ${(available / 100).toFixed(2)}，本次需 ${(payableCent / 100).toFixed(2)}）`,
      );
    }

    // 多名额上限与自助登记同口径（待支付同样占位），避免后台绕过「同一场次最多 N 个名额」的限制
    const [activeRows] = await conn.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM registrations
        WHERE event_id = ? AND user_id = ?
          AND status IN ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN')`,
      [payload.eventId, userId],
    );
    if (Number(activeRows[0]?.cnt ?? 0) + seats > MAX_SEATS_PER_EVENT) {
      throw new AppError(BIZ_CODES.SEATS_EXCEEDED, `该账号在本场次累计名额已达上限（${MAX_SEATS_PER_EVENT} 个）`);
    }

    // 代拍不限人数，跳过余量校验与计数器累加（与自助登记同一口径）
    const isProxySessionManual = String((session as { kind?: string }).kind ?? 'NORMAL') === 'PROXY';
    if (!isProxySessionManual) {
      const remaining = Number(session.capacity) - Number(session.capacity_used);
      if (remaining < seats) {
        throw new AppError(BIZ_CODES.EVENT_FULL, `该时段剩余名额不足（剩 ${Math.max(0, remaining)} 个）`);
      }
    }
    // 命中回避名单时只警告不阻断：这是运营的手动录入，最终决定权在运营
    const [avoidRows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM session_avoid_rules WHERE session_id = ? AND blocked_user_id = ? AND revoked_at IS NULL LIMIT 1',
      [session.id, userId],
    );
    const warnings: string[] = [];
    if (avoidRows[0]) {
      warnings.push('该账号在这个时段的回避名单里；本次按运营强制录入处理。');
    }
    if (!isProxySessionManual) {
      const [cap] = await conn.execute<ResultSetHeader>(
        'UPDATE event_sessions SET capacity_used = capacity_used + ? WHERE id = ? AND capacity_used + ? <= capacity',
        [seats, session.id, seats],
      );
      if (cap.affectedRows !== 1) throw new AppError(BIZ_CODES.EVENT_FULL, '该时段名额已满，无法补录');
    }

    const paymentStatus = settleMode === 'CREDIT' || settleMode === 'FREE'
      ? 'NOT_REQUIRED'
      : settleMode === 'OFFLINE_PAID' ? 'PAID' : 'UNPAID';
    const stamp = toSqlDateTime();
    const created: RegistrationDto[] = [];

    for (let i = 0; i < seats; i += 1) {
      const discountCent = settleMode === 'FREE' ? priceCent : (discounts[i] ?? 0);
      const feeCent = Math.max(0, priceCent - discountCent);
      const couponId = sortedCouponIds[i] ?? null;
      const [inserted] = await conn.execute<ResultSetHeader>(
        `INSERT INTO registrations
          (event_id, session_id, user_id, status, payment_status, source,
           fee_cent, original_fee_cent, discount_cent, coupon_id,
           refund_policy_snapshot, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          payload.eventId, payload.sessionId, userId, payload.arriveStatus, paymentStatus,
          feeCent, priceCent, discountCent, couponId,
          JSON.stringify(event.refund_policy), stamp, stamp,
        ],
      );
      const regId = String(inserted.insertId);

      // 券已在本事务里 FOR UPDATE 锁过，条件更新只是兜底并发
      if (couponId) {
        const [claimed] = await conn.execute<ResultSetHeader>(
          "UPDATE coupons SET status = 'USED', used_registration_id = ?, used_at = ? WHERE id = ? AND status = 'UNUSED'",
          [regId, stamp, couponId],
        );
        if (claimed.affectedRows !== 1) throw new AppError(BIZ_CODES.COUPON_INVALID);
      }

      // 扣积分才记账本：与自助登记同一 op，取消/退款时能沿同一条链路回充
      if (settleMode === 'CREDIT' && feeCent > 0) {
        const ledger = await applyLedgerEntry(conn, {
          userId, op: 'FREEZE', amountCent: feeCent,
          bizType: 'REGISTRATION', bizId: regId,
          idempotencyKey: `manual-${regId}`,
          remark: '后台手动录入冻结',
        });
        await conn.execute('UPDATE registrations SET balance_txn_id = ? WHERE id = ?', [ledger.txnId, regId]);
      }

      const [rows] = await conn.execute<RegistrationRow[]>(
        `SELECT r.*, u.wechat_id AS user_wechat_id, u.nickname AS user_nickname, c.title AS coupon_title
           FROM registrations r
           LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN coupons c ON c.id = r.coupon_id
          WHERE r.id = ?`,
        [regId],
      );
      created.push(registrationDtoOf(rows[0]!, eventDtoOf(event), sessionDtoOf(session)));
    }

    return { registrations: created, warnings };
  });
}

export function mountRegistrations(app: Express): void {
  const pub = Router();
  pub.use(authenticate);

  pub.post('/', validateBody(registrationCreateSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key) throw new AppError(BIZ_CODES.IDEMPOTENCY_KEY_MISSING);
    const payload = req.body as RegistrationCreatePayload;
    const batch = await createRegistration(
      identity.userId, identity.level, payload.eventId, payload.sessionId, key,
      payload.ignoreConflict, payload.seats, payload.couponIds,
    );
    sendOk(res, batch, 201);
  }));

  pub.get('/mine', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const [rows] = await pool.execute<RegistrationRow[]>(
      `SELECT r.*, e.title AS event_title,
              s.label AS session_label, s.start_at AS session_start_at, s.end_at AS session_end_at,
              s.capacity AS session_capacity, s.capacity_used AS session_capacity_used,
              s.status AS session_status, s.sort_no AS session_sort_no, s.kind AS session_kind,
              c.title AS coupon_title
       FROM registrations r
       LEFT JOIN events e ON e.id = r.event_id
       LEFT JOIN event_sessions s ON s.id = r.session_id
       LEFT JOIN coupons c ON c.id = r.coupon_id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [identity.userId, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM registrations WHERE user_id = ?', [identity.userId],
    );
    sendOk(res, paginatedOf(rows.map((r) => registrationDtoOf(r)), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  pub.get('/:id', asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    /**
     * 票根要用到场次标题与时段名，这里与「我的报名」列表保持同一套 join，
     * 避免前端拿到一条只有 id 的记录还要再拼一次。
     */
    const [rows] = await pool.execute<RegistrationRow[]>(
      `SELECT r.*, e.title AS event_title,
              s.label AS session_label, s.start_at AS session_start_at, s.end_at AS session_end_at,
              s.capacity AS session_capacity, s.capacity_used AS session_capacity_used,
              s.status AS session_status, s.sort_no AS session_sort_no, s.kind AS session_kind,
              c.title AS coupon_title
         FROM registrations r
         LEFT JOIN events e ON e.id = r.event_id
         LEFT JOIN event_sessions s ON s.id = r.session_id
         LEFT JOIN coupons c ON c.id = r.coupon_id
        WHERE r.id = ?`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (String(row.user_id) !== identity.userId) throw new AppError(BIZ_CODES.RESOURCE_NOT_OWNED);
    sendOk(res, registrationDtoOf(row));
  }));

  pub.post('/:id/cancel', validateBody(registrationCancelSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as RegistrationCancelPayload;
    await cancelRegistration(identity.userId, req.params.id, payload.reason);
    sendOk(res, { id: req.params.id });
  }));

  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:registration:write'));
  admin.get('/', validateQuery(adminRegistrationListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { eventId, sessionId, status, paymentStatus, keyword, dateFrom, dateTo } = req.query as AdminRegistrationListQuery;
    // 从场次管理进入报名管理时只加载该场次 / 该时段的报名
    const conds: string[] = [];
    const condParams: string[] = [];
    if (eventId) { conds.push('r.event_id = ?'); condParams.push(eventId); }
    if (sessionId) { conds.push('r.session_id = ?'); condParams.push(sessionId); }
    // 状态与关键词筛选下推到 SQL：报名表只增不减，前端只过滤当前页会漏数据
    if (status) { conds.push('r.status = ?'); condParams.push(status); }
    if (paymentStatus) { conds.push('r.payment_status = ?'); condParams.push(paymentStatus); }
    const kw = (keyword ?? '').trim();
    if (kw) {
      conds.push('(u.wechat_id LIKE ? OR u.nickname LIKE ? OR e.title LIKE ?)');
      condParams.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    // 报名时间范围：按本地自然日切，end 用次日零点配 `<`（DATETIME(3) 有毫秒，23:59:59 会漏）
    const range = localDayRangeUtc(dateFrom, dateTo);
    if (range.start) { conds.push('r.created_at >= ?'); condParams.push(range.start); }
    if (range.end) { conds.push('r.created_at < ?'); condParams.push(range.end); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // 关键词要匹配微信号与场次名，JOIN 后 COUNT 也必须带上同样的 JOIN，否则总数与列表不一致
    const joinSql = `
       FROM registrations r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN events e ON e.id = r.event_id`;
    const [rows] = await pool.execute<RegistrationRow[]>(
      `SELECT r.*, u.wechat_id AS user_wechat_id, u.nickname AS user_nickname,
              e.title AS event_title,
              s.label AS session_label, s.start_at AS session_start_at, s.end_at AS session_end_at,
              s.capacity AS session_capacity, s.capacity_used AS session_capacity_used,
              s.status AS session_status, s.sort_no AS session_sort_no, s.kind AS session_kind,
              c.title AS coupon_title
       ${joinSql}
       LEFT JOIN event_sessions s ON s.id = r.session_id
       LEFT JOIN coupons c ON c.id = r.coupon_id
       ${where}
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [...condParams, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total ${joinSql} ${where}`,
      condParams,
    );
    // 待收款角标是全局口径，不能被当前页/当前筛选影响，单独聚合一次。
    // 待支付（新流程）与历史 CONFIRMED+UNPAID（旧数据/手动录入未收款）都算待收款。
    const [payCounts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS unpaid FROM registrations
        WHERE payment_status = 'UNPAID' AND status IN ('PENDING_PAYMENT','CONFIRMED')`,
    );
    sendOk(res, {
      ...paginatedOf(rows.map((r) => registrationDtoOf(r)), Number(counts[0]?.total ?? 0), page, pageSize),
      unpaidTotal: Number(payCounts[0]?.unpaid ?? 0),
    });
  }));

  /** 手动录入前校验微信号：运营没有会员管理权限，不能用用户列表接口 */
  admin.get('/lookup', validateQuery(adminRegistrationLookupQuerySchema), asyncHandler(async (req, res) => {
    const { wechatId } = req.query as AdminRegistrationLookupQuery;
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id, wechat_id, nickname, status FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1',
      [wechatId],
    );
    const user = rows[0];
    if (!user) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${wechatId}」不存在`);
    const now = toSqlDateTime();
    const [levelRows] = await pool.execute<RowDataPacket[]>(
      "SELECT level FROM memberships WHERE user_id = ? AND status = 'ACTIVE' AND start_at <= ? AND expire_at > ?",
      [String(user.id), now, now],
    );
    // 手动录入弹窗要提前判断「扣积分够不够」，所以把可用积分一并带出
    const [balRows] = await pool.execute<RowDataPacket[]>(
      'SELECT available_cent FROM balance_accounts WHERE user_id = ?', [String(user.id)],
    );
    sendOk(res, {
      id: String(user.id),
      wechatId: user.wechat_id,
      nickname: user.nickname,
      level: effectiveLevel(levelRows.map((r) => ({ level: String(r.level) }))),
      status: user.status,
      availableCent: balRows[0] ? Number(balRows[0].available_cent) : null,
    });
  }));

  /**
   * 下拉选人选项：手动录入报名 / 优惠券发放 / 积分调账共用。
   *
   * 运营没有会员管理权限，不能复用 /admin/users；这里只返回选人所需最小字段，
   * 运维账号与已删除账号不出现在选项中。
   *
   * ⚠️ 必须挂在独立 router 上，不能放进下面的 admin 组：
   * admin 组有全局中间件 `admin.use(..., requireCapabilities('admin:registration:write'))`，
   * 请求在进入本路由前就被拦掉，路由级再放宽也没用。
   * 财务（FINANCE）只有 admin:balance:adjust:request，没有报名写权限，
   * 若不放宽，财务打开「积分调账」弹窗时选人列表会一直为空（403 → 3001）。
   */
  const picker = Router();
  picker.use(
    authenticate,
    requireAnyCapability(
      'admin:registration:write',
      'admin:balance:adjust:request',
      'admin:membership:grant',
      'admin:user:reset-password',
    ),
  );
  picker.get('/users', validateQuery(adminUserOptionsQuerySchema), asyncHandler(async (req, res) => {
    const { keyword, limit } = req.query as unknown as AdminUserOptionsQueryInput;
    const kw = (keyword ?? '').trim();
    const where = [
      'u.deleted_at IS NULL',
      "NOT EXISTS (SELECT 1 FROM admin_roles x WHERE x.user_id = u.id AND x.role = 'SUPER_ADMIN')",
    ];
    const params: Array<string | number> = [];
    if (kw) {
      where.push('(u.wechat_id LIKE ? OR u.nickname LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`);
    }
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT u.id, u.wechat_id, u.nickname, u.status
       FROM users u
       WHERE ${where.join(' AND ')}
       ORDER BY u.id DESC LIMIT ?`,
      [...params, limit],
    );
    const now = toSqlDateTime();
    const ids = rows.map((r) => String(r.id));
    const levelOf = new Map<string, MemberLevel>();
    if (ids.length) {
      const [levelRows] = await pool.execute<RowDataPacket[]>(
        `SELECT user_id, level FROM memberships
         WHERE status = 'ACTIVE' AND start_at <= ? AND expire_at > ?
           AND user_id IN (${ids.map(() => '?').join(', ')})`,
        [now, now, ...ids],
      );
      const byUser = new Map<string, Array<{ level: string }>>();
      for (const lr of levelRows) {
        const key = String(lr.user_id);
        const list = byUser.get(key) ?? [];
        list.push({ level: String(lr.level) });
        byUser.set(key, list);
      }
      for (const [key, list] of byUser) levelOf.set(key, effectiveLevel(list));
    }
    /**
     * 可用积分也要带出来：手动录入弹窗直接用本接口的返回值做「余额够不够」判断，
     * 少了这个字段前端只能按 0 处理，会员也会被误判成「无积分账户」。
     */
    const balanceOf = new Map<string, number>();
    if (ids.length) {
      const [balRows] = await pool.execute<RowDataPacket[]>(
        `SELECT user_id, available_cent FROM balance_accounts
          WHERE user_id IN (${ids.map(() => '?').join(', ')})`,
        ids,
      );
      for (const b of balRows) balanceOf.set(String(b.user_id), Number(b.available_cent));
    }
    sendOk(res, rows.map((r) => ({
      id: String(r.id),
      wechatId: r.wechat_id,
      nickname: r.nickname,
      level: levelOf.get(String(r.id)) ?? 'NONE',
      status: r.status === 'FROZEN' ? 'FROZEN' : 'ACTIVE',
      availableCent: balanceOf.get(String(r.id)) ?? null,
    })));
  }));
  // 与 admin 组同前缀挂载：picker 先注册，命中 /users 后不再往下走
  app.use(`${API_BASE_PATH}/admin/registrations`, picker);

  /** 手动录入：与自助登记同口径（名额 / 优惠券 / 按等级取价），结算方式由运营指定 */
  admin.post('/', validateBody(adminRegistrationCreateSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as AdminRegistrationCreatePayload;
    const { registrations: created, warnings } = await createManualRegistration(payload);
    const totalFee = created.reduce((s, r) => s + r.feeCent, 0);
    await auditOf(res)?.({
      action: 'REGISTRATION_MANUAL_CREATE', targetType: 'registration',
      targetId: created.map((r) => r.id).join(','),
      after: {
        wechatId: payload.wechatId, eventId: payload.eventId, sessionId: payload.sessionId,
        seats: payload.seats, settleMode: payload.settleMode,
        couponIds: payload.couponIds, feeCent: totalFee, reason: payload.reason ?? null,
        avoidWarnings: warnings,
      },
      actorId: identity.userId,
    });
    sendOk(res, { registrations: created, seats: created.length, warnings }, 201);
  }));

  admin.patch('/:id', validateBody(adminRegistrationActionSchema), asyncHandler(async (req, res) => {
    const payload = req.body as AdminRegistrationActionPayload;
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RegistrationRow[]>('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (payload.action === 'CANCEL') {
      await cancelRegistration(String(row.user_id), req.params.id, payload.reason);
    } else {
      assertTransition(REGISTRATION_TRANSITIONS, row.status as RegistrationStatus, 'CHECKED_IN');
      await pool.execute("UPDATE registrations SET status = 'CHECKED_IN' WHERE id = ?", [req.params.id]);
    }
    await auditOf(res)?.({
      action: 'REGISTRATION_STATUS_CHANGE', targetType: 'registration', targetId: req.params.id,
      before: { status: row.status }, after: { action: payload.action, reason: payload.reason }, actorId: identity.userId,
    });
    sendOk(res, { id: req.params.id });
  }));

  /** 非会员线下支付后确认收款；会员报名不需要此操作 */
  admin.post('/:id/confirm-payment', asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RegistrationRow[]>('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    // 已取消/已退款/已失效的报名不能再收款：钱没收到、名额已释放，
    // 再标「已收款」会让财务对着一笔不存在的交易对账。
    if (row.status !== 'PENDING_PAYMENT' && row.status !== 'CONFIRMED') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '该报名已取消或已退款，不能再确认收款');
    }
    if (row.payment_status !== 'UNPAID') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '该报名当前无需确认收款');
    }
    // 待支付单：收到钱才算「已确认」，状态与收款一起落。
    // 历史 CONFIRMED+UNPAID（旧数据/手动录入）保持原状态，只改收款标记。
    const promoting = row.status === 'PENDING_PAYMENT';
    if (promoting) assertTransition(REGISTRATION_TRANSITIONS, row.status as RegistrationStatus, 'CONFIRMED');
    await pool.execute(
      "UPDATE registrations SET payment_status = 'PAID', status = ? WHERE id = ?",
      [promoting ? 'CONFIRMED' : row.status, req.params.id],
    );
    await auditOf(res)?.({
      action: 'REGISTRATION_STATUS_CHANGE', targetType: 'registration', targetId: req.params.id,
      before: { status: row.status, paymentStatus: 'UNPAID' },
      after: { status: promoting ? 'CONFIRMED' : row.status, paymentStatus: 'PAID' }, actorId: identity.userId,
    });
    sendOk(res, { id: req.params.id, status: promoting ? 'CONFIRMED' : row.status, paymentStatus: 'PAID' });
  }));

  /**
   * 现场批量：签到 / 确认收款 / 取消。
   *
   * 为什么逐条处理而不是一条 SQL 批量更新：
   * 每条都要过 REGISTRATION_TRANSITIONS 状态机与审计，一条 SQL 批量更新无法知道
   * 哪条不合法，也无法给每条留审计痕迹。这里刻意「部分成功」——现场 20 个人排队，
   * 不能因为其中一条已被别人取消就整批失败，运营要看到「成功 18 条、跳过 2 条」。
   */
  admin.post('/batch', validateBody(adminRegistrationBatchSchema), asyncHandler(async (req, res) => {
    const payload = req.body as AdminRegistrationBatchPayload;
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);

    const succeeded: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of payload.ids) {
      try {
        const [rows] = await pool.execute<RegistrationRow[]>('SELECT * FROM registrations WHERE id = ?', [id]);
        const row = rows[0];
        if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '报名不存在');

        if (payload.action === 'CANCEL') {
          await cancelRegistration(String(row.user_id), id, payload.reason);
        } else if (payload.action === 'CHECK_IN') {
          assertTransition(REGISTRATION_TRANSITIONS, row.status as RegistrationStatus, 'CHECKED_IN');
          await pool.execute("UPDATE registrations SET status = 'CHECKED_IN' WHERE id = ?", [id]);
        } else {
          // 与单条 confirm-payment 同口径：已取消/已退款的报名不能再收款
          if (row.status !== 'PENDING_PAYMENT' && row.status !== 'CONFIRMED') {
            throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '该报名已取消或已退款，不能再确认收款');
          }
          if (row.payment_status !== 'UNPAID') {
            throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '该报名当前无需确认收款');
          }
          // 与单条 confirm-payment 同口径：待支付单收到钱才转已确认
          const promoting = row.status === 'PENDING_PAYMENT';
          if (promoting) assertTransition(REGISTRATION_TRANSITIONS, row.status as RegistrationStatus, 'CONFIRMED');
          await pool.execute(
            "UPDATE registrations SET payment_status = 'PAID', status = ? WHERE id = ?",
            [promoting ? 'CONFIRMED' : row.status, id],
          );
        }

        await auditOf(res)?.({
          action: 'REGISTRATION_STATUS_CHANGE', targetType: 'registration', targetId: id,
          before: { status: row.status, paymentStatus: row.payment_status },
          after: { action: payload.action, batch: true, reason: payload.reason }, actorId: identity.userId,
        });
        succeeded.push(id);
      } catch (e) {
        // 单条失败不阻断整批：把原因记下来，前端提示「成功 N 条 / 跳过 M 条」
        skipped.push({ id, reason: e instanceof AppError ? e.message : '处理失败' });
      }
    }

    sendOk(res, { action: payload.action, succeeded, skipped } satisfies AdminRegistrationBatchResult);
  }));

  app.use(`${API_BASE_PATH}/registrations`, pub);
  app.use(`${API_BASE_PATH}/admin/registrations`, admin);
}
