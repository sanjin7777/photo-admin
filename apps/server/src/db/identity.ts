/**
 * 身份装载：每次请求从 DB 实时算「有效等级 + capability」。
 * 不信任 token 里的角色声明；token 只带 uid + sessionVersion（见 modules/auth/jwt.ts）。
 * 开发期不接缓存，模块 3/6 可加短 TTL 缓存；降级/撤销靠 sessionVersion 立即失效。
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  capabilitiesFor,
  isBackendRole,
  LEVEL_RANK,
  type BackendRole,
  type Capability,
  type MemberLevel,
} from '@photo/shared';
import { withConnection } from './pool';
import { toIso, toSqlDateTime } from '../utils/datetime';

interface UserRow extends RowDataPacket {
  id: string;
  wechat_id: string;
  nickname: string;
  avatar_url: string | null;
  phone: string | null;
  email: string | null;
  status: 'ACTIVE' | 'FROZEN';
  session_version: number;
  must_change_password: number;
  created_at: Date | string;
  updated_at: Date | string;
}
interface LevelRow extends RowDataPacket {
  level: string;
}
interface RoleRow extends RowDataPacket {
  role: string;
}

export interface Identity {
  userId: string;
  wechatId: string;
  nickname: string;
  avatarUrl: string | null;
  phone: string | null;
  email: string | null;
  status: 'ACTIVE' | 'FROZEN';
  sessionVersion: number;
  /** 导入账号首次登录须先改密；由 auth 中间件强制拦截业务接口 */
  mustChangePassword: boolean;
  level: MemberLevel;
  backendRoles: BackendRole[];
  capabilities: ReadonlySet<Capability>;
  createdAt: string;
  updatedAt: string;
}

/** 纯函数：按 now 过滤后的多条有效会员记录取最高等级 */
export function effectiveLevel(rows: readonly { level: string }[]): MemberLevel {
  let best: MemberLevel = 'NONE';
  for (const row of rows) {
    if (row.level !== 'VIP' && row.level !== 'SVIP') continue;
    if (LEVEL_RANK[row.level] > LEVEL_RANK[best]) best = row.level;
  }
  return best;
}

export function buildCapabilities(
  level: MemberLevel,
  backendRoles: readonly BackendRole[],
): ReadonlySet<Capability> {
  return capabilitiesFor({ authenticated: true, level, backendRoles });
}

export async function loadIdentity(userId: string): Promise<Identity | null> {
  return withConnection(async (conn) => {
    const [users] = await conn.execute<UserRow[]>(
      'SELECT id, wechat_id, nickname, avatar_url, phone, email, status, session_version, must_change_password, created_at, updated_at FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [userId],
    );
    const user = users[0];
    if (!user) return null;

    const now = toSqlDateTime();
    const [levelResult, roleResult] = await Promise.all([
      conn.execute<LevelRow[]>(
        "SELECT level FROM memberships WHERE user_id = ? AND status = 'ACTIVE' AND start_at <= ? AND expire_at > ?",
        [userId, now, now],
      ),
      conn.execute<RoleRow[]>('SELECT role FROM admin_roles WHERE user_id = ?', [userId]),
    ]);

    const level = effectiveLevel(levelResult[0] ?? []);
    const backendRoles = (roleResult[0] ?? [])
      .map((r) => r.role)
      .filter(isBackendRole);

    return {
      userId: String(user.id),
      wechatId: user.wechat_id,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      phone: user.phone,
      email: user.email,
      status: user.status,
      sessionVersion: Number(user.session_version),
      mustChangePassword: Number(user.must_change_password) === 1,
      level,
      backendRoles,
      capabilities: buildCapabilities(level, backendRoles),
      createdAt: toIso(user.created_at),
      updatedAt: toIso(user.updated_at),
    };
  });
}
