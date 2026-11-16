/**
 * 时段级回避名单（SVIP 择邻）。
 *
 * 业务前提：会员（尤其 SVIP）会提前报名占位，并希望某个具体的人**不要和自己报同一时段**。
 * 注意是「时段」不是「整场」——不在同一时段就无所谓。
 *
 * 本模块只负责运营侧的增删查：
 *   - 会员不直接操作（不向会员暴露会员目录，也避免会员之间互相设限）；
 *   - 会员的诉求由运营代为配置。
 *
 * 拦截发生在报名链路（registrations.module.ts），这里不参与判定。
 */
import { Router } from 'express';
import type { Express } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  sessionAvoidRuleCreateSchema,
  sessionAvoidRuleListQuerySchema,
  type SessionAvoidRuleCreatePayload,
  type SessionAvoidRuleDto,
  type SessionAvoidRuleListQuery,
} from '@photo/shared';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { auditOf } from '../middleware/audit';
import { validateBody, validateQuery } from '../middleware/validate';
import { sendOk } from '../utils/response';
import { toSqlDateTime } from '../utils/datetime';

const SELECT_RULES = `
  SELECT a.*, s.label AS session_label, s.event_id AS session_event_id,
         o.nickname AS owner_nickname,
         b.nickname AS blocked_nickname, b.wechat_id AS blocked_wechat_id
    FROM session_avoid_rules a
    JOIN event_sessions s ON s.id = a.session_id
    LEFT JOIN users o ON o.id = a.owner_user_id
    JOIN users b ON b.id = a.blocked_user_id
`;

function ruleDtoOf(r: RowDataPacket): SessionAvoidRuleDto {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    sessionLabel: String(r.session_label ?? ''),
    eventId: String(r.session_event_id),
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    ownerNickname: r.owner_nickname ?? null,
    blockedUserId: String(r.blocked_user_id),
    blockedNickname: String(r.blocked_nickname ?? ''),
    blockedWechatId: String(r.blocked_wechat_id ?? ''),
    note: r.note ?? null,
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function mountSessionAvoidRules(app: Express): void {
  const router = Router();
  router.use(authenticate, requireCapabilities('admin:registration:write'));

  /** 列表：按时段查；默认只返回未撤销的规则 */
  router.get('/', validateQuery(sessionAvoidRuleListQuerySchema), asyncHandler(async (req, res) => {
    const { sessionId } = req.query as SessionAvoidRuleListQuery;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `${SELECT_RULES} WHERE a.session_id = ? AND a.revoked_at IS NULL ORDER BY a.id DESC`,
      [sessionId],
    );
    sendOk(res, rows.map(ruleDtoOf));
  }));

  router.post('/', validateBody(sessionAvoidRuleCreateSchema), asyncHandler(async (req, res) => {
    const payload = req.body as SessionAvoidRuleCreatePayload;
    const actorId = getIdentity()?.userId ?? null;

    const [sessions] = await pool.execute<RowDataPacket[]>(
      'SELECT id, event_id FROM event_sessions WHERE id = ?', [payload.sessionId],
    );
    if (!sessions[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '时段不存在');

    const wantedIds = [payload.blockedUserId, ...(payload.ownerUserId ? [payload.ownerUserId] : [])];
    const [users] = await pool.execute<RowDataPacket[]>(
      // execute（预处理）不会展开数组参数，必须显式拼占位符
      `SELECT id, nickname, wechat_id FROM users
        WHERE deleted_at IS NULL AND id IN (${wantedIds.map(() => '?').join(', ')})`,
      wantedIds,
    );
    if (!users.some((u) => String(u.id) === payload.blockedUserId)) {
      throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '要回避的账号不存在');
    }
    if (payload.ownerUserId && !users.some((u) => String(u.id) === payload.ownerUserId)) {
      throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '发起回避的账号不存在');
    }

    const now = toSqlDateTime();
    // 同一时段对同一个人只保留一条：重复提交时"复活"旧规则而不是报错
    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM session_avoid_rules WHERE session_id = ? AND blocked_user_id = ?',
      [payload.sessionId, payload.blockedUserId],
    );
    let ruleId: string;
    if (existing[0]) {
      ruleId = String(existing[0].id);
      await pool.execute(
        `UPDATE session_avoid_rules
            SET owner_user_id = ?, note = ?, revoked_at = NULL, revoked_by = NULL,
                created_by = ?, created_at = ?, updated_at = ?
          WHERE id = ?`,
        [payload.ownerUserId ?? null, payload.note ?? null, actorId, now, now, ruleId],
      );
    } else {
      const [ins] = await pool.execute<ResultSetHeader>(
        `INSERT INTO session_avoid_rules
          (session_id, owner_user_id, blocked_user_id, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [payload.sessionId, payload.ownerUserId ?? null, payload.blockedUserId, payload.note ?? null, actorId, now, now],
      );
      ruleId = String(ins.insertId);
    }

    const [rows] = await pool.execute<RowDataPacket[]>(`${SELECT_RULES} WHERE a.id = ?`, [ruleId]);
    await auditOf(res)?.({
      action: 'SESSION_AVOID_RULE_UPSERT', targetType: 'session_avoid_rule', targetId: ruleId,
      after: {
        sessionId: payload.sessionId, ownerUserId: payload.ownerUserId ?? null,
        blockedUserId: payload.blockedUserId, note: payload.note ?? null,
      },
      actorId,
    });
    sendOk(res, ruleDtoOf(rows[0]!), 201);
  }));

  /** 撤销：软删除，保留「谁在什么时候解除过」的痕迹 */
  router.post('/:id/revoke', asyncHandler(async (req, res) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id, revoked_at FROM session_avoid_rules WHERE id = ?', [req.params.id],
    );
    const rule = rows[0];
    if (!rule) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '回避规则不存在');
    if (rule.revoked_at) throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '该规则已解除');

    const actorId = getIdentity()?.userId ?? null;
    await pool.execute(
      'UPDATE session_avoid_rules SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ?',
      [toSqlDateTime(), actorId, toSqlDateTime(), req.params.id],
    );
    await auditOf(res)?.({
      action: 'SESSION_AVOID_RULE_REVOKE', targetType: 'session_avoid_rule', targetId: String(req.params.id),
      actorId,
    });
    sendOk(res, { id: String(req.params.id) });
  }));

  app.use(`${API_BASE_PATH}/admin/avoid-rules`, router);
}
