/**
 * 认证服务：注册 / 登录 / refresh 轮换 / 登出。
 *
 * 安全要点：
 * - access token 只含 uid + sv（见 jwt.ts），能力由 loadIdentity 每次实时装载；
 * - refresh token 为高熵不透明串，DB 只存 SHA-256 哈希；
 * - 同 family 轮换；已 ROTATED/REVOKED 的 token 再次出现 => 判定重放，
 *   撤销整个 family 并让 session_version +1，使该用户所有 access token 立即失效；
 * - 连续 5 次密码错误锁 15 分钟；注册仅做格式与唯一性校验，不代表实名认证。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  AppError,
  BIZ_CODES,
  LEGAL_VERSION,
  type ChangePasswordPayload,
  type LoginPayload,
  type LoginResultDto,
  type RefreshResultDto,
  type RegisterPayload,
  type UserDto,
} from '@photo/shared';
import { env } from '../../config/env';
import { pool, withTransaction } from '../../db/pool';
import { loadIdentity, type Identity } from '../../db/identity';
import { addDays, addSeconds, isPast, toSqlDateTime } from '../../utils/datetime';
import { hashPassword, verifyPassword } from '../../utils/password';
import { recordAudit } from '../../middleware/audit';
import { loginLimiter } from '../../domain/rate-limit';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../utils/cookies';
import { signAccessToken } from './jwt';

/** 登录/刷新统一通过 Set-Cookie 下发，token 绝不出现在响应体 */
function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const secure = env.NODE_ENV === 'production';
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true, secure, sameSite: 'lax', path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
  });
}

function clearAuthCookies(res: Response): void {
  const secure = env.NODE_ENV === 'production';
  const opts = { httpOnly: true, secure, path: '/' } as const;
  res.clearCookie(ACCESS_COOKIE, { ...opts, sameSite: 'lax' });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: '/api/v1/auth', sameSite: 'strict' });
}

interface UserRow extends RowDataPacket {
  id: string;
  wechat_id: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  password_hash: string;
  status: 'ACTIVE' | 'FROZEN';
  session_version: number;
  must_change_password: number;
  login_failed_count: number;
  locked_until: string | null;
}

