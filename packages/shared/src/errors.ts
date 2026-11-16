/**
 * 统一响应包与业务错误码。
 * 约定：HTTP 语义码 + 业务 code 分段；前端按 code 映射提示，后端按 code 抛 AppError。
 */

export const BIZ_CODE_RANGES = {
  PARAM: 1000,
  AUTH: 2000,
  PERMISSION: 3000,
  STATE: 4000,
  SERVER: 5000,
} as const;

export const BIZ_CODES = {
  OK: 0,

  // 1xxx 参数 / 校验
  INVALID_PARAM: 1001,
  SCHEMA_VALIDATION_FAILED: 1002,
  REQUEST_CANCELLED: 1003,
  IDEMPOTENCY_KEY_MISSING: 1004,

  // 2xxx 认证
  UNAUTHORIZED: 2001,
  TOKEN_EXPIRED: 2002,
  TOKEN_REPLAYED: 2003,
  SESSION_VERSION_MISMATCH: 2004,
  INVALID_CREDENTIALS: 2005,
  LOGIN_TOO_MANY_ATTEMPTS: 2006,
  /** 导入账号首次登录：须先改密才能调用其它业务接口 */
  PASSWORD_CHANGE_REQUIRED: 2007,

  // 3xxx 权限
  FORBIDDEN: 3001,
  LEVEL_INSUFFICIENT: 3002,
  RESOURCE_NOT_OWNED: 3003,
  APPROVAL_REQUIRED: 3004,

  // 4xxx 业务状态 / 并发冲突
  // 注意：4004（原 WAITLIST_DISABLED）与 4009（原 OFFER_EXPIRED）随候补功能下线而退役，
  // 编号刻意留空不复用——前端历史版本可能仍按旧码分支，复用会让旧客户端误判。
  RESOURCE_NOT_FOUND: 4001,
  EVENT_NOT_OPEN: 4002,
  EVENT_FULL: 4003,
  BALANCE_INSUFFICIENT: 4005,
  ALREADY_REGISTERED: 4006,
  ILLEGAL_TRANSITION: 4007,
  REFUND_WINDOW_CLOSED: 4008,
  VOTE_CLOSED: 4010,
  VOTE_ALREADY_CAST: 4011,
  RATE_LIMITED: 4012,
  IDEMPOTENCY_CONFLICT: 4013,
  CONCURRENCY_CONFLICT: 4014,
  LEDGER_MISMATCH: 4015,
  CAPACITY_BELOW_USED: 4016,
  /** 同一时段已有其它报名，需要用户二次确认 */
  SCHEDULE_CONFLICT: 4017,
  /** 注册邀请码 */
  INVITE_CODE_INVALID: 4018,
  INVITE_CODE_USED: 4019,
  INVITE_CODE_EXPIRED: 4020,
  /** 一次报名的剩余名额不足 / 同一场次名额数超上限 */
  SEATS_EXCEEDED: 4021,
  /** 优惠券已使用 / 已过期 / 已作废 / 不满足门槛 / 不属于本人 */
  COUPON_INVALID: 4022,
  /** 该场次关闭了优惠券使用 */
  COUPON_NOT_ALLOWED: 4023,
  /** 当前处于人工分批报名阶段，尚未开放到该用户的会员等级 */
  REGISTRATION_LEVEL_GATE: 4024,
  /**
   * 该时段设置了回避名单，当前用户不可报名。
   * 文案刻意中性：不提示「被某人排除」，避免造成会员之间的直接冲突。
   */
  SESSION_RESTRICTED: 4025,

  // 5xxx 服务
  INTERNAL_ERROR: 5001,
  DB_ERROR: 5002,
  DEPENDENCY_UNAVAILABLE: 5003,
} as const;

export type BizCode = (typeof BIZ_CODES)[keyof typeof BIZ_CODES];

