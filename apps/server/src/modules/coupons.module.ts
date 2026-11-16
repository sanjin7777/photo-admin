/**
 * 优惠券：我的券包 / 后台发放 / 列表 / 作废。
 *
 * 结算逻辑不在这里：报名事务会 FOR UPDATE 锁券并按名额逐张核销，
 * 退款通过 / 场次取消时调用 releaseCouponOf 退回。
 * EXPIRED 不落库，读取时按 expires_at 动态判定。
 */
import type { Express } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  adminCouponIssueSchema,
  adminCouponListQuerySchema,
  type AdminCouponDto,
  type AdminCouponIssuePayload,
  type CouponDto,
  type CouponIssueResultDto,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireAnyCapability, requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { couponDtoOf, pageArgsOf, paginatedOf } from '../domain/dto';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

/**
 * 退回报名占用的券。
 * 只在「退款已完成」时调用：用户主动取消进入 REFUND_PENDING 时券仍被占用，
 * 驳回退款也不退券——否则用户可在退款待审期间把券用到别处，导致重复优惠。
 */
export async function releaseCouponOf(conn: PoolConnection, registrationId: string): Promise<void> {
  await conn.execute(
    "UPDATE coupons SET status = 'UNUSED', used_registration_id = NULL, used_at = NULL WHERE used_registration_id = ? AND status = 'USED'",
    [registrationId],
  );
}

