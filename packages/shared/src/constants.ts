/**
 * 跨端共享常量。所有数值均来自已确认方案（V1 暂定假设），改动需同步修订方案文档。
 */

/** Tailwind 断点（px）。移动优先：base 即手机态，向上逐级增强。 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

export const API_BASE_PATH = '/api/v1';

/**
 * 会话：access token 短时效 + refresh 轮换；能力清单不写进 token。
 * 点5：延长为 access 8 小时 / refresh 30 天，减少「一会儿就被登出」；
 * 前端在 access 到期前主动续期，并在长时间无操作时弹「即将登出」提示。
 */
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 3600;
export const REFRESH_TOKEN_TTL_DAYS = 30;
/** 无操作多久后开始弹「即将登出」提示（秒）；取 access 时效减去提前量 */
export const SESSION_IDLE_WARN_SECONDS = 7 * 3600;
/** 弹出提示后再无操作多久则登出（秒） */
export const SESSION_IDLE_GRACE_SECONDS = 10 * 60;
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const TRACE_ID_HEADER = 'X-Trace-Id';
export const IDEMPOTENCY_DEDUP_WINDOW_HOURS = 24;

/** 业务规则（对应方案 §1 暂定假设） */
export const FREE_CANCEL_BEFORE_HOURS = 24;

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
export const TIMEZONE_DISPLAY = 'Asia/Shanghai';

/**
 * 金额单位统一为「分」的整数。
 * DB 列名 `xxx_cent`(BIGINT)，API 字段 camelCase 为 `xxxCent`(number)。
 * 禁止 FLOAT/DOUBLE，禁止在前端计算入账金额。
 */
export const MONEY_UNIT = 'CENT' as const;

/** 开发期边界：不接真实支付 / 短信通道，站内信走 Mock。 */
export const FEATURE_FLAGS = {
  REAL_PAYMENT: false,
  REAL_SMS: false,
  MOCK_NOTIFICATION: true,
} as const;