export const BIZ_CODE_MESSAGES: Readonly<Record<number, string>> = {
  [BIZ_CODES.INVALID_PARAM]: '参数不合法',
  [BIZ_CODES.SCHEMA_VALIDATION_FAILED]: '表单校验未通过',
  [BIZ_CODES.REQUEST_CANCELLED]: '请求已取消',
  [BIZ_CODES.IDEMPOTENCY_KEY_MISSING]: '缺少幂等键',
  [BIZ_CODES.UNAUTHORIZED]: '请先登录',
  [BIZ_CODES.TOKEN_EXPIRED]: '登录已过期，请重新登录',
  [BIZ_CODES.TOKEN_REPLAYED]: '检测到会话重放，请重新登录',
  [BIZ_CODES.SESSION_VERSION_MISMATCH]: '权限已变更，请刷新会话',
  [BIZ_CODES.INVALID_CREDENTIALS]: '账号或密码错误',
  [BIZ_CODES.LOGIN_TOO_MANY_ATTEMPTS]: '尝试过于频繁，请稍后再试',
  [BIZ_CODES.PASSWORD_CHANGE_REQUIRED]: '请先修改初始密码',
  [BIZ_CODES.FORBIDDEN]: '没有操作权限',
  [BIZ_CODES.LEVEL_INSUFFICIENT]: '会员等级不足',
  [BIZ_CODES.RESOURCE_NOT_OWNED]: '无权访问该资源',
  [BIZ_CODES.APPROVAL_REQUIRED]: '该操作需要复核审批',
  [BIZ_CODES.RESOURCE_NOT_FOUND]: '资源不存在',
  [BIZ_CODES.EVENT_NOT_OPEN]: '当前不在报名时间内',
  [BIZ_CODES.EVENT_FULL]: '名额已满',
  [BIZ_CODES.BALANCE_INSUFFICIENT]: '积分不足',
  [BIZ_CODES.ALREADY_REGISTERED]: '已报名该场次',
  [BIZ_CODES.ILLEGAL_TRANSITION]: '当前状态不允许该操作',
  [BIZ_CODES.REFUND_WINDOW_CLOSED]: '已超过可取消时间',
  [BIZ_CODES.VOTE_CLOSED]: '投票已结束',
  [BIZ_CODES.VOTE_ALREADY_CAST]: '已投过票',
  [BIZ_CODES.RATE_LIMITED]: '操作过于频繁',
  [BIZ_CODES.IDEMPOTENCY_CONFLICT]: '重复请求，请求参数与首次不一致',
  [BIZ_CODES.CONCURRENCY_CONFLICT]: '并发冲突，请重试',
  [BIZ_CODES.SCHEDULE_CONFLICT]: '该时段与你已报名的场次时间冲突',
  [BIZ_CODES.INVITE_CODE_INVALID]: '邀请码无效，请向管理员获取',
  [BIZ_CODES.INVITE_CODE_USED]: '该邀请码已被使用',
  [BIZ_CODES.INVITE_CODE_EXPIRED]: '邀请码已过期，请向管理员重新获取',
  [BIZ_CODES.SEATS_EXCEEDED]: '剩余名额不足或超出单次报名上限，请减少人数',
  [BIZ_CODES.COUPON_INVALID]: '优惠券不可用，请重新选择',
  [BIZ_CODES.COUPON_NOT_ALLOWED]: '该场次不可使用优惠券',
  [BIZ_CODES.REGISTRATION_LEVEL_GATE]: '当前报名尚未开放到你的会员等级',
  // 中性文案：让被拦截的人换个时段就行，不要暴露「被谁排除」
  [BIZ_CODES.SESSION_RESTRICTED]: '该时段暂不可选，请选择其他时段',
  [BIZ_CODES.LEDGER_MISMATCH]: '账本对账异常，操作已冻结',
  [BIZ_CODES.CAPACITY_BELOW_USED]: '容量不能小于已报名人数',
  [BIZ_CODES.INTERNAL_ERROR]: '服务异常',
  [BIZ_CODES.DB_ERROR]: '数据访问异常',
  [BIZ_CODES.DEPENDENCY_UNAVAILABLE]: '依赖服务不可用',
};

/** 统一响应包：所有接口（含错误）都返回该结构 */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  traceId: string;
}

export function httpStatusFor(code: number): number {
  if (code === BIZ_CODES.OK) return 200;
  const special: Readonly<Record<number, number>> = {
    [BIZ_CODES.RESOURCE_NOT_FOUND]: 404,
    [BIZ_CODES.RATE_LIMITED]: 429,
    [BIZ_CODES.LOGIN_TOO_MANY_ATTEMPTS]: 429,
  };
  if (special[code] !== undefined) return special[code] as number;
  if (code >= BIZ_CODE_RANGES.SERVER) return 500;
  if (code >= BIZ_CODE_RANGES.STATE) return 409;
  if (code >= BIZ_CODE_RANGES.PERMISSION) return 403;
  if (code >= BIZ_CODE_RANGES.AUTH) return 401;
  return 400;
}

export function messageFor(code: number): string {
  return BIZ_CODE_MESSAGES[code] ?? '未知错误';
}

/** 前后端共用：后端抛出，前端 axios 拦截器还原 */
export class AppError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: number, message?: string, details?: unknown) {
    super(message ?? messageFor(code));
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatusFor(code);
    this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function successResponse<T>(data: T, traceId: string, message = 'ok'): ApiResponse<T> {
  return { code: BIZ_CODES.OK, message, data, traceId };
}
