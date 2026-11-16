/** 余额 / 流水 / 人工调账（一步入账）/ 退款审核（账本回充）域。 */
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  REFUND_TRANSITIONS,
  assertTransition,
  balanceAdjustmentSchema,
  adminBalanceTxnListQuerySchema,
  adminRefundListQuerySchema,
  pageQuerySchema,
  refundReviewSchema,
  refundSettleSchema,
  type AdminBalanceTxnListQuery,
  type AdminRefundListQuery,
  type BalanceAdjustmentPayload,
  type RefundReviewPayload,
  type RefundSettlePayload,
  type RefundStatus,
  type RegistrationStatus,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity, getTraceId } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { balanceAccountDtoOf, balanceTxnDtoOf, pageArgsOf, paginatedOf, refundDtoOf } from '../domain/dto';
import { applyLedgerEntry } from '../domain/ledger';
import { releaseCouponOf } from './coupons.module';
import { localDayRangeUtc, toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

interface RefundRow extends RowDataPacket {
  id: string; registration_id: string; amount_cent: string; status: RefundStatus;
  requested_by: string; review_remark: string | null;
  balance_txn_id: string | null; settled_at: string | null;
}
interface RegistrationRow extends RowDataPacket {
  id: string; user_id: string; event_id: string; session_id: string | null; fee_cent: string;
  status: RegistrationStatus; payment_status: string;
}

async function reviewRefund(id: string, payload: RefundReviewPayload, actorId: string): Promise<string> {
  return withTransaction(async (conn) => {
    // 固定加锁顺序：registrations → refund_orders（与场次取消、用户取消保持一致，避免死锁）
    const [pre] = await conn.execute<RefundRow[]>('SELECT * FROM refund_orders WHERE id = ?', [id]);
    const preRefund = pre[0];
    if (!preRefund) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    const [regs] = await conn.execute<RegistrationRow[]>(
      'SELECT * FROM registrations WHERE id = ? FOR UPDATE', [preRefund.registration_id],
    );
    const reg = regs[0];
    if (!reg) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    const [rows] = await conn.execute<RefundRow[]>('SELECT * FROM refund_orders WHERE id = ? FOR UPDATE', [id]);
    const refund = rows[0];
    if (!refund) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    const now = toSqlDateTime();

    if (!payload.approve) {
      assertTransition(REFUND_TRANSITIONS, refund.status, 'REJECTED');
      // 申请退款时已把时段名额释放；驳回意味着用户继续参加，必须把名额补回同一时段。
      // 补不回（已被别人占用）则不能驳回，否则该报名将没有容量承载，形成超卖。
      // 代拍不限人数、也不占名额，驳回时不需要（也不能）回补计数。
      if (reg.session_id) {
        const [cap] = await conn.execute<ResultSetHeader>(
          "UPDATE event_sessions SET capacity_used = capacity_used + 1 WHERE id = ? AND kind <> 'PROXY' AND capacity_used < capacity",
          [reg.session_id],
        );
        // 代拍被跳过更新是正常情况（affectedRows=0），不算满员
        const [kindRows] = await conn.execute<RowDataPacket[]>(
          'SELECT kind FROM event_sessions WHERE id = ?', [reg.session_id],
        );
        const isProxy = String(kindRows[0]?.kind ?? 'NORMAL') === 'PROXY';
        if (cap.affectedRows !== 1 && !isProxy) {
          throw new AppError(BIZ_CODES.EVENT_FULL, '该时段名额已被占满，无法驳回退款；请先取消该报名或与用户协商');
        }
      }
      await conn.execute(
        "UPDATE refund_orders SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?, review_remark = ? WHERE id = ?",
        [actorId, now, payload.remark ?? null, id],
      );
      await conn.execute("UPDATE registrations SET status = 'CONFIRMED' WHERE id = ?", [reg.id]);
      return id;
    }

    assertTransition(REFUND_TRANSITIONS, refund.status, 'APPROVED');
    assertTransition(REFUND_TRANSITIONS, 'APPROVED', 'REFUNDING');
    assertTransition(REFUND_TRANSITIONS, 'REFUNDING', 'REFUNDED');
    const amount = Number(refund.amount_cent);
    const frozen = Number(reg.fee_cent);
    // 只有会员（余额已在报名时扣减）才做账本回充；非会员是线下支付，退款在线下完成
    const fromBalance = reg.payment_status === 'NOT_REQUIRED';
    let txnId: string | null = null;
    if (fromBalance && amount > 0) {
      // 释放冻结并回充可用余额（等价于方案中的 IN 回充）；手续费部分结算实扣
      const back = await applyLedgerEntry(conn, {
        userId: String(reg.user_id), op: 'UNFREEZE', amountCent: amount,
        bizType: 'REFUND', bizId: id, originTxnId: null, operatorId: actorId, remark: '取消报名退款',
      });
      txnId = back.txnId;
      const fee = frozen - amount;
      if (fee > 0) {
        await applyLedgerEntry(conn, {
          userId: String(reg.user_id), op: 'SETTLE', amountCent: fee,
          bizType: 'REGISTRATION', bizId: String(reg.id), operatorId: actorId, remark: '退款手续费结算',
        });
      }
    }
    // 资金口径（2026-11-13）：
    //  · 会员回充：账本一落定钱就到账了，settled_* 由系统在同一事务内写入；
    //  · 非会员线下退：审核通过只代表「同意退」，钱还没出去，settled_* 必须留空，
    //    等运营实际转账后再调 settleRefund 补记。这样
    //    `status='REFUNDED' AND settled_at IS NULL` 就是「已批准、待线下退款」的挂账清单。
    const settledAt = fromBalance ? now : null;
    await conn.execute(
      `UPDATE refund_orders
          SET status = 'REFUNDED', reviewed_by = ?, reviewed_at = ?, balance_txn_id = ?,
              settled_by = ?, settled_at = ?
        WHERE id = ?`,
      [actorId, now, txnId, settledAt ? actorId : null, settledAt, id],
    );
    await conn.execute(
      "UPDATE registrations SET status = 'REFUNDED', payment_status = 'REFUNDED' WHERE id = ?", [reg.id],
    );
    // 退款完成才退券：未过期可再次使用；驳回分支不退——用户仍在履约，券继续占用
    await releaseCouponOf(conn, String(reg.id));
    return id;
  });
}

/**
 * 线下退款落定：补记「钱真的退出去了」。
 *
 * 为什么单独一个动作（2026-11-13）：
 * 非会员是线下支付，审核通过只表示同意退款，实际转账发生在系统之外。原实现里
 * 这类退款单只有 status=REFUNDED，和会员回充长得一模一样，财务对账时看不出
 * 「哪些已经批准但还没退钱」。这里把资金口径单独记在 settled_* 上：
 *   · 只允许 REFUNDED 且尚未落定的单子（重复提交返回幂等成功，不报错）；
 *   · 会员单在审核时已由系统写入 settled_*，这里拒绝，避免把自动回充改成手工记录；
 *   · 不动 status，也不碰账本——账本只认资金操作，线下转账不进账本。
 */
async function settleRefund(id: string, remark: string | null, actorId: string): Promise<{ id: string; alreadySettled: boolean }> {
  return withTransaction(async (conn) => {
    const [pre] = await conn.execute<RefundRow[]>('SELECT * FROM refund_orders WHERE id = ?', [id]);
    const preRefund = pre[0];
    if (!preRefund) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    // 与审核保持同一加锁顺序：先报名、再退款单
    const [regs] = await conn.execute<RegistrationRow[]>(
      'SELECT * FROM registrations WHERE id = ? FOR UPDATE', [preRefund.registration_id],
    );
    const [rows] = await conn.execute<RefundRow[]>('SELECT * FROM refund_orders WHERE id = ? FOR UPDATE', [id]);
    const refund = rows[0];
    if (!refund) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (refund.status !== 'REFUNDED') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '只有已通过的退款单才能登记线下退款完成');
    }
    if (refund.settled_at) return { id, alreadySettled: true };
    const reg = regs[0];
    // 会员单的资金在审核事务里就落定了，走到这里说明数据异常或前端状态过期
    if (reg && reg.payment_status === 'NOT_REQUIRED' && refund.balance_txn_id) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '该退款为积分回充，资金已自动落定，无需登记线下退款');
    }
    await conn.execute(
      'UPDATE refund_orders SET settled_by = ?, settled_at = ?, settle_remark = ? WHERE id = ?',
      [actorId, toSqlDateTime(), remark, id],
    );
    return { id, alreadySettled: false };
  });
}

