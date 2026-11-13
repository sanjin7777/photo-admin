/**
 * 前台 API 实例（方案 A：HttpOnly Cookie 模式）。
 * localStorage 里只保留一个非敏感的「曾登录过」标记，凭证完全由浏览器 Cookie 管理，JS 不接触。
 */
import { showToast } from 'vant';
import { BIZ_CODES, type AppError } from '@photo/shared';
import { createHttpClient, createApiClient } from '@photo/shared/api';

const SESSION_KEY = 'photo_web_session';

/** 只用于路由守卫判断是否尝试 hydrate，绝不含 token */
export const tokens = {
  read: () => localStorage.getItem(SESSION_KEY),
  save: () => localStorage.setItem(SESSION_KEY, '1'),
  clear: () => localStorage.removeItem(SESSION_KEY),
};

/** 未登录态的 hydrate 探测、重复 GET 主动取消不弹提示 */
const SILENT_CODES = new Set<number>([
  BIZ_CODES.UNAUTHORIZED,
  BIZ_CODES.REQUEST_CANCELLED,
  // 时段冲突由报名页自己弹二次确认，不走全局 toast
  BIZ_CODES.SCHEDULE_CONFLICT,
]);

export const http = createHttpClient({
  tokenProvider: {
    // Cookie 模式下不注入 Authorization，浏览器自动携带 HttpOnly Cookie
    getAccessToken: () => null,
    onSessionInvalidated: () => {
      tokens.clear();
      if (window.location.pathname !== '/login') window.location.assign('/login');
    },
  },
  withCredentials: true,
  onError: (error: AppError) => {
    if (SILENT_CODES.has(error.code)) return;
    showToast({ message: error.message || '请求失败', type: 'fail', duration: 2600 });
  },
  // 用裸 fetch 刷新，避免经过 axios 拦截器造成递归 401；Cookie 由后端重新下发
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