interface RefreshRow extends RowDataPacket {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  status: 'ACTIVE' | 'ROTATED' | 'REVOKED';
  expires_at: string;
  session_version: number;
}

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${(name ?? '').slice(0, 2)}***@${domain ?? ''}`;
}

/** 输出 DTO 一律脱敏；邮箱原文只在服务端内部使用 */
export function toUserDto(identity: Identity): UserDto {
  return {
    id: identity.userId,
    wechatId: identity.wechatId,
    nickname: identity.nickname,
    avatarUrl: identity.avatarUrl,
    status: identity.status,
    level: identity.level,
    backendRoles: identity.backendRoles,
    sessionVersion: identity.sessionVersion,
    emailMasked: identity.email ? maskEmail(identity.email) : null,
    mustChangePassword: identity.mustChangePassword,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

async function userDtoOf(userId: string): Promise<UserDto> {
  const identity = await loadIdentity(userId);
  if (!identity) throw new AppError(BIZ_CODES.INTERNAL_ERROR, '用户初始化失败');
  return toUserDto(identity);
}

/**
 * 注册：必须携带一个未使用的邀请码。
 *
 * 一码一次性的保证：事务内 `SELECT ... FOR UPDATE` 锁住邀请码行 +
 * `WHERE status='UNUSED'` 的条件 UPDATE（affectedRows 必须为 1）。
 * 任一环节失败整笔事务回滚，用户与邀请码都不会留下半成品数据。
 * 用户的 invite_code_id 冗余保存邀请码 ID，便于追踪「谁由哪个邀请码创建」。
 *
 * 合规：注册必须主动勾选同意协议（schema 层强制 true），同意记录与用户在同一事务写入，
 * 保留 IP / UA 便于举证；协议正文更新时版本号递增，老同意不被视为对新版本的同意。
 */
export async function register(
  payload: RegisterPayload,
  meta: { ip?: string | null; ua?: string | null } = {},
): Promise<UserDto> {
  const passwordHash = await hashPassword(payload.password);
  const now = toSqlDateTime();
  let userId: string;
  try {
    userId = await withTransaction(async (conn) => {
      // 1) 锁邀请码行，判断状态与有效期
      const [codeRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status,
                (expires_at IS NOT NULL AND expires_at <= NOW(3)) AS is_expired
           FROM invite_codes WHERE code = ? FOR UPDATE`,
        [payload.inviteCode],
      );
      const invite = codeRows[0];
      if (!invite || invite.status === 'REVOKED') {
        throw new AppError(BIZ_CODES.INVITE_CODE_INVALID);
      }
      if (invite.status === 'USED') throw new AppError(BIZ_CODES.INVITE_CODE_USED);
      if (Number(invite.is_expired) === 1) throw new AppError(BIZ_CODES.INVITE_CODE_EXPIRED);

      // 2) 微信号是唯一登录标识：应用层预检 + uk_wechat_id 唯一索引兜底
      const [existing] = await conn.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE wechat_id = ? LIMIT 1', [payload.wechatId],
      );
      if (existing[0]) throw new AppError(BIZ_CODES.INVALID_PARAM, '该微信号已被注册');

      // 3) 创建用户，并把邀请码来源一并落库
      //    手机号已按 2026-11-10 用户决策移除采集，phone 列保留但恒为 NULL（兼容历史数据）
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO users
           (wechat_id, nickname, password_hash, invite_code_id, status, session_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        [payload.wechatId, payload.nickname, passwordHash, invite.id, now, now],
      );
      const newUserId = String(result.insertId);

      // 4) 条件消费邀请码；并发下受影响行数不为 1 说明已被别人用掉，回滚注册
      const [consumed] = await conn.execute<ResultSetHeader>(
        `UPDATE invite_codes SET status = 'USED', used_by = ?, used_at = NOW(3)
          WHERE id = ? AND status = 'UNUSED'`,
        [newUserId, invite.id],
      );
      if (consumed.affectedRows !== 1) throw new AppError(BIZ_CODES.INVITE_CODE_USED);

      // 5) 同意留痕：与注册同事务，避免「用户建了但没留下同意记录」
      const ip = meta.ip ?? null;
      const ua = meta.ua ? meta.ua.slice(0, 255) : null;
      await conn.execute(
        `INSERT IGNORE INTO user_consents (user_id, agreement_type, version, ip, ua)
         VALUES (?, 'TERMS', ?, ?, ?), (?, 'PRIVACY', ?, ?, ?)`,
        [newUserId, LEGAL_VERSION, ip, ua, newUserId, LEGAL_VERSION, ip, ua],
      );

      // 仅 VIP/SVIP 需要余额账户；注册不创建，避免普通用户看到 0 积分
      return newUserId;
    });
  } catch (error: unknown) {
    if (isDuplicateKey(error)) throw new AppError(BIZ_CODES.INVALID_PARAM, '该微信号已被注册');
    throw error;
  }
  return userDtoOf(userId);
}

