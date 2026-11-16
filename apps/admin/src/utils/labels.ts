/**
 * 后台统一的中文标签与徽章配色。
 * 目的：列表里不再出现 REGISTRATION_OPEN 这类英文枚举，视觉风格也统一。
 */
import { formatPoints } from '@photo/shared';

type Meta = { label: string; cls: string };

export const EVENT_STATUS: Record<string, Meta> = {
  DRAFT: { label: '草稿', cls: 'bg-slate-100 text-slate-600' },
  PUBLISHED: { label: '已发布', cls: 'bg-blue-50 text-blue-700' },
  REGISTRATION_OPEN: { label: '报名中', cls: 'bg-emerald-50 text-emerald-700' },
  REGISTRATION_CLOSED: { label: '报名截止', cls: 'bg-amber-50 text-amber-700' },
  ONGOING: { label: '进行中', cls: 'bg-indigo-50 text-indigo-700' },
  FINISHED: { label: '已结束', cls: 'bg-slate-100 text-slate-500' },
  CANCELLED: { label: '已取消', cls: 'bg-rose-50 text-rose-600' },
};

export const VISIBILITY: Record<string, Meta> = {
  PUBLIC: { label: '公开', cls: 'bg-slate-100 text-slate-600' },
  VIP: { label: 'VIP', cls: 'bg-rose-50 text-rose-600' },
  SVIP: { label: 'SVIP', cls: 'bg-amber-50 text-amber-700' },
};

export const REGISTRATION_STATUS: Record<string, Meta> = {
  // WAITLISTED / OFFERED 为候补时代的历史状态，仍可能出现在旧记录里
  WAITLISTED: { label: '候补中', cls: 'bg-slate-100 text-slate-600' },
  OFFERED: { label: '待确认递补', cls: 'bg-amber-50 text-amber-700' },
  EXPIRED: { label: '已失效', cls: 'bg-slate-100 text-slate-400' },
  CONFIRMED: { label: '已确认', cls: 'bg-emerald-50 text-emerald-700' },
  REFUND_PENDING: { label: '退款中', cls: 'bg-amber-50 text-amber-700' },
  REFUNDED: { label: '已退款', cls: 'bg-slate-100 text-slate-500' },
  CHECKED_IN: { label: '已签到', cls: 'bg-blue-50 text-blue-700' },
  COMPLETED: { label: '已完成', cls: 'bg-emerald-50 text-emerald-700' },
  CANCELLED: { label: '已取消', cls: 'bg-slate-100 text-slate-400' },
};

export const PAYMENT_STATUS: Record<string, Meta> = {
  NOT_REQUIRED: { label: '无需支付', cls: 'bg-slate-100 text-slate-500' },
  UNPAID: { label: '待线下支付', cls: 'bg-amber-50 text-amber-700' },
  PAID: { label: '已收款', cls: 'bg-emerald-50 text-emerald-700' },
  REFUNDED: { label: '已退款', cls: 'bg-slate-100 text-slate-500' },
};

export const REGISTRATION_SOURCE: Record<string, Meta> = {
  ONLINE: { label: '线上报名', cls: 'bg-blue-50 text-blue-700' },
  MANUAL: { label: '线下录入', cls: 'bg-amber-50 text-amber-700' },
};

export const VOTE_STATUS: Record<string, Meta> = {
  DRAFT: { label: '草稿', cls: 'bg-slate-100 text-slate-600' },
  OPEN: { label: '进行中', cls: 'bg-emerald-50 text-emerald-700' },
  CLOSED: { label: '已截止', cls: 'bg-amber-50 text-amber-700' },
  PUBLISHED: { label: '结果已发布', cls: 'bg-blue-50 text-blue-700' },
};

export const MEMBER_LEVEL: Record<string, Meta> = {
  NONE: { label: '普通用户', cls: 'bg-slate-100 text-slate-600' },
  VIP: { label: 'VIP', cls: 'bg-rose-50 text-rose-600' },
  SVIP: { label: 'SVIP', cls: 'bg-amber-50 text-amber-700' },
};

export const REFUND_STATUS: Record<string, Meta> = {
  REQUESTED: { label: '待审核', cls: 'bg-amber-50 text-amber-700' },
  APPROVED: { label: '已通过', cls: 'bg-blue-50 text-blue-700' },
  REFUNDING: { label: '退款中', cls: 'bg-blue-50 text-blue-700' },
  REFUNDED: { label: '已退款', cls: 'bg-emerald-50 text-emerald-700' },
  REJECTED: { label: '已驳回', cls: 'bg-slate-100 text-slate-500' },
};

