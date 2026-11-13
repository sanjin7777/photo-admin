/** 会员域：前台查询 + 后台授予/撤销（权限变更即时生效 + 权限日志）。 */
import type { Express, Response } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  membershipGrantSchema,
  membershipRevokeSchema,
  type CapabilitiesDto,
  type MembershipGrantPayload,
  type MembershipRevokePayload,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity, getTraceId } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { membershipDtoOf } from '../domain/dto';
import { applyLedgerEntry } from '../domain/ledger';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

const sqlTime = (iso: string): string => toSqlDateTime(new Date(iso));
/** 永久有效的内部表示：存一个足够远的日期，避免列改成 NULL 带来的连锁判断 */
const PERMANENT_EXPIRE = toSqlDateTime(new Date('9999-12-31T23:59:59Z'));

async function grant(payload: MembershipGrantPayload, actorId: string, res: Response): Promise<string> {
  const id = await withTransaction(async (conn) => {
    // 用微信号定位用户：后台人员看到的是微信号，用户 ID 不直观
    const [users] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1',
      [payload.wechatId],
    );
    const user = users[0];
    if (!user) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '该微信号不存在');
    const userId = String(user.id);

    const [active] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM memberships WHERE user_id = ? AND level = ? AND status = 'ACTIVE' LIMIT 1",
      [userId, payload.level],
    );
    if (active[0]) throw new AppError(BIZ_CODES.INVALID_PARAM, '该用户已有同等级有效会员记录');

    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO memberships
        (user_id, level, status, start_at, expire_at, source, granted_by, grant_reason, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', ?, ?, 'GRANT', ?, ?, ?, ?)`,
      [
        userId, payload.level, sqlTime(payload.startAt),
        payload.expireAt ? sqlTime(payload.expireAt) : PERMANENT_EXPIRE,
        actorId, payload.reason, toSqlDateTime(), toSqlDateTime(),
      ],
    );
    const membershipId = String(result.insertId);

    // 仅 VIP/SVIP 需要余额账户：不存在则建（0 余额），已存在保持原值
    await conn.execute(
      `INSERT INTO balance_accounts (user_id, available_cent, frozen_cent, version, updated_at)
       VALUES (?, 0, 0, 0, ?) ON DUPLICATE KEY UPDATE user_id = user_id`,
      [userId, toSqlDateTime()],
    );

    // 同步入账：金额必须走账本（FOR UPDATE + version + 唯一流水键），禁止直接改余额
    const amountCent = Math.round((payload.amountYuan ?? 0) * 100);
    if (amountCent > 0) {
      await applyLedgerEntry(conn, {
        userId, op: 'CREDIT', amountCent,
        bizType: 'MANUAL_ADJUST', bizId: `membership-grant:${membershipId}`,
        idempotencyKey: `membership-grant:${membershipId}`,
        operatorId: actorId, remark: `授予会员同步入账`,
      });
    }
    // 赠送积分单独记一条 BONUS 入账流水（与本金同 biz_id、不同 biz_type）
    const bonusCent = Math.round((payload.bonusYuan ?? 0) * 100);
    if (bonusCent > 0) {
      await applyLedgerEntry(conn, {
        userId, op: 'CREDIT', amountCent: bonusCent,
        bizType: 'BONUS', bizId: `membership-grant:${membershipId}`,
        idempotencyKey: `membership-grant-bonus:${membershipId}`,
        operatorId: actorId, remark: `授予会员赠送积分`,
      });
    }

    // 关键：sv+1 使旧 access token 立即失效，下次请求重新装载能力
    await conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [userId]);
    await conn.execute(
      `INSERT INTO permission_logs
        (actor_id, action, target_user_id, level, level_before, level_after, reason, trace_id, created_at)
       VALUES (?, 'MEMBERSHIP_GRANT', ?, ?, NULL, ?, ?, ?, ?)`,
      [actorId, userId, payload.level, payload.level, payload.reason, getTraceId(), toSqlDateTime()],
    );
    return membershipId;
  });
  await auditOf(res)?.({
    action: 'MEMBERSHIP_GRANT', targetType: 'membership', targetId: id,
    after: {
      wechatId: payload.wechatId, level: payload.level,
      expireAt: payload.expireAt ?? PERMANENT_EXPIRE,
      amountYuan: payload.amountYuan ?? 0,
      bonusYuan: payload.bonusYuan ?? 0,
    },
    actorId,
  });
  return id;
}

export function mountMemberships(app: Express): void {
  const pub = Router();
  pub.use(authenticate);

  pub.get('/mine', asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at DESC',
      [identity.userId],
    );
    sendOk(res, rows.map(membershipDtoOf));
  }));

  pub.get('/mine/privileges', asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const dto: CapabilitiesDto = {
      capabilities: [...identity.capabilities], level: identity.level,
      backendRoles: identity.backendRoles, sessionVersion: identity.sessionVersion,
      issuedAt: new Date().toISOString(),
    };
    sendOk(res, dto);
  }));

  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:membership:grant'));
  admin.post('/', validateBody(membershipGrantSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const id = await grant(req.body as MembershipGrantPayload, identity.userId, res);
    sendOk(res, { id }, 201);
  }));

  admin.post('/:id/revoke', validateBody(membershipRevokeSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as MembershipRevokePayload;
    const now = toSqlDateTime();
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM memberships WHERE id = ? FOR UPDATE', [req.params.id],
      );
      const row = rows[0];
      if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
      if (row.status !== 'ACTIVE') throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION);
      await conn.execute(
        "UPDATE memberships SET status = 'REVOKED', revoked_by = ?, revoked_at = ? WHERE id = ?",
        [identity.userId, now, req.params.id],
      );
      await conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [row.user_id]);
      await conn.execute(
        `INSERT INTO permission_logs
          (actor_id, action, target_user_id, level, level_before, level_after, reason, trace_id, created_at)
         VALUES (?, 'MEMBERSHIP_REVOKE', ?, ?, ?, 'NONE', ?, ?, ?)`,
        [identity.userId, row.user_id, row.level, row.level, payload.reason, getTraceId(), now],
      );
    });
    await auditOf(res)?.({
      action: 'MEMBERSHIP_REVOKE', targetType: 'membership', targetId: req.params.id,
      before: { status: 'ACTIVE' }, after: { status: 'REVOKED', reason: payload.reason }, actorId: identity.userId,
    });
    sendOk(res, { id: req.params.id });
  }));

  app.use(`${API_BASE_PATH}/memberships`, pub);
  app.use(`${API_BASE_PATH}/admin/memberships`, admin);
}
