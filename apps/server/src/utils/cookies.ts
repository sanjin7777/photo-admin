/**
 * 手写 Cookie 解析，避免新增 cookie-parser 依赖（Express 的 res.cookie 已内置）。
 * 凭证只存在于浏览器与服务端之间，JS 无法读取（HttpOnly）。
 */
import type { Request } from 'express';

export const ACCESS_COOKIE = 'pc_access';
export const REFRESH_COOKIE = 'pc_refresh';

export function readCookie(req: Request, name: string): string | null {
  const raw = req.header('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
