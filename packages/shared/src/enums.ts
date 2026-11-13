import { labelOf } from './labels';

/**
 * 全部业务状态机枚举与合法迁移表（对应方案 §4.4）。
 *
 * 约束：状态只能由服务端在事务内按迁移表推进；接口不接受前端传入的目标状态；
 * 非法迁移抛 ILLEGAL_TRANSITION（409）；每次迁移写一条 audit_logs。
 */
import { AppError, BIZ_CODES } from './errors';

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return (map[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): void {
  if (!canTransition(map, from, to)) {
    // 用中文标签而不是原始枚举，否则界面上会冒出「不允许从 REFUND_PENDING 迁移到 REFUND_PENDING」
    throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, `当前状态为「${labelOf(from)}」，不能变更为「${labelOf(to)}」`, { from, to });
  }
}

/* ---------------- 场次 ---------------- */
export const EVENT_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'ONGOING',
  'FINISHED',
  'CANCELLED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_TRANSITIONS: TransitionMap<EventStatus> = {
  /** 后台「发布」直接进入可报名状态；报名窗口由 registration_open_at / close_at 另行把关 */
  DRAFT: ['PUBLISHED', 'REGISTRATION_OPEN', 'CANCELLED'],
  PUBLISHED: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'CANCELLED'],
  REGISTRATION_CLOSED: ['ONGOING', 'CANCELLED'],
  ONGOING: ['FINISHED'],
  FINISHED: [],
  /** 已取消可以恢复：按报名窗口回到「报名中」或「已发布」 */
  CANCELLED: ['PUBLISHED', 'REGISTRATION_OPEN'],
};

/* ---------------- 优惠券 ---------------- */
/** DISCOUNT = 折扣券（按折扣率），AMOUNT = 立减券（固定金额） */
export const COUPON_TYPES = ['DISCOUNT', 'AMOUNT'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

/** EXPIRED 不入库：读取时按 expires_at 动态判定 */
export const COUPON_STATUSES = ['UNUSED', 'USED', 'EXPIRED', 'REVOKED'] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

/* ---------------- 报名 ---------------- */
/**
 * WAITLISTED / OFFERED / EXPIRED 为候补时代的历史状态：
 * 候补已下线，不再产生新记录，但存量行仍需被展示与取消，故枚举保留。
 */
export const REGISTRATION_STATUSES = [
  'WAITLISTED',
  'OFFERED',
  'EXPIRED',
  'CONFIRMED',
  'REFUND_PENDING',
  'REFUNDED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_TRANSITIONS: TransitionMap<RegistrationStatus> = {
  /** 历史状态：只能走向终态，不再进入任何活跃流程 */
  WAITLISTED: ['EXPIRED', 'CANCELLED'],
  OFFERED: ['EXPIRED', 'CANCELLED'],
  EXPIRED: [],
  CONFIRMED: ['REFUND_PENDING', 'CHECKED_IN', 'CANCELLED'],
  /** 审核拒绝时回到 CONFIRMED（报名仍然有效） */
  REFUND_PENDING: ['REFUNDED', 'CONFIRMED'],
  REFUNDED: [],
  CHECKED_IN: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

/* ---------------- 退款单 ---------------- */
export const REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'REFUNDING', 'REFUNDED', 'REJECTED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** REFUNDING 与余额回充在同一事务内完成，不持久化悬挂中间态 */
export const REFUND_TRANSITIONS: TransitionMap<RefundStatus> = {
  REQUESTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['REFUNDING', 'REJECTED'],
  REFUNDING: ['REFUNDED'],
  REFUNDED: [],
  REJECTED: [],
};

/* ---------------- 会员 ---------------- */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_TRANSITIONS: TransitionMap<MembershipStatus> = {
  ACTIVE: ['EXPIRED', 'REVOKED'],
  EXPIRED: [],
  REVOKED: [],
};

/* ---------------- 投票活动 ---------------- */
export const VOTE_CAMPAIGN_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'PUBLISHED'] as const;
export type VoteCampaignStatus = (typeof VOTE_CAMPAIGN_STATUSES)[number];

export const VOTE_CAMPAIGN_TRANSITIONS: TransitionMap<VoteCampaignStatus> = {
  DRAFT: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['PUBLISHED'],
  PUBLISHED: [],
};

/* ---------------- 余额流水 ---------------- */
export const BALANCE_TXN_DIRECTIONS = ['IN', 'OUT', 'FREEZE', 'UNFREEZE'] as const;
export type BalanceTxnDirection = (typeof BALANCE_TXN_DIRECTIONS)[number];

export const BALANCE_BIZ_TYPES = ['REGISTRATION', 'REFUND', 'MANUAL_ADJUST', 'BONUS'] as const;
export type BalanceBizType = (typeof BALANCE_BIZ_TYPES)[number];

/** 账本 append-only：仅 INSERT，禁止 UPDATE/DELETE */
export const LEDGER_WRITABLE = false as const;

/* ---------------- 审计动作 ---------------- */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'MEMBERSHIP_GRANT',
  'MEMBERSHIP_REVOKE',
  'BALANCE_ADJUST',
  'REFUND_REVIEW',
  /** 线下退款实际完成：补记经办人与时间（非会员退款的对账痕迹） */
  'REFUND_SETTLE',
  'REGISTRATION_STATUS_CHANGE',
  /** 后台手动录入线下报名 */
  'REGISTRATION_MANUAL_CREATE',
  'EVENT_STATUS_CHANGE',
  'VOTE_CONFIG_CHANGE',
  'VOTE_RESULT_PUBLISH',
  'DATA_EXPORT',
  /** Excel 批量导入会员 */
  'MEMBER_IMPORT',
  /** 后台创建单个用户 */
  'USER_CREATE',
  /** 后台新增/修改用户资料 */
  'USER_UPDATE',
  /** 后台重置用户密码（仅管理员/运维账号） */
  'USER_PASSWORD_RESET',
  /** 用户本人修改密码（含导入账号首次登录强制改密） */
  'USER_PASSWORD_CHANGE',
  /** 模特资料维护 */
  'MODEL_PROFILE_UPSERT',
  /** 场景库：新增/修改 与 删除（点4） */
  'SCENE_UPSERT',
  'SCENE_DELETE',
  /** 注册邀请码：生成 / 作废 */
  'INVITE_CODE_CREATE',
  'INVITE_CODE_REVOKE',
  /** 优惠券：发放 / 作废 */
  'COUPON_ISSUE',
  'COUPON_REVOKE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* ---------------- 用户状态 ---------------- */
export const USER_STATUSES = ['ACTIVE', 'FROZEN'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** 模特肖像授权状态（仅记录授权凭证，不代表实名认证） */
export const PORTRAIT_AUTH_STATUSES = ['PENDING', 'GRANTED', 'EXPIRED', 'REVOKED'] as const;
export type PortraitAuthStatus = (typeof PORTRAIT_AUTH_STATUSES)[number];

/* ---------------- 活动时段 ---------------- */
export const SESSION_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * 报名支付状态：
 * NOT_REQUIRED = 会员用余额，已在报名时扣减；
 * UNPAID = 非会员线下支付，待运营确认收款；
 * PAID = 运营已确认；REFUNDED = 已退款。
 */
export const PAYMENT_STATUSES = ['NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/* ---------------- 报名来源 ---------------- */
/**
 * ONLINE = 前台用户自助报名；MANUAL = 后台运营手动录入（线下报名 / 补录）。
 * 仅用于展示与运营口径，不参与退款资金路由（路由仍看 payment_status）。
 */
export const REGISTRATION_SOURCES = ['ONLINE', 'MANUAL'] as const;
export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];