export function mountBalance(app: Express): void {
  const pub = Router();
  pub.use(authenticate);

  pub.get('/', asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT a.*,
         (SELECT COALESCE(SUM(t.amount_cent), 0) FROM balance_transactions t
           WHERE t.account_user_id = a.user_id AND t.biz_type = 'BONUS' AND t.direction = 'IN') AS bonus_granted_cent
       FROM balance_accounts a WHERE a.user_id = ?`,
      [identity.userId],
    );
    // 仅 VIP/SVIP 有账户；普通用户返回 applicable=false，前端据此隐藏余额区块
    sendOk(res, {
      applicable: Boolean(rows[0]),
      account: rows[0] ? balanceAccountDtoOf(rows[0]) : null,
    });
  }));

  pub.get('/transactions', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM balance_transactions WHERE account_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [identity.userId, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM balance_transactions WHERE account_user_id = ?', [identity.userId],
    );
    sendOk(res, paginatedOf(rows.map(balanceTxnDtoOf), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  const refunds = Router();
  refunds.use(authenticate);
  refunds.get('/mine', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM refund_orders WHERE requested_by = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [identity.userId, pageSize, offset],
    );
    sendOk(res, paginatedOf(rows.map(refundDtoOf), rows.length, page, pageSize));
  }));
  refunds.get('/:id', asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM refund_orders WHERE id = ?', [req.params.id]);
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (String(row.requested_by) !== identity.userId) throw new AppError(BIZ_CODES.RESOURCE_NOT_OWNED);
    sendOk(res, refundDtoOf(row));
  }));

  const admin = Router();
  admin.use(authenticate);

  admin.get('/refunds', requireCapabilities('admin:refund:review'), validateQuery(adminRefundListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { status, settle, keyword, dateFrom, dateTo } = req.query as AdminRefundListQuery;
    // 退款单只增不减，筛选必须下推 SQL；关键词要匹配申请人/场次/时段，COUNT 也得带同样的 JOIN
    const conds: string[] = [];
    const params: string[] = [];
    if (status) { conds.push('r.status = ?'); params.push(status); }
    if (settle === 'UNSETTLED') conds.push("r.status = 'REFUNDED' AND r.settled_at IS NULL");
    if (settle === 'SETTLED') conds.push('r.settled_at IS NOT NULL');
    const kw = (keyword ?? '').trim();
    if (kw) {
      conds.push('(u.wechat_id LIKE ? OR u.nickname LIKE ? OR e.title LIKE ? OR s.label LIKE ? OR CAST(r.registration_id AS CHAR) LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    // 申请时间范围：本地自然日 → UTC 半开区间（end 用次日零点配 `<`）
    const range = localDayRangeUtc(dateFrom, dateTo);
    if (range.start) { conds.push('r.created_at >= ?'); params.push(range.start); }
    if (range.end) { conds.push('r.created_at < ?'); params.push(range.end); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const joinSql = `
         FROM refund_orders r
         LEFT JOIN users u ON u.id = r.requested_by
         LEFT JOIN registrations reg ON reg.id = r.registration_id
         LEFT JOIN events e ON e.id = reg.event_id
         LEFT JOIN event_sessions s ON s.id = reg.session_id`;
    // 带出申请人与报名对应的场次 / 时段：审核时要判断是哪场活动、哪个时段
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT r.*, u.wechat_id AS requester_wechat_id, u.nickname AS requester_nickname,
              reg.event_id AS event_id, e.title AS event_title,
              reg.session_id AS session_id, s.label AS session_label,
              s.start_at AS session_start_at, s.end_at AS session_end_at,
              reg.payment_status AS reg_payment_status
       ${joinSql}
       ${where}
        ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total ${joinSql} ${where}`, params,
    );
    // 两个角标是全局口径，不能被当前页/当前筛选影响，单独聚合
    const [totals] = await pool.execute<RowDataPacket[]>(
      `SELECT SUM(CASE WHEN status = 'REQUESTED' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'REFUNDED' AND settled_at IS NULL THEN 1 ELSE 0 END) AS unsettled
         FROM refund_orders`,
    );
    const result = paginatedOf(rows.map(refundDtoOf), Number(counts[0]?.total ?? 0), page, pageSize);
    // 待审核数量单独带出，概览与页签角标都用它，避免前端把"总数"当"待审核"
    // unsettledTotal：已批准但线下还没退钱的挂账数（对账口径，2026-11-13）
    sendOk(res, {
      ...result,
      pendingTotal: Number(totals[0]?.pending ?? 0),
      unsettledTotal: Number(totals[0]?.unsettled ?? 0),
    });
  }));

  admin.post('/refunds/:id/review', requireCapabilities('admin:refund:review'), validateBody(refundReviewSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as RefundReviewPayload;
    const id = await reviewRefund(req.params.id, payload, identity.userId);
    await auditOf(res)?.({
      action: 'REFUND_REVIEW', targetType: 'refund', targetId: id,
      after: { approve: payload.approve, remark: payload.remark ?? null }, actorId: identity.userId,
    });
    sendOk(res, { id });
  }));

  /**
   * 线下退款实际完成：补记经办人与时间。
   * 会员单在审核时已自动落定，这里会拒绝；重复提交按幂等成功返回。
   */
  admin.post('/refunds/:id/settle', requireCapabilities('admin:refund:review'), validateBody(refundSettleSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as RefundSettlePayload;
    const result = await settleRefund(req.params.id, payload.remark ?? null, identity.userId);
    if (!result.alreadySettled) {
      await auditOf(res)?.({
        action: 'REFUND_SETTLE', targetType: 'refund', targetId: result.id,
        after: { remark: payload.remark ?? null, settledBy: identity.userId }, actorId: identity.userId,
      });
    }
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM refund_orders WHERE id = ?', [result.id]);
    sendOk(res, rows[0] ? refundDtoOf(rows[0]) : { id: result.id });
  }));

  // 一步调账：提交即在同一事务内走账本入账，不再二次复核；发起/操作人留痕于 requested_by 与审计日志
  admin.post('/balance/adjustments', requireCapabilities('admin:balance:adjust:request'), validateBody(balanceAdjustmentSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const p = req.body as BalanceAdjustmentPayload;
    const now = toSqlDateTime();
    const applied = await withTransaction(async (conn) => {
      const [users] = await conn.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1', [p.wechatId],
      );
      const userId = users[0]?.id;
      if (userId == null) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${p.wechatId}」不存在`);

      /**
       * 会员账户自动补建。
       *
       * 历史上账户只在「授予会员」的事务里创建，于是出现两类残缺数据：
       *   · 会员是早于该逻辑 / 由脚本直接写入 memberships 的 → 有会籍无账户
       *   · 账户行被清理过但会籍还在
       * 这两种情况下运营看到的都是「该用户没有积分账户（仅会员可调整积分）」，
       * 但用户明明就是会员，属于把系统内部不一致暴露给了操作者。
       *
       * 现在改为：确认对方是**有效会员**就补建账户（幂等），非会员仍拒绝。
       */
      const [accounts] = await conn.execute<RowDataPacket[]>(
        'SELECT 1 FROM balance_accounts WHERE user_id = ? LIMIT 1', [String(userId)],
      );
      if (!accounts[0]) {
        const [memberRows] = await conn.execute<RowDataPacket[]>(
          `SELECT 1 FROM memberships
            WHERE user_id = ? AND status = 'ACTIVE' AND start_at <= ? AND expire_at > ? LIMIT 1`,
          [String(userId), now, now],
        );
        if (!memberRows[0]) {
          throw new AppError(BIZ_CODES.INVALID_PARAM, '该用户不是有效会员，无法调整积分；请先授予会员资格');
        }
        // INSERT IGNORE：并发下两次调账不会互相冲突
        await conn.execute(
          `INSERT IGNORE INTO balance_accounts (user_id, available_cent, frozen_cent, version)
           VALUES (?, 0, 0, 0)`,
          [String(userId)],
        );
      }

      const [inserted] = await conn.execute<ResultSetHeader>(
        `INSERT INTO balance_adjustments
           (user_id, amount_cent, bonus_cent, reason, evidence_url, status, requested_by, reviewed_by, reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'APPLIED', ?, ?, ?, ?, ?)`,
        [String(userId), p.amountCent, p.bonusCent ?? 0, p.reason, p.evidenceUrl ?? null, identity.userId, identity.userId, now, now, now],
      );
      const id = String(inserted.insertId);
      const ledger = await applyLedgerEntry(conn, {
        userId: String(userId), op: p.amountCent > 0 ? 'CREDIT' : 'DEBIT',
        amountCent: Math.abs(p.amountCent), bizType: 'MANUAL_ADJUST', bizId: id,
        operatorId: identity.userId, remark: p.reason,
      });
      await conn.execute('UPDATE balance_adjustments SET balance_txn_id = ? WHERE id = ?', [ledger.txnId, id]);
      // 赠送积分单独记一条 BONUS 入账流水（与本金同 biz_id、不同 biz_type，唯一键不冲突）
      let availableCent = ledger.availableCent;
      if (p.bonusCent && p.bonusCent > 0) {
        const bonus = await applyLedgerEntry(conn, {
          userId: String(userId), op: 'CREDIT', amountCent: p.bonusCent,
          bizType: 'BONUS', bizId: id, idempotencyKey: `bonus:${id}`,
          operatorId: identity.userId, remark: `赠送积分：${p.reason}`,
        });
        availableCent = bonus.availableCent;
      }
      return { id, availableCent };
    });
    await auditOf(res)?.({
      action: 'BALANCE_ADJUST', targetType: 'balance_adjustment', targetId: applied.id,
      after: { wechatId: p.wechatId, amountCent: p.amountCent, bonusCent: p.bonusCent ?? 0, appliedBy: identity.userId, traceId: getTraceId() },
      actorId: identity.userId,
    });
    sendOk(res, { id: applied.id, status: 'APPLIED', availableCent: applied.availableCent }, 201);
  }));

  admin.get('/balance/transactions', requireCapabilities('admin:refund:review'), validateQuery(adminBalanceTxnListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { bizType, keyword, dateFrom, dateTo } = req.query as AdminBalanceTxnListQuery;
    // 流水只增不减：类型与关键词筛选下推 SQL，COUNT 带同样的 JOIN 与条件
    const conds: string[] = [];
    const params: string[] = [];
    if (bizType) { conds.push('t.biz_type = ?'); params.push(bizType); }
    const kw = (keyword ?? '').trim();
    if (kw) {
      conds.push('(u.wechat_id LIKE ? OR t.remark LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`);
    }
    // 流水时间范围：本地自然日 → UTC 半开区间（end 用次日零点配 `<`）
    const range = localDayRangeUtc(dateFrom, dateTo);
    if (range.start) { conds.push('t.created_at >= ?'); params.push(range.start); }
    if (range.end) { conds.push('t.created_at < ?'); params.push(range.end); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT t.*, u.wechat_id AS account_wechat_id
       FROM balance_transactions t LEFT JOIN users u ON u.id = t.account_user_id
       ${where}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM balance_transactions t LEFT JOIN users u ON u.id = t.account_user_id ${where}`,
      params,
    );
    sendOk(res, paginatedOf(rows.map(balanceTxnDtoOf), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  app.use(`${API_BASE_PATH}/balance`, pub);
  app.use(`${API_BASE_PATH}/refunds`, refunds);
  app.use(`${API_BASE_PATH}/admin`, admin);
}
