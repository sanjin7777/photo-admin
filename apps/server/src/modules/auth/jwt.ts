/**
 * Access token：短时效 JWT，payload **只放 uid + sessionVersion(sv)**，不放角色/等级。
 * 能力每次请求由 db/identity.ts 从 DB 实时装载；撤销会员时 sv+1 使旧 token 立即失效。
 * Refresh token 是不透明随机串（DB 存哈希，支持轮换与重放检测），见 service.ts。
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env';

const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  uid: string;
  sv: number;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ sv: claims.sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.uid)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + env.ACCESS_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(key);
}

/** 任何校验失败（过期 / 篡改 / 算法不符）统一返回 null，由上层映射为认证错误 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.sv !== 'number') return null;
    return { uid: payload.sub, sv: payload.sv };
  } catch {
    return null;
  }
}