export async function login(payload: LoginPayload, res: Response): Promise<LoginResultDto> {
  // 按账号维度限流（开发期内存令牌桶，上线换 Redis）；与 DB 的失败次数锁定形成双层防暴破
  if (!loginLimiter.take(`wechat:${payload.wechatId}`)) {
    throw new AppError(BIZ_CODES.LOGIN_TOO_MANY_ATTEMPTS);
  }
  const [rows] = await pool.execute<UserRow[]>(
    'SELECT * FROM users WHERE wechat_id = ? AND deleted_at IS NULL LIMIT 1',
    [payload.wechatId],
  );
  const user = rows[0];
  if (!user) throw new AppError(BIZ_CODES.INVALID_CREDENTIALS);

  const now = new Date();
  const nowSql = toSqlDateTime(now);
  if (user.locked_until && !isPast(user.locked_until, now)) {
    throw new AppError(BIZ_CODES.LOGIN_TOO_MANY_ATTEMPTS);
  }

  const matched = await verifyPassword(payload.password, user.password_hash);
  if (!matched) {
    const failed = Number(user.login_failed_count) + 1;
    const lockedUntil = failed >= 5 ? toSqlDateTime(addSeconds(now, 15 * 60)) : null;
    await pool.execute(
      'UPDATE users SET login_failed_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
      [failed, lockedUntil, nowSql, user.id],
    );
    throw new AppError(BIZ_CODES.INVALID_CREDENTIALS);
  }

  const refreshToken = newRefreshToken();
  const familyId = randomUUID();
  const expiresAt = toSqlDateTime(addDays(now, env.REFRESH_TOKEN_TTL_DAYS));

  await withTransaction(async (conn) => {
    await conn.execute(
      "UPDATE users SET login_failed_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?",
      [nowSql, nowSql, user.id],
    );
    await conn.execute(
      `INSERT INTO refresh_sessions
        (user_id, token_hash, family_id, status, expires_at, session_version, created_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        user.id,
        hashRefreshToken(refreshToken),
        familyId,
        expiresAt,
        Number(user.session_version),
        nowSql,
      ],
    );
  });

  const identity = await loadIdentity(String(user.id));
  if (!identity) throw new AppError(BIZ_CODES.INTERNAL_ERROR);
  const accessToken = await signAccessToken({ uid: identity.userId, sv: identity.sessionVersion });
  void recordAudit({ action: 'LOGIN', targetType: 'user', targetId: identity.userId, actorId: identity.userId });

  setAuthCookies(res, accessToken, refreshToken);
  return { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, user: toUserDto(identity) };
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type RefreshOutcome =
  | { kind: 'reuse' }
  | { kind: 'ok'; tokens: RefreshedTokens };

export async function refresh(refreshToken: string, res: Response): Promise<RefreshResultDto> {
  const tokenHash = hashRefreshToken(refreshToken);
  const outcome = await withTransaction<RefreshOutcome>(async (conn) => {
    const [rows] = await conn.execute<RefreshRow[]>(
      'SELECT * FROM refresh_sessions WHERE token_hash = ? FOR UPDATE',
      [tokenHash],
    );
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.TOKEN_EXPIRED);

    // 重放检测：撤销动作必须在事务内提交，因此返回结果而非直接抛错
    if (row.status === 'ROTATED' || row.status === 'REVOKED') {
      await conn.execute("UPDATE refresh_sessions SET status = 'REVOKED' WHERE family_id = ?", [
        row.family_id,
      ]);
      await conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [
        row.user_id,
      ]);
      return { kind: 'reuse' };
    }
    if (isPast(row.expires_at)) throw new AppError(BIZ_CODES.TOKEN_EXPIRED);

    const [userRows] = await conn.execute<UserRow[]>(
      'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [row.user_id],
    );
    const user = userRows[0];
    if (!user || user.status === 'FROZEN') throw new AppError(BIZ_CODES.UNAUTHORIZED);

    const nextToken = newRefreshToken();
    const nowSql = toSqlDateTime();
    await conn.execute("UPDATE refresh_sessions SET status = 'ROTATED', rotated_at = ? WHERE id = ?", [
      nowSql,
      row.id,
    ]);
    await conn.execute(
      `INSERT INTO refresh_sessions
        (user_id, token_hash, family_id, status, expires_at, session_version, created_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        row.user_id,
        hashRefreshToken(nextToken),
        row.family_id,
        toSqlDateTime(addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS)),
        Number(user.session_version),
        nowSql,
      ],
    );
    const accessToken = await signAccessToken({
      uid: String(user.id),
      sv: Number(user.session_version),
    });
    return {
      kind: 'ok',
      tokens: { accessToken, refreshToken: nextToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS },
    };
  });

  // 严格轮换模式：旧 token 一旦重用即视为盗用（无宽限期）。
  // 若需容忍网络重试导致的合法重复提交，可在模块 6 加 10s 宽限窗口。
  if (outcome.kind === 'reuse') throw new AppError(BIZ_CODES.TOKEN_REPLAYED);
  setAuthCookies(res, outcome.tokens.accessToken, outcome.tokens.refreshToken);
  return { expiresIn: outcome.tokens.expiresIn };
}

