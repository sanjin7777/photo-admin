/** 后台 API 实例（方案 A：HttpOnly Cookie 模式，站点挂载在 /admin/ 子路径）。 */
import { ElMessage } from 'element-plus';
import { BIZ_CODES, type AppError } from '@photo/shared';
import { createHttpClient, createApiClient } from '@photo/shared/api';

const SESSION_KEY = 'photo_admin_session';

export const tokens = {
  read: () => localStorage.getItem(SESSION_KEY),
  save: () => localStorage.setItem(SESSION_KEY, '1'),
  clear: () => localStorage.removeItem(SESSION_KEY),
};

const SILENT_CODES = new Set<number>([
  BIZ_CODES.UNAUTHORIZED,
  BIZ_CODES.REQUEST_CANCELLED,
]);

export const http = createHttpClient({
  tokenProvider: {
    getAccessToken: () => null,
    onSessionInvalidated: () => {
      tokens.clear();
      const loginPath = `${import.meta.env.BASE_URL}login`;
      if (window.location.pathname !== loginPath) window.location.assign(loginPath);
    },
  },
  withCredentials: true,
  onError: (error: AppError) => {
    if (SILENT_CODES.has(error.code)) return;
    ElMessage({ message: error.message || '请求失败', type: 'error', duration: 2600 });
  },
  refresh: async (): Promise<void> => {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    });
    const body = (await res.json()) as { code: number; message: string };
    if (body.code !== 0) throw new Error(body.message);
  },
});

export const api = createApiClient(http);