export const TXN_DIRECTION: Record<string, Meta> = {
  IN: { label: '入账', cls: 'bg-emerald-50 text-emerald-700' },
  OUT: { label: '扣款（结算）', cls: 'bg-rose-50 text-rose-600' },
  FREEZE: { label: '冻结（预扣）', cls: 'bg-amber-50 text-amber-700' },
  UNFREEZE: { label: '解冻（退回）', cls: 'bg-blue-50 text-blue-700' },
};

export const AUDIT_ACTION: Record<string, string> = {
  LOGIN: '登录', LOGOUT: '登出', MEMBERSHIP_GRANT: '授予会员', MEMBERSHIP_REVOKE: '撤销会员',
  BALANCE_ADJUST: '积分调账', REFUND_REVIEW: '退款审核', REFUND_SETTLE: '线下退款完成', REGISTRATION_STATUS_CHANGE: '报名状态变更',
  REGISTRATION_MANUAL_CREATE: '手动录入报名',
  EVENT_STATUS_CHANGE: '场次状态变更', VOTE_CONFIG_CHANGE: '投票配置变更', VOTE_RESULT_PUBLISH: '投票结果发布',
  DATA_EXPORT: '数据导出', MEMBER_IMPORT: '会员批量导入',
  USER_CREATE: '创建用户', USER_UPDATE: '修改用户资料', USER_PASSWORD_RESET: '重置密码',
  USER_PASSWORD_CHANGE: '修改密码',
  MODEL_PROFILE_UPSERT: '维护模特资料',
  SCENE_UPSERT: '维护场景', SCENE_DELETE: '删除场景',
  INVITE_CODE_CREATE: '生成邀请码', INVITE_CODE_REVOKE: '作废邀请码',
  COUPON_ISSUE: '发放优惠券', COUPON_REVOKE: '作废优惠券',
  USER_ACCOUNT_DELETE: '注销账号',
  SESSION_AVOID_RULE_UPSERT: '设置回避名单', SESSION_AVOID_RULE_REVOKE: '解除回避名单',
};

/** 审计对象类型也常以英文出现在表格里，统一翻译 */
export const SOCIAL_PLATFORM: Record<string, string> = {
  DOUYIN: '抖音', XIAOHONGSHU: '小红书', BILIBILI: 'B站',
  WEIBO: '微博', INSTAGRAM: 'Instagram', OTHER: '其他',
};

export const TARGET_TYPE: Record<string, string> = {
  user: '用户', users: '用户', user_batch: '用户（批量）',
  event: '场次', session: '时段', registration: '报名', refund: '退款单',
  vote_campaign: '投票活动', vote_option: '投票方案',
  model: '模特', models: '模特', model_profile: '模特档案',
  scene: '场景', scenes: '场景',
  balance: '积分账户', balance_transaction: '积分流水',
  membership: '会员', audit_log: '审计日志', system: '系统',
  upload: '上传文件',
};

const FALLBACK: Meta = { label: '—', cls: 'bg-slate-100 text-slate-500' };

export function metaOf(table: Record<string, Meta>, key: string | null | undefined): Meta {
  if (!key) return FALLBACK;
  return table[key] ?? { label: key, cls: FALLBACK.cls };
}

/**
 * 台账单位（分）→ 积分文本。
 *
 * 站点已整体去货币化：后台不再出现「元 / ¥」，所有涉及金额的字段一律以「积分」呈现。
 * 原来的 `yuan()` 已移除，避免有人误用回货币展示。
 */
export function points(cent: number | null | undefined): string {
  if (cent == null) return '—';
  return `${formatPoints(cent)} 积分`;
}

/** ISO → 本地 `MM/DD HH:mm`，列表里省空间 */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * ISO → `YYYY-MM-DDTHH:mm:ss`，用于 Element Plus 日期选择器的 v-model 初值。
 *
 * 必须带秒：`el-date-picker` 的 value-format 声明为 `YYYY-MM-DDTHH:mm:ss`，
 * 传入不带秒的字符串会解析失败并显示为空（曾导致「新建场次默认时段时间为空」）。
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
