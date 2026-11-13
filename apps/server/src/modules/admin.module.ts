/** 后台审计与脱敏导出。导出走字段白名单，不接受任意 SQL；开发期返回 data: URL，不接对象存储。 */
import type { Express } from 'express';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { API_BASE_PATH, AppError, BIZ_CODES, adminCreateUserSchema, adminResetPasswordSchema, adminUpdateUserSchema, adminUserListQuerySchema, auditLogQuerySchema, type AdminCreateUserPayload, type AdminResetPasswordPayload, type AdminUpdateUserPayload } from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity, getTraceId } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { auditDtoOf, pageArgsOf, paginatedOf, permissionLogDtoOf } from '../domain/dto';
import { hashPassword } from '../utils/password';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

/** 白名单：字段名固定，不含手机号、邮箱、联系方式、密码哈希、before/after 明细 */
const EXPORT_TARGETS: Readonly<Record<string, { sql: string; columns: readonly string[] }>> = {
  registrations: {
    sql: 'SELECT id, event_id, user_id, status, fee_cent, created_at FROM registrations ORDER BY created_at DESC LIMIT 5000',
    columns: ['id', 'event_id', 'user_id', 'status', 'fee_cent', 'created_at'],
  },
  refunds: {
    // 带上 settled_at：导出退款台账时要能一眼分出「已批准待线下退款」的挂账单
    sql: 'SELECT id, registration_id, amount_cent, status, settled_at, created_at FROM refund_orders ORDER BY created_at DESC LIMIT 5000',
    columns: ['id', 'registration_id', 'amount_cent', 'status', 'settled_at', 'created_at'],
  },
  balance_transactions: {
    sql: 'SELECT id, account_user_id, direction, amount_cent, biz_type, created_at FROM balance_transactions ORDER BY created_at DESC LIMIT 5000',
    columns: ['id', 'account_user_id', 'direction', 'amount_cent', 'biz_type', 'created_at'],
  },
  audit_logs: {
    sql: 'SELECT id, actor_id, action, target_type, target_id, trace_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5000',
    columns: ['id', 'actor_id', 'action', 'target_type', 'target_id', 'trace_id', 'created_at'],
  },
};

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: readonly string[], rows: RowDataPacket[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n');
}