/**
 * 本人修改密码：
 * - 必须验证当前密码（导入账号的初始口令也在此校验）；
 * - 成功后 session_version +1：其它设备的 access/refresh 全部立即失效；
 * - 当前设备在同一事务里换发新的 refresh 会话与 access Cookie，避免改密后被踢下线；
 * - 清 must_change_password，解除强制改密拦截。
 */
export async function changePassword(
  userId: string,
  payload: ChangePasswordPayload,
  res: Response,
): Promise<UserDto> {
  const [rows] = await pool.execute<UserRow[]>(
    'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [userId],
  );
  const user = rows[0];
  if (!user) throw new AppError(BIZ_CODES.UNAUTHORIZED);
  if (!(await verifyPassword(payload.oldPassword, user.password_hash))) {
    throw new AppError(BIZ_CODES.INVALID_CREDENTIALS, '当前密码不正确');
  }
  if (await verifyPassword(payload.newPassword, user.password_hash)) {
    throw new AppError(BIZ_CODES.INVALID_PARAM, '新密码不能与当前密码相同');
  }

  const passwordHash = await hashPassword(payload.newPassword);
  const refreshToken = newRefreshToken();
  const familyId = randomUUID();
  const now = new Date();
  const nowSql = toSqlDateTime(now);

  await withTransaction(async (conn) => {
    const [locked] = await conn.execute<RowDataPacket[]>(
      'SELECT session_version FROM users WHERE id = ? FOR UPDATE',
      [userId],
    );
    const nextVersion = Number(locked[0]?.session_version ?? user.session_version) + 1;
    await conn.execute(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0, session_version = ?, updated_at = ?
        WHERE id = ?`,
      [passwordHash, nextVersion, nowSql, userId],
    );
    // 其它设备的会话全部失效；当前设备下面重新发一对
    await conn.execute(
      "UPDATE refresh_sessions SET status = 'REVOKED' WHERE user_id = ? AND status = 'ACTIVE'",
      [userId],
    );
    await conn.execute(
      `INSERT INTO refresh_sessions
        (user_id, token_hash, family_id, status, expires_at, session_version, created_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        userId,
        hashRefreshToken(refreshToken),
        familyId,
        toSqlDateTime(addDays(now, env.REFRESH_TOKEN_TTL_DAYS)),
        nextVersion,
        nowSql,
      ],
    );
  });

  const identity = await loadIdentity(userId);
  if (!identity) throw new AppError(BIZ_CODES.INTERNAL_ERROR);
  const accessToken = await signAccessToken({ uid: identity.userId, sv: identity.sessionVersion });
  setAuthCookies(res, accessToken, refreshToken);
  void recordAudit({
    action: 'USER_PASSWORD_CHANGE',
    targetType: 'user',
    targetId: userId,
    actorId: userId,
  });
  return toUserDto(identity);
}

export async function logout(userId: string, refreshToken: string | undefined, res: Response): Promise<void> {
  if (refreshToken) {
    await pool.execute(
      "UPDATE refresh_sessions SET status = 'REVOKED' WHERE user_id = ? AND token_hash = ?",
      [userId, hashRefreshToken(refreshToken)],
    );
  } else {
    // 前端当前 logout() 不传 refreshToken，等价于撤销该用户全部活跃会话
    await pool.execute(
      "UPDATE refresh_sessions SET status = 'REVOKED' WHERE user_id = ? AND status = 'ACTIVE'",
      [userId],
    );
  }
  clearAuthCookies(res);
  void recordAudit({ action: 'LOGOUT', targetType: 'user', targetId: userId, actorId: userId });
}
