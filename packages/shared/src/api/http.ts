/**
 * 统一 HTTP 客户端（仅前端通过 `@photo/shared/api` 引入）。
 *
 * 职责：
 * 1. 注入 Bearer token / Idempotency-Key（写操作自动生成）/ X-Trace-Id；
 * 2. 解包统一响应 { code, message, data, traceId }，业务码非 0 还原为 AppError；
 * 3. 401（或会话版本失效）时 refresh **单飞**，并发请求只刷新一次，之后重放原请求；
 * 4. 相同 GET 请求去重：后发请求取消前一个（AbortController）。
 *
 * token 存储由外部 TokenProvider 注入，本层不碰 localStorage，避免把 XSS 面写死在共享包里。
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { API_BASE_PATH, IDEMPOTENCY_KEY_HEADER, TRACE_ID_HEADER } from '../constants';
import { AppError, BIZ_CODES, type ApiResponse } from '../errors';

/** 仅为 Bearer 兼容模式保留；Cookie 模式下前端不应接触任何 token 字符串 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface TokenProvider {
  /** Cookie 模式返回 null：凭证由浏览器自动携带，JS 不接触 */
  getAccessToken(): string | null;
  /** 刷新失败 / 会话失效：清态并跳转登录 */
  onSessionInvalidated(): void;
}

export interface HttpClientOptions {
  baseURL?: string;
  tokenProvider: TokenProvider;
  /** Cookie 模式下无需入参：后端读取 httpOnly refresh cookie 并重新 Set-Cookie */
  refresh: () => Promise<void>;
  /** Cookie 模式必须为 true，让浏览器自动携带同源凭证 */
  withCredentials?: boolean;
  requestTimeoutMs?: number;
  /** 可注入的 ID 生成器，便于测试 */
  newId?: () => string;
  /**
   * 统一错误提示钩子：仅在请求**最终失败**时触发一次（刷新重放过程中的中间失败不触发）。
   * 由 UI 层注入（Vant showToast / Element Plus ElMessage），避免每个页面重复 try/catch。
   */
  onError?: (error: AppError) => void;
}

interface RetryableConfig extends AxiosRequestConfig {
  _retry?: boolean;
  _dedupeKey?: string | null;
}

export interface HttpClient {
  request<T>(config: AxiosRequestConfig): Promise<T>;
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  delete<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  /** 主动续期（点5）：复用单飞刷新，供会话保活在 access 到期前调用 */
  refresh(): Promise<void>;
  readonly instance: AxiosInstance;
}

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
/** 这些业务码表示会话已失效，可尝试刷新 */
const REFRESHABLE_CODES = new Set<number>([
  BIZ_CODES.TOKEN_EXPIRED,
  BIZ_CODES.SESSION_VERSION_MISMATCH,
]);