export function mountAdmin(app: Express): void {
  const router = Router();
  router.use(authenticate);

  // 会员管理页的数据源：只暴露运营需要的字段，联系方式不返回
  router.get('/users', requireCapabilities('admin:membership:grant'), validateQuery(adminUserListQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const q = req.query as { keyword?: string; level?: 'NONE' | 'VIP' | 'SVIP' };
    const keyword = (q.keyword ?? '').trim();
    const level = q.level ?? '';

    const where: string[] = [
      'u.deleted_at IS NULL',
      // 运维账号不出现在用户列表里，也不允许在后台被改
      "NOT EXISTS (SELECT 1 FROM admin_roles x WHERE x.user_id = u.id AND x.role = 'SUPER_ADMIN')",
    ];
    const params: Array<string | number> = [];
    if (keyword) {
      where.push('(u.wechat_id LIKE ? OR u.nickname LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (level === 'VIP' || level === 'SVIP' || level === 'NONE') {
      if (level === 'NONE') where.push('m.level IS NULL');
      else { where.push('m.level = ?'); params.push(level); }
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const joinSql = `
      FROM users u
      LEFT JOIN memberships m
        ON m.user_id = u.id AND m.status = 'ACTIVE' AND m.expire_at > NOW(3)
      LEFT JOIN balance_accounts b ON b.user_id = u.id
      LEFT JOIN admin_roles ar ON ar.user_id = u.id
      LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
      LEFT JOIN (
        SELECT account_user_id, SUM(amount_cent) AS bonus_cent
        FROM balance_transactions WHERE biz_type = 'BONUS' AND direction = 'IN'
        GROUP BY account_user_id
      ) bt ON bt.account_user_id = u.id`;

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.wechat_id, u.nickname, u.status, u.created_at,
              m.level AS m_level, m.expire_at AS m_expire,
              b.available_cent, bt.bonus_cent,
              ic.code AS invite_code,
              GROUP_CONCAT(ar.role) AS roles
       ${joinSql}
       ${whereSql}
       GROUP BY u.id, u.wechat_id, u.nickname, u.status, u.created_at, m.level, m.expire_at,
                b.available_cent, bt.bonus_cent, ic.code
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT u.id) AS total ${joinSql} ${whereSql}`,
      params,
    );

    const toIso = (v: unknown): string | null =>
      v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null;

    sendOk(res, paginatedOf(
      rows.map((r) => ({
        id: String(r.id),
        wechatId: r.wechat_id,
        nickname: r.nickname,
        level: (r.m_level ?? 'NONE') as 'NONE' | 'VIP' | 'SVIP',
        levelExpireAt: toIso(r.m_expire),
        roles: String(r.roles ?? '').split(',').filter(Boolean),
        balanceCent: r.available_cent == null ? null : Number(r.available_cent),
        bonusGrantedCent: Number(r.bonus_cent ?? 0),
        invitedByCode: r.invite_code == null ? null : String(r.invite_code),
        status: (r.status === 'FROZEN' ? 'FROZEN' : 'ACTIVE') as 'ACTIVE' | 'FROZEN',
        createdAt: toIso(r.created_at) ?? new Date().toISOString(),
      })),
      Number(counts[0]?.total ?? 0),
      page,
      pageSize,
    ));
  }));

  // 后台创建用户（代注册 / 补录）：可同时设会员等级、初始余额与后台角色；不授予运维角色
  router.post('/users', requireCapabilities('admin:membership:grant'), validateBody(adminCreateUserSchema), asyncHandler(async (req, res) => {
    const p = req.body as AdminCreateUserPayload;
    const actorId = getIdentity()?.userId ?? null;
    const sqlNow = toSqlDateTime();

    const [dup] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE wechat_id = ? LIMIT 1', [p.wechatId],
    );
    if (dup[0]) throw new AppError(BIZ_CODES.INVALID_PARAM, `微信号「${p.wechatId}」已被注册`);

    const passwordHash = await hashPassword(p.password);
    const balanceCent = Math.round((p.balanceYuan ?? 0) * 100);
    const bonusCent = Math.round((p.bonusYuan ?? 0) * 100);
    const totalCent = balanceCent + bonusCent;
    const expireIso = p.level === 'NONE'
      ? null
      // 不填有效期即永久有效，用远期日期表示（与会员表 expire_at NOT NULL 兼容）
      : p.expireAt ?? '9999-12-31T23:59:59.000Z';

    const newId = await withTransaction(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO users (wechat_id, nickname, password_hash, status, session_version, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        [p.wechatId, p.nickname, passwordHash, sqlNow, sqlNow],
      );
      const id = String(result.insertId);

      for (const role of p.roles ?? []) {
        await conn.execute(
          'INSERT INTO admin_roles (user_id, role, created_at) VALUES (?, ?, ?)',
          [id, role, sqlNow],
        );
      }

      if (p.level !== 'NONE' && expireIso) {
        await conn.execute(
          `INSERT INTO memberships (user_id, level, status, start_at, expire_at, source, granted_by, grant_reason, created_at, updated_at)
           VALUES (?, ?, 'ACTIVE', ?, ?, 'GRANT', ?, '后台创建用户', ?, ?)`,
          [id, p.level, sqlNow, toSqlDateTime(new Date(expireIso)), actorId, sqlNow, sqlNow],
        );
      }

      if (totalCent > 0) {
        await conn.execute(
          'INSERT INTO balance_accounts (user_id, available_cent, frozen_cent, version, updated_at) VALUES (?, ?, 0, 0, ?)',
          [id, totalCent, sqlNow],
        );
        // 初始积分与赠送积分各记一笔流水，便于对账时解释来源；赠送单独标 BONUS
        if (balanceCent > 0) {
          await conn.execute(
            `INSERT INTO balance_transactions
               (account_user_id, direction, amount_cent, balance_after_cent, biz_type, biz_id,
                origin_txn_id, idempotency_key, operator_id, remark, created_at)
             VALUES (?, 'IN', ?, ?, 'MANUAL_ADJUST', ?, NULL, ?, ?, '后台创建用户初始积分', ?)`,
            [id, balanceCent, balanceCent, `admin-create:${id}`, `admin-create:${id}`, actorId, sqlNow],
          );
        }
        if (bonusCent > 0) {
          await conn.execute(
            `INSERT INTO balance_transactions
               (account_user_id, direction, amount_cent, balance_after_cent, biz_type, biz_id,
                origin_txn_id, idempotency_key, operator_id, remark, created_at)
             VALUES (?, 'IN', ?, ?, 'BONUS', ?, NULL, ?, ?, '后台创建用户赠送积分', ?)`,
            [id, bonusCent, totalCent, `admin-create:${id}`, `admin-create-bonus:${id}`, actorId, sqlNow],
          );
        }
      }
      return id;
    });

    await auditOf(res)?.({
      action: 'USER_CREATE', targetType: 'user', targetId: newId,
      after: { wechatId: p.wechatId, level: p.level, roles: p.roles, balanceCent, bonusCent },
    });

    sendOk(res, {
      id: newId,
      wechatId: p.wechatId,
      nickname: p.nickname,
      level: p.level,
      levelExpireAt: expireIso,
      roles: p.roles ?? [],
      balanceCent: totalCent > 0 ? totalCent : null,
      bonusGrantedCent: bonusCent,
      invitedByCode: null,
      status: 'ACTIVE' as const,
      createdAt: new Date().toISOString(),
    }, 201);
  }));

  /**
   * 编辑用户：昵称、账号状态、会员等级与有效期、后台角色。
   * 微信号是登录标识，不允许改；运维账号在后台完全只读（连改昵称都不给）。
   */
  router.patch('/users/:id', requireCapabilities('admin:membership:grant'), validateBody(adminUpdateUserSchema), asyncHandler(async (req, res) => {
    const id = req.params.id;
    const p = req.body as AdminUpdateUserPayload;
    const actorId = getIdentity()?.userId ?? null;
    const sqlNow = toSqlDateTime();
    /** 永久有效的内部表示：存一个足够远的日期，避免列改成 NULL 带来的连锁判断 */
    const PERMANENT = toSqlDateTime(new Date('9999-12-31T23:59:59Z'));

    const [target] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id],
    );
    if (!target[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, '用户不存在');

    const [isSuper] = await pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM admin_roles WHERE user_id = ? AND role = 'SUPER_ADMIN' LIMIT 1", [id],
    );
    if (isSuper[0]) throw new AppError(BIZ_CODES.FORBIDDEN, '系统账号不可在后台修改');

    await withTransaction(async (conn) => {
      if (p.nickname !== undefined || p.status !== undefined) {
        await conn.execute(
          `UPDATE users SET nickname = COALESCE(?, nickname),
             status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
          [p.nickname ?? null, p.status ?? null, sqlNow, id],
        );
      }

      if (p.level !== undefined || p.expireAt !== undefined) {
        // 先把现有 ACTIVE 记录收掉，再按目标等级重建，避免出现两条有效会员
        await conn.execute(
          "UPDATE memberships SET status = 'REVOKED', updated_at = ? WHERE user_id = ? AND status = 'ACTIVE'",
          [sqlNow, id],
        );
        const currentLevel = (await conn.execute<RowDataPacket[]>(
          'SELECT level FROM memberships WHERE user_id = ? ORDER BY id DESC LIMIT 1', [id],
        ))[0][0]?.level as string | undefined;
        const nextLevel = p.level ?? (currentLevel === 'VIP' || currentLevel === 'SVIP' ? currentLevel : 'NONE');

        if (nextLevel !== 'NONE') {
          await conn.execute(
            `INSERT INTO memberships (user_id, level, status, start_at, expire_at, source, granted_by, grant_reason, created_at, updated_at)
             VALUES (?, ?, 'ACTIVE', ?, ?, 'GRANT', ?, '后台编辑用户', ?, ?)`,
            [id, nextLevel, sqlNow,
              p.expireAt ? toSqlDateTime(new Date(p.expireAt)) : PERMANENT,
              actorId, sqlNow, sqlNow],
          );
          await conn.execute(
            `INSERT INTO balance_accounts (user_id, available_cent, frozen_cent, version, updated_at)
             VALUES (?, 0, 0, 0, ?) ON DUPLICATE KEY UPDATE user_id = user_id`,
            [id, sqlNow],
          );
        }
      }

      if (p.roles !== undefined) {
        // 只清理可授予角色，运维账号记录不动（正常也进不到这里）
        await conn.execute("DELETE FROM admin_roles WHERE user_id = ? AND role <> 'SUPER_ADMIN'", [id]);
        for (const role of p.roles) {
          await conn.execute(
            'INSERT INTO admin_roles (user_id, role, created_at) VALUES (?, ?, ?)', [id, role, sqlNow],
          );
        }
      }

      // 等级或角色变了，旧 token 必须失效，下次请求重新装载能力
      await conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [id]);
    });

    await auditOf(res)?.({ action: 'USER_UPDATE', targetType: 'user', targetId: id, after: p });
    sendOk(res, { id });
  }));

  /**
   * 重置密码：仅管理员 / 运维账号（admin:user:reset-password）。
   * 用微信账号定位；生成随机临时口令一次性返回，旧会话立即失效；运维账号不可在后台重置。
   */
  router.post('/users/reset-password', requireCapabilities('admin:user:reset-password'), validateBody(adminResetPasswordSchema), asyncHandler(async (req, res) => {
    const p = req.body as AdminResetPasswordPayload;
    const actorId = getIdentity()?.userId ?? null;
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1', [p.wechatId],
    );
    if (!rows[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${p.wechatId}」不存在`);
    const id = String(rows[0].id);

    const [isSuper] = await pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM admin_roles WHERE user_id = ? AND role = 'SUPER_ADMIN' LIMIT 1", [id],
    );
    if (isSuper[0]) throw new AppError(BIZ_CODES.FORBIDDEN, '系统账号不可在后台重置密码');

    // 保证含字母与数字、长度达标；base64url 无易混淆填充符
    const temporaryPassword = `Aw1${randomBytes(8).toString('base64url')}`;
    const passwordHash = await hashPassword(temporaryPassword);
    await pool.execute(
      'UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?',
      [passwordHash, toSqlDateTime(), id],
    );

    await auditOf(res)?.({
      action: 'USER_PASSWORD_RESET', targetType: 'user', targetId: id,
      after: { wechatId: p.wechatId, resetBy: actorId }, actorId: actorId ?? undefined,
    });
    sendOk(res, { wechatId: p.wechatId, temporaryPassword });
  }));

  router.get('/audit-logs', requireCapabilities('admin:audit:read'), validateQuery(auditLogQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { action, keyword } = req.query as { action?: string; keyword?: string };
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (action) { where.push('a.action = ?'); params.push(action); }
    if (keyword) {
      const like = `%${keyword}%`;
      where.push('(u.wechat_id LIKE ? OR a.action LIKE ? OR a.target_type LIKE ? OR CAST(a.target_id AS CHAR) LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT a.*, u.wechat_id AS actor_wechat_id FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${whereSql}`,
      params,
    );
    sendOk(res, paginatedOf(rows.map(auditDtoOf), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  // 权限日志比审计日志更敏感（谁被授予/撤销了什么），单独一个能力，仅运维账号可用
  router.get('/permission-logs', requireCapabilities('admin:permission:log:read'), validateQuery(auditLogQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const { action, keyword } = req.query as { action?: string; keyword?: string };
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (action) { where.push('p.action = ?'); params.push(action); }
    if (keyword) {
      const like = `%${keyword}%`;
      where.push('(u.wechat_id LIKE ? OR t.wechat_id LIKE ? OR p.action LIKE ? OR CAST(p.target_user_id AS CHAR) LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joins = 'FROM permission_logs p LEFT JOIN users u ON u.id = p.actor_id LEFT JOIN users t ON t.id = p.target_user_id';
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT p.*, u.wechat_id AS actor_wechat_id ${joins} ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total ${joins} ${whereSql}`, params);
    // 原来用 rows.length 当总数，翻页时永远只有一页
    sendOk(res, paginatedOf(rows.map(permissionLogDtoOf), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  router.post('/exports', requireCapabilities('admin:export'), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const target = (req.body ?? {}) as { target?: unknown };
    const spec = typeof target.target === 'string' ? EXPORT_TARGETS[target.target] : undefined;
    if (!spec) throw new AppError(BIZ_CODES.INVALID_PARAM, '不支持的导出目标');
    const [rows] = await pool.execute<RowDataPacket[]>(spec.sql);
    const csv = toCsv(spec.columns, rows);
    const url = `data:text/csv;charset=utf-8;base64,${Buffer.from(csv, 'utf8').toString('base64')}`;
    await auditOf(res)?.({
      action: 'DATA_EXPORT', targetType: 'export', targetId: target.target as string,
      after: { rows: rows.length, columns: spec.columns.length, masked: true }, actorId: identity.userId,
    });
    sendOk(res, { url, traceId: getTraceId() });
  }));

  app.use(`${API_BASE_PATH}/admin`, router);
}
