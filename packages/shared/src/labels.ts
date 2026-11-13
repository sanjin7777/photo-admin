/**
 * 对外展示用的枚举中文文案。
 *
 * 为什么放在 shared：后端错误提示（如状态迁移失败）和前端列表渲染都需要，
 * 各写一份必然漂移，最后就会在界面上漏出 `REFUND_PENDING` 这种英文枚举。
 *
 * 这里只做「枚举 → 中文」，不含颜色；颜色属于前端展示层，在 apps/admin 里维护。
 */
export const STATUS_LABELS: Readonly<Record<string, string>> = {
  /* 场次状态 */
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  REGISTRATION_OPEN: '报名中',
  REGISTRATION_CLOSED: '报名截止',
  ONGOING: '进行中',
  FINISHED: '已结束',
  CANCELLED: '已取消',

  /* 报名状态（WAITLISTED / OFFERED 为候补时代的历史数据，仍可能出现在旧记录里） */
  WAITLISTED: '候补中',
  OFFERED: '待确认递补',
  CONFIRMED: '已确认',
  REFUND_PENDING: '退款中',
  CHECKED_IN: '已签到',
  COMPLETED: '已完成',

  /* 退款单 */
  REQUESTED: '待审核',
  APPROVED: '已通过',
  REFUNDING: '退款处理中',
  REJECTED: '已驳回',

  /* 支付状态 */
  NOT_REQUIRED: '无需支付',
  UNPAID: '待线下支付',
  PAID: '已收款',
  REFUNDED: '已退款',
  EXPIRED: '已失效',

  /* 报名来源 */
  ONLINE: '线上报名',
  MANUAL: '线下录入',

  /* 投票 */
  OPEN: '进行中',
  CLOSED: '已截止',

  /* 优惠券：类型与状态 */
  DISCOUNT: '折扣券',
  AMOUNT: '立减券',
  UNUSED: '未使用',
  USED: '已使用',

  /* 会员等级 / 可见性 */
  NONE: '普通用户',
  VIP: 'VIP',
  SVIP: 'SVIP',
  PUBLIC: '公开',

  /* 后台角色 */
  MODEL: '模特',
  OPERATOR: '运营',
  FINANCE: '财务',
  ADMIN: '管理员',
  // 运维账号仅在数据层保留，界面统一显示「管理员」，不暴露更高层级角色的存在
  SUPER_ADMIN: '管理员',

  /* 用户 / 会员状态 */
  ACTIVE: '正常',
  FROZEN: '已冻结',
  PENDING: '待审核',
  GRANTED: '已授权',
  REVOKED: '已撤销',

  /* 余额流水方向 */
  IN: '入账',
  OUT: '扣减',
  FREEZE: '冻结',
  UNFREEZE: '解冻',

  /* 余额业务类型 */
  SETTLE: '结算扣款',
  CREDIT: '调账入账',
  DEBIT: '调账扣减',
  REFUND: '退款',

  /* 审计动作 */
  LOGIN: '登录',
  LOGOUT: '登出',
  MEMBERSHIP_GRANT: '授予会员',
  MEMBERSHIP_REVOKE: '撤销会员',
  BALANCE_ADJUST: '积分调账',
  REFUND_REVIEW: '退款审核',
  REFUND_SETTLE: '线下退款完成',
  REGISTRATION_STATUS_CHANGE: '报名状态变更',
  EVENT_STATUS_CHANGE: '场次状态变更',
  VOTE_CONFIG_CHANGE: '投票配置变更',
  VOTE_RESULT_PUBLISH: '投票结果发布',
  DATA_EXPORT: '数据导出',
  MEMBER_IMPORT: '会员批量导入',
  USER_CREATE: '创建用户',
  USER_UPDATE: '修改用户',
  USER_PASSWORD_RESET: '重置密码',
  USER_PASSWORD_CHANGE: '修改密码',
  MODEL_PROFILE_UPSERT: '维护模特资料',
  SCENE_UPSERT: '维护场景库',
  SCENE_DELETE: '删除场景',
  INVITE_CODE_CREATE: '生成邀请码',
  INVITE_CODE_REVOKE: '作废邀请码',
  COUPON_ISSUE: '发放优惠券',
  COUPON_REVOKE: '作废优惠券',

  /* 余额流水 biz_type（DDL 实际值，补齐以免界面漏英文） */
  REGISTRATION: '报名扣款',
  MANUAL_ADJUST: '人工调账',
  BONUS: '赠送积分',

  /* 导入行状态 */
  OK: '可导入',
  WARN: '有提示',
  ERROR: '不可导入',

  /* 社交平台 */
  DOUYIN: '抖音',
  XIAOHONGSHU: '小红书',
  BILIBILI: 'B站',
  WEIBO: '微博',
  INSTAGRAM: 'Instagram',
  OTHER: '其他',
};

/** 取中文文案；未登记的枚举原样返回，方便发现遗漏 */
export function labelOf(key: string | null | undefined): string {
  if (key == null || key === '') return '—';
  return STATUS_LABELS[key] ?? key;
}

/**
 * 优惠券状态单独成表：REVOKED 在会员语境是「已撤销」，在券语境是「已作废」，
 * 共用一个 key 会二选一丢语义。
 */
export const COUPON_STATUS_LABELS: Readonly<Record<string, string>> = {
  UNUSED: '未使用',
  USED: '已使用',
  EXPIRED: '已过期',
  REVOKED: '已作废',
};

export function couponStatusLabel(key: string | null | undefined): string {
  if (key == null || key === '') return '—';
  return COUPON_STATUS_LABELS[key] ?? key;
}

/** 把枚举数组拼成中文，如 ['ADMIN','OPERATOR'] → 管理员 / 运营 */
export function labelsOf(keys: readonly string[] | null | undefined): string {
  if (!keys?.length) return '—';
  return keys.map(labelOf).join(' / ');
}