export function mountCoupons(app: Express): void {
  /* ---------------- 我的券包 ---------------- */
  const mine = Router();
  mine.use(authenticate);

  mine.get('/', asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM coupons WHERE user_id = ?
        ORDER BY (status = 'UNUSED' AND (expires_at IS NULL OR expires_at > NOW(3))) DESC,
                 expires_at IS NULL, expires_at ASC, id DESC`,
      [identity.userId],
    );
    const list: CouponDto[] = rows.map(couponDtoOf);
    sendOk(res, list);
  }));

  /* ---------------- 后台：列表 / 发放 / 作废 ---------------- */
  /**
   * 只读列表单独成组。
   *
   * 动机：手动录入报名（OPERATOR，权限 admin:registration:write）时需要拉「该账号的可用券」，
   * 但发放/作废属于会员管理（admin:membership:grant，仅 ADMIN）。
   * 若共用一个组，运营在录入弹窗里永远看到「暂无可用券」而不是报错，属于静默失效。
   * 因此列表放宽为「二者任一」，写操作仍只认 membership:grant。
   */
  const adminRead = Router();
  adminRead.use(authenticate, requireAnyCapability('admin:membership:grant', 'admin:registration:write'));

  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:membership:grant'));

  adminRead.get('/', validateQuery(adminCouponListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(
      req.query as { page?: number; pageSize?: number },
    );
    const q = req.query as { status?: 'UNUSED' | 'USED' | 'EXPIRED' | 'REVOKED'; keyword?: string };
    const where: string[] = ['1 = 1'];
    const params: Array<string | number> = [];
    if (q.status === 'EXPIRED') {
      where.push("c.status = 'UNUSED' AND c.expires_at IS NOT NULL AND c.expires_at <= NOW(3)");
    } else if (q.status === 'UNUSED') {
      where.push("c.status = 'UNUSED' AND (c.expires_at IS NULL OR c.expires_at > NOW(3))");
    } else if (q.status) {
      where.push('c.status = ?');
      params.push(q.status);
    }
    if (q.keyword) {
      where.push('(u.wechat_id LIKE ? OR u.nickname LIKE ? OR c.title LIKE ?)');
      params.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const fromSql = 'FROM coupons c JOIN users u ON u.id = c.user_id';

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.*, u.wechat_id AS user_wechat_id, u.nickname AS user_nickname
       ${fromSql} ${whereSql}
       ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`, params,
    );
    const list: AdminCouponDto[] = rows.map((r) => ({
      ...couponDtoOf(r),
      userId: String(r.user_id),
      userWechatId: String(r.user_wechat_id),
      userNickname: String(r.user_nickname ?? ''),
    }));
    sendOk(res, paginatedOf(list, Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  /** 按微信号批量发券：每个用户各生成一张独立券，缺人则整批失败，不静默跳过 */
  admin.post('/', validateBody(adminCouponIssueSchema), asyncHandler(async (req, res) => {
    const payload = req.body as AdminCouponIssuePayload;
    const actorId = getIdentity()?.userId;
    if (!actorId) throw new AppError(BIZ_CODES.UNAUTHORIZED);

    const couponIds = await withTransaction(async (conn) => {
      const placeholders = payload.wechatIds.map(() => '?').join(',');
      const [users] = await conn.query<RowDataPacket[]>(
        `SELECT id, wechat_id FROM users
          WHERE wechat_id IN (${placeholders}) AND deleted_at IS NULL`,
        payload.wechatIds,
      );
      const found = new Map(users.map((u) => [String(u.wechat_id), String(u.id)]));
      const missing = payload.wechatIds.filter((w) => !found.has(w));
      if (missing.length) {
        throw new AppError(BIZ_CODES.INVALID_PARAM, `未找到以下微信号：${missing.join('、')}`);
      }

      const now = toSqlDateTime();
      const expiresAt = payload.expiresAt ? toSqlDateTime(new Date(payload.expiresAt)) : null;
      const ids: string[] = [];
      for (const wechatId of payload.wechatIds) {
        const [inserted] = await conn.execute<ResultSetHeader>(
          `INSERT INTO coupons
            (user_id, title, type, discount_bp, amount_cent, min_spend_cent, max_discount_cent,
             expires_at, status, note, issued_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', ?, ?, ?, ?)`,
          [
            found.get(wechatId)!, payload.title, payload.type,
            payload.type === 'DISCOUNT' ? payload.discountBp ?? null : null,
            payload.type === 'AMOUNT' ? payload.amountCent ?? null : null,
            payload.minSpendCent ?? 0,
            payload.type === 'DISCOUNT' ? payload.maxDiscountCent ?? null : null,
            expiresAt, payload.note ?? null, actorId, now, now,
          ],
        );
        ids.push(String(inserted.insertId));
      }
      return ids;
    });

    await auditOf(res)?.({
      action: 'COUPON_ISSUE', targetType: 'coupon', targetId: String(couponIds.length),
      after: {
        wechatIds: payload.wechatIds, title: payload.title, type: payload.type,
        discountBp: payload.discountBp ?? null, amountCent: payload.amountCent ?? null,
      },
      actorId,
    });
    const result: CouponIssueResultDto = { created: couponIds.length, couponIds };
    sendOk(res, result, 201);
  }));

  /** 作废：只有未使用的券可以作废；已使用记录必须保留以便追溯 */
  admin.post('/:id/revoke', asyncHandler(async (req, res) => {
    const [pre] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM coupons WHERE id = ?', [req.params.id],
    );
    const row = pre[0];
    if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    if (row.status !== 'UNUSED') {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '仅未使用的优惠券可以作废');
    }
    const [result] = await pool.execute<ResultSetHeader>(
      "UPDATE coupons SET status = 'REVOKED' WHERE id = ? AND status = 'UNUSED'",
      [req.params.id],
    );
    if (result.affectedRows !== 1) {
      throw new AppError(BIZ_CODES.CONCURRENCY_CONFLICT, '该券已被使用，请刷新后重试');
    }
    await auditOf(res)?.({
      action: 'COUPON_REVOKE', targetType: 'coupon', targetId: req.params.id,
      before: { status: 'UNUSED', title: row.title }, after: { status: 'REVOKED' },
    });
    sendOk(res, { id: req.params.id });
  }));

  app.use(`${API_BASE_PATH}/me/coupons`, mine);
  // 列表（读）必须先于写组挂载：同路径下 Express 按注册顺序匹配
  app.use(`${API_BASE_PATH}/admin/coupons`, adminRead);
  app.use(`${API_BASE_PATH}/admin/coupons`, admin);
}