function defaultNewId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dedupeKeyOf(config: AxiosRequestConfig): string | null {
  const method = (config.method ?? 'get').toLowerCase();
  if (method !== 'get') return null;
  return `${method}|${config.url ?? ''}|${JSON.stringify(config.params ?? {})}`;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const newId = options.newId ?? defaultNewId;
  const pendingGet = new Map<string, AbortController>();
  let refreshPromise: Promise<void> | null = null;

  const instance: AxiosInstance = axios.create({
    baseURL: options.baseURL ?? API_BASE_PATH,
    timeout: options.requestTimeoutMs ?? 15_000,
    withCredentials: options.withCredentials ?? false,
  });

  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = options.tokenProvider.getAccessToken();
    if (token) config.headers.set('Authorization', `Bearer ${token}`);

    const method = (config.method ?? 'get').toLowerCase();
    if (WRITE_METHODS.has(method) && !config.headers.has(IDEMPOTENCY_KEY_HEADER)) {
      config.headers.set(IDEMPOTENCY_KEY_HEADER, newId());
    }
    const traceId = newId();
    config.headers.set(TRACE_ID_HEADER, traceId);

    const key = dedupeKeyOf(config);
    (config as RetryableConfig)._dedupeKey = key;
    if (key) {
      const previous = pendingGet.get(key);
      if (previous) previous.abort();
      const controller = new AbortController();
      pendingGet.set(key, controller);
      config.signal = controller.signal;
    }
    return config;
  });

  const cleanup = (config?: AxiosRequestConfig): void => {
    const key = (config as RetryableConfig | undefined)?._dedupeKey;
    if (key) pendingGet.delete(key);
  };

  instance.interceptors.response.use(
    (response) => {
      cleanup(response.config);
      return response;
    },
    (error: unknown) => {
      if (error instanceof AxiosError) cleanup(error.config);
      return Promise.reject(error);
    },
  );

  /** 并发 401 只刷新一次；Cookie 由后端重新下发，前端拿不到也不需要拿 token */
  async function refreshAccessToken(): Promise<void> {
    if (!refreshPromise) {
      refreshPromise = options
        .refresh()
        .catch((cause: unknown) => {
          options.tokenProvider.onSessionInvalidated();
          throw new AppError(BIZ_CODES.TOKEN_EXPIRED, undefined, cause);
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    await refreshPromise;
  }

  async function doRequest<T>(config: AxiosRequestConfig): Promise<T> {
    const cfg = config as RetryableConfig;
    try {
      const response = await instance.request<ApiResponse<T>>(cfg);
      const body = response.data;
      if (!body || typeof body.code !== 'number') {
        throw new AppError(BIZ_CODES.INTERNAL_ERROR, '响应格式异常');
      }
      if (body.code !== BIZ_CODES.OK) {
        throw new AppError(body.code, body.message, { traceId: body.traceId, ...(body.details as object ?? {}) });
      }
      return body.data;
    } catch (error: unknown) {
      if (axios.isCancel(error)) {
        throw new AppError(BIZ_CODES.REQUEST_CANCELLED);
      }
      if (error instanceof AppError) {
        if (REFRESHABLE_CODES.has(error.code) && !cfg._retry && !isAuthEndpoint(cfg.url)) {
          await refreshAccessToken();
          const retryConfig: RetryableConfig = { ...cfg, _retry: true };
          return doRequest<T>(retryConfig);
        }
        throw error;
      }
      if (error instanceof AxiosError) {
        const serverBody = error.response?.data as ApiResponse<unknown> | undefined;
        if (serverBody && typeof serverBody.code === 'number' && serverBody.code !== BIZ_CODES.OK) {
          throw new AppError(serverBody.code, serverBody.message, { traceId: serverBody.traceId, ...(serverBody.details as object ?? {}) });
        }
        if (error.response?.status === 401 && !cfg._retry && !isAuthEndpoint(cfg.url)) {
          await refreshAccessToken();
          const retryConfig: RetryableConfig = { ...cfg, _retry: true };
          return doRequest<T>(retryConfig);
        }
        if (!error.response) {
          throw new AppError(BIZ_CODES.DEPENDENCY_UNAVAILABLE, '网络不可用或请求超时');
        }
        throw new AppError(BIZ_CODES.INTERNAL_ERROR, error.message);
      }
      throw new AppError(BIZ_CODES.INTERNAL_ERROR, undefined, error);
    }
  }

  /** 外层包装：只负责统一错误通知，业务逻辑全部在 doRequest */
  async function request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      return await doRequest<T>(config);
    } catch (error: unknown) {
      const appError = error instanceof AppError ? error : new AppError(BIZ_CODES.INTERNAL_ERROR);
      options.onError?.(appError);
      throw appError;
    }
  }

  return {
    instance,
    request,
    refresh: refreshAccessToken,
    get: <T>(url: string, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, method: 'get', url }),
    post: <T>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, method: 'post', url, data }),
    put: <T>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, method: 'put', url, data }),
    patch: <T>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, method: 'patch', url, data }),
    delete: <T>(url: string, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, method: 'delete', url }),
  };
}

function isAuthEndpoint(url?: string): boolean {
  return Boolean(url && url.startsWith('/auth/'));
}
