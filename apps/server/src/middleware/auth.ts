/**
 * 第一层校验：认证。
 * 验签 → 装载实时身份 → 校验账号状态 → 校验 sessionVersion（权限变更即时失效）。
 */
import type { Request } from 'express';
import { API_BASE_PATH, AppError, BIZ_CODES } from '@photo/shared';
import { loadIdentity } from '../db/identity';
import { verifyAccessToken } from '../modules/auth/jwt';
import { ACCESS_COOKIE, readCookie } from '../utils/cookies';
import { setIdentity } from './context';
import { asyncHandler } from './error';

/** Cookie 优先；保留 Bearer 兼容，便于 curl 排查与过渡期使用 */
function extractToken(req: Request): string | null {
  const header = req.header('Authorization');
  const bearer = header && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return readCookie(req, ACCESS_COOKIE) ?? bearer;
}

/**
 * 强制改密期间仍允许调用的接口：装载身份、查看能力、改密、登出。
 * 其余业务接口一律拒绝，防止导入账号在改密前继续使用系统。
 */
const PASSWORD_CHANGE_WHITELIST = new Set([
  `${API_BASE_PATH}/me`,
  `${API_BASE_PATH}/me/capabilities`,
  `${API_BASE_PATH}/me/password`,
  `${API_BASE_PATH}/auth/logout`,
]);

export const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw new AppError(BIZ_CODES.UNAUTHORIZED);
  const claims = await verifyAccessToken(token);
  if (!claims) throw new AppError(BIZ_CODES.TOKEN_EXPIRED);

  const identity = await loadIdentity(claims.uid);
  if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
  if (identity.status === 'FROZEN') {
    throw new AppError(BIZ_CODES.FORBIDDEN, '账号已冻结');
  }
  if (identity.sessionVersion !== claims.sv) {
    throw new AppError(BIZ_CODES.SESSION_VERSION_MISMATCH);
  }
  if (identity.mustChangePassword) {
    const pathname = (req.originalUrl.split('?')[0] ?? '').replace(/\/+$/, '');
    if (!PASSWORD_CHANGE_WHITELIST.has(pathname)) {
      throw new AppError(BIZ_CODES.PASSWORD_CHANGE_REQUIRED);
    }
  }

  setIdentity(identity);
  next();
});

/**
 * 可选认证：公开列表接口用。带有效 token 时装载实时等级（用于可见性过滤），
 * 无 token 或 token 失效时按游客处理，不报错。
 */
export const optionalAuthenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  const claims = await verifyAccessToken(token);
  if (!claims) {
    next();
    return;
  }
  const identity = await loadIdentity(claims.uid);
  if (identity && identity.status === 'ACTIVE' && identity.sessionVersion === claims.sv) {
    setIdentity(identity);
  }
  next();
});
