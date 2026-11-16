/**
 * 场次 / 报名 schema。
 *
 * 安全边界：报名请求体**只有 eventId**，不含金额、等级、状态；
 * 费用、容量、资格、可见性一律由服务端重算，幂等键走请求头。
 */
import { z } from 'zod';
import { EVENT_VISIBILITIES, MEMBER_LEVELS } from '../roles';
import { EVENT_STATUSES, REGISTRATION_STATUSES } from '../enums';
import { centSchema, idSchema, reasonSchema, refundPolicySchema, refineChronological, isoDateTimeSchema, pageQuerySchema } from './common';
import { registrationCouponIdsSchema } from './coupon';

export const visibilitySchema = z.enum(EVENT_VISIBILITIES);

/**
 * 时段输入：一场活动至少一个时段，容量与时间以时段为准。
 * 编辑已有场次时带上 id 表示「更新该时段」；不带 id 表示新增。
 * 未出现在提交数组里的已有时段会被删除，服务端会拒绝删除仍有报名的时段。
 */
export const sessionInputSchema = z
  .object({
    id: idSchema.optional(),
    label: z.string().trim().min(1).max(32),
    startAt: isoDateTimeSchema,
    endAt: isoDateTimeSchema,
    capacity: z.number().int().min(1, '时段容量至少 1').max(1000),
  })
  .strict();

/** 价格档输入：PUBLIC = 非会员价 */
export const priceInputSchema = z
  .object({
    level: visibilitySchema,
    priceCent: centSchema,
    unitLabel: z.string().trim().min(1).max(16).default('场'),
  })
  .strict();

/** 先定义未挂 refine 的基础形状，便于 PATCH 复用 .partial() */
export const eventCreateBaseSchema = z
  .object({
    title: z.string().trim().min(2).max(80),
    subtitle: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** 允许站内相对路径（如 /posters/a.jpg）或完整 URL */
    coverUrl: z.string().trim().max(512).nullable().optional(),
    posterUrls: z.array(z.string().trim().max(512)).max(9).default([]),
    wardrobeUrls: z.array(z.string().trim().max(512)).max(9).default([]),
    /** 场地照片 */
    venueUrls: z.array(z.string().trim().max(512)).max(9).default([]),
    venue: z.string().trim().min(2).max(200),
    scene: z.string().trim().max(64).nullable().optional(),
    notice: z.string().trim().max(4000).nullable().optional(),
    ratioLabel: z.string().trim().max(16).nullable().optional(),
    modelCount: z.number().int().min(1).max(20).default(1),
    allowProxyShoot: z.boolean().default(false),
    privateBookingNote: z.string().trim().max(200).nullable().optional(),
    /**
     * 主模特（向后兼容）：等于 modelIds[0]。
     * 只传 modelId 的旧客户端仍可用，服务端会把它并入 modelIds。
     */
    modelId: idSchema.nullable().optional(),
    /** 本场次参与的全部模特；首项即主模特。双模特场次传 2 个 */
    modelIds: z.array(idSchema).max(20, '一场最多 20 位模特').optional(),
    /**
     * 每位模特各自的当日服装图，与 `modelIds` 按下标一一对应。
     *
     * 用平行数组而不是把对象塞进 modelIds，是为了不破坏既有契约
     * （`modelIds` 一直是 string[]，前台/投票/搜索都在用）。
     * 某项为空数组时，该模特回退到 `wardrobeUrls`（整场共用那组）。
     *
     * 示例：`{ modelIds: [A, B], modelWardrobes: [['/a1.jpg'], ['/b1.jpg']] }`
     */
    modelWardrobes: z
      .array(z.array(z.string().trim().max(512)).max(9))
      .max(20)
      .optional(),
    /**
     * 每位模特在本场使用的照片，与 `modelIds` 按下标对应（通常各 1 张）。
     * 为空时回退 `posterUrls`（整场一张）或模特档案首图。
     */
    modelPhotos: z
      .array(z.array(z.string().trim().max(512)).max(9))
      .max(20)
      .optional(),
    /** 关联场景库（点4）；仅引用，场地展示仍用本场次自己的 venue/scene/venueUrls */
    sceneId: idSchema.nullable().optional(),
    registrationOpenAt: isoDateTimeSchema,
    registrationCloseAt: isoDateTimeSchema,
    /** 可由时段推导，允许省略 */
    startAt: isoDateTimeSchema.optional(),
    endAt: isoDateTimeSchema.optional(),
    visibility: visibilitySchema.default('PUBLIC'),
    /** 人工报名门槛（点2）：此刻允许报名的最低等级，默认 NONE=所有人；运营手动 SVIP→VIP→NONE 放开 */
    registerMinLevel: z.enum(MEMBER_LEVELS).default('NONE'),
    /** 由 PUBLIC 档价格推导 */
    feeCent: centSchema.default(0),
    /** 由时段容量求和推导 */
    capacity: z.number().int().min(0).max(100000).default(0),
    /** 是否允许使用优惠券；关闭后仅拦截新报名，已用券订单不变 */
    allowCoupon: z.boolean().default(true),
    refundPolicy: refundPolicySchema.default({ freeCancelBeforeHours: 48, feeRatio: 0 }),
    sessions: z.array(sessionInputSchema).min(1, '至少一个时段').max(20),
    prices: z.array(priceInputSchema).min(1, '至少一档价格').max(3),
  })
  .strict();

/**
 * 把「主模特」与「模特列表」归一成同一个数组。
 *
 * 兼容三种写法：
 *   · 只传 modelIds   → 首项即主模特
 *   · 只传 modelId    → 等价于 modelIds: [modelId]
 *   · 两个都传        → 以 modelIds 为准，modelId 若不在其中则忽略
 * 返回去重后的 id 数组（保持顺序），空数组表示未指定模特。
 */
export function normalizeModelIds(input: {
  modelId?: string | null;
  modelIds?: string[] | null;
}): string[] {
  const list = (input.modelIds ?? []).filter(Boolean);
  if (list.length) return [...new Set(list)];
  return input.modelId ? [input.modelId] : [];
}

export const eventCreateSchema = eventCreateBaseSchema.superRefine((v, ctx) => {
  const open = Date.parse(v.registrationOpenAt);
  const close = Date.parse(v.registrationCloseAt);
  if (open >= close) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registrationCloseAt'], message: '报名截止必须晚于报名开始' });
  }
  v.sessions.forEach((s, i) => {
    if (Date.parse(s.startAt) >= Date.parse(s.endAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', i, 'endAt'], message: '时段结束必须晚于开始' });
    }
    if (close > Date.parse(s.startAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', i, 'startAt'], message: '时段开始应晚于报名截止' });
    }
  });
  const levels = v.prices.map((p) => p.level);
  if (new Set(levels).size !== levels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prices'], message: '价格档位不可重复' });
  }
  // 模特列表内不允许重复（同一个人出现两次没有意义）
  const ids = v.modelIds ?? [];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelIds'], message: '同一模特不能重复添加' });
  }
});
export type EventCreatePayload = z.infer<typeof eventCreateSchema>;

/**
 * PATCH 不做时间链 refine（字段可能缺省）。
 * 服务端必须把 patch 与 DB 现有值合并后重新校验完整时间链，
 * 并校验 capacity >= capacity_used（对应 BIZ_CODES.CAPACITY_BELOW_USED）。
 */
export const eventPatchSchema = eventCreateBaseSchema.partial().strict();
export type EventPatchPayload = z.infer<typeof eventPatchSchema>;

/**
 * 后台场次列表查询。
 *
 * 场次是「只增不减」的表，按页拉全量迟早会把旧场次挤出可见范围，所以筛选与分页都下推 SQL。
 * 与 adminUserListQuerySchema 同样的坑：validateQuery 会用校验结果整体覆盖 req.query，
 * 这里没声明的键会被静默丢掉。
 */
export const adminEventListQuerySchema = pageQuerySchema.extend({
  status: z.enum(EVENT_STATUSES).optional(),
  visibility: visibilitySchema.optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type AdminEventListQueryInput = z.infer<typeof adminEventListQuerySchema>;

/** 报名按「活动 + 时段」提交；金额、支付方式、容量一律服务端重算 */
export const registrationCreateSchema = z
  .object({
    eventId: idSchema,
    sessionId: idSchema,
    /**
     * 一次同时报名几个名额（带朋友 / 包场 / 连场）。
     * 服务端在同一事务内生成 seats 条独立报名记录，每条可单独取消/退款。
     */
    seats: z.number().int().min(1, '报名人数至少 1 人').max(10, '单次最多报名 10 人').default(1),
    /** 已提示过时段冲突、用户仍要报名时置 true */
    ignoreConflict: z.boolean().default(false),
    /** 每个名额最多一张券；数量不得超过 seats，由服务端复核归属与状态 */
    couponIds: registrationCouponIdsSchema,
  })
  .strict()
  .refine((v) => v.couponIds.length <= v.seats, {
    path: ['couponIds'],
    message: '优惠券数量不能超过报名名额数',
  });
export type RegistrationCreatePayload = z.infer<typeof registrationCreateSchema>;

export const registrationCancelSchema = z
  .object({ reason: z.string().trim().max(200).optional() })
  .strict();
export type RegistrationCancelPayload = z.infer<typeof registrationCancelSchema>;

/**
 * 后台手动录入（线下报名）。
 *
 * 与线上报名的差异：
 * - 不扣积分、不用优惠券，金额按该账号当前等级取价；
 * - paymentStatus 由运营选择（已现场收款 / 待收款），后续仍走「确认收款」；
 * - 报名窗口与时段冲突不拦截（线下补录场景），但场次状态、等级可见性、
 *   时段容量仍由服务端校验，避免超卖或把非会员塞进会员场。
 */
/**
 * 手动录入（线下补录）。
 *
 * 与线上自助登记对齐的部分：名额数、优惠券、按等级取价、服务端重算金额。
 * 不同之处只有两点，都是为了「现场/事后补录」这个场景：
 *   - 不拦截报名窗口与时段冲突；
 *   - 结算方式由运营显式选择（扣积分 / 线下收款 / 免费赠票），而不是由是否有余额推定。
 */
export const ADMIN_MANUAL_SETTLE_MODES = ['CREDIT', 'OFFLINE_PAID', 'OFFLINE_UNPAID', 'FREE'] as const;
export type AdminManualSettleMode = (typeof ADMIN_MANUAL_SETTLE_MODES)[number];

/** 结算方式的中文标签与说明，前后端共用，避免两处文案漂移 */
export const ADMIN_MANUAL_SETTLE_META: Readonly<Record<AdminManualSettleMode, { label: string; hint: string }>> = {
  CREDIT: { label: '扣积分', hint: '仅会员可用；提交后立即冻结对应积分并记账本流水' },
  OFFLINE_PAID: { label: '线下已收', hint: '不扣积分，报名记为已收款' },
  OFFLINE_UNPAID: { label: '线下待收', hint: '不扣积分，报名记为待收款，可稍后点「确认收款」' },
  FREE: { label: '免费', hint: '不扣积分也不计收款，适用于赠票 / 邀请' },
};

export const adminRegistrationCreateSchema = z
  .object({
    wechatId: z.string().trim().min(1, '请填写报名账号的微信号').max(64),
    eventId: idSchema,
    sessionId: idSchema,
    /** 名额数：与自助登记同一上限，一次最多 10 个 */
    seats: z.number().int().min(1).max(10).default(1),
    /**
     * 结算方式：
     * - CREDIT        扣积分（仅会员且余额足够；服务端记账本流水）
     * - OFFLINE_PAID  线下已收款，不扣积分
     * - OFFLINE_UNPAID 线下待收款，不扣积分
     * - FREE          免费赠票，不扣积分也不计收款
     */
    settleMode: z.enum(ADMIN_MANUAL_SETTLE_MODES).default('OFFLINE_UNPAID'),
    /** 优惠券：每名额最多一张，线下收款同样可用；金额服务端重算 */
    couponIds: z.array(idSchema).max(10).default([]),
    /** 到场状态：现场已确认则直接记 CHECKED_IN */
    arriveStatus: z.enum(['CONFIRMED', 'CHECKED_IN']).default('CONFIRMED'),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.couponIds.length > v.seats) {
      ctx.addIssue({ code: 'custom', path: ['couponIds'], message: '优惠券数量不能超过名额数' });
    }
    if (new Set(v.couponIds).size !== v.couponIds.length) {
      ctx.addIssue({ code: 'custom', path: ['couponIds'], message: '同一张券不能重复使用' });
    }
  });
export type AdminRegistrationCreatePayload = z.infer<typeof adminRegistrationCreateSchema>;

/** 手动录入前按微信号查账号，避免运营盲填后提交才报错 */
export const adminRegistrationLookupQuerySchema = z
  .object({ wechatId: z.string().trim().min(1).max(64) })
  .strict();
export type AdminRegistrationLookupQuery = z.infer<typeof adminRegistrationLookupQuerySchema>;

/**
 * 时段级回避名单（由运营配置）。
 *
 * 只给运营用：SVIP 不直接操作，避免把会员目录暴露给普通会员，
 * 也避免会员之间因为一件小事互相设限。运营拿到诉求后代为配置。
 */
export const sessionAvoidRuleCreateSchema = z
  .object({
    sessionId: idSchema,
    /** 为哪位会员设置（通常是已报名的 SVIP）；留空表示运营出于其它原因配置 */
    ownerUserId: idSchema.nullable().optional(),
    blockedUserId: idSchema,
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.ownerUserId && v.ownerUserId === v.blockedUserId) {
      ctx.addIssue({ code: 'custom', path: ['blockedUserId'], message: '不能把本人加入回避名单' });
    }
  });
export type SessionAvoidRuleCreatePayload = z.infer<typeof sessionAvoidRuleCreateSchema>;

export const sessionAvoidRuleListQuerySchema = z
  .object({ sessionId: idSchema })
  .strict();
export type SessionAvoidRuleListQuery = z.infer<typeof sessionAvoidRuleListQuerySchema>;

/**
 * 后台管理：只传「意图」，不传目标状态。
 * 服务端把 action 映射为目标状态后，再用 REGISTRATION_TRANSITIONS 校验合法性。
 */
export const adminRegistrationActionSchema = z
  .object({
    action: z.enum(['CANCEL', 'CHECK_IN']),
    reason: reasonSchema,
  })
  .strict();
export type AdminRegistrationActionPayload = z.infer<typeof adminRegistrationActionSchema>;

/** 仅供后台筛选参数校验，不用于状态写入 */
export const registrationStatusFilterSchema = z.enum(REGISTRATION_STATUSES);

/**
 * 批量操作：现场签到与确认收款都是一屏一屏来的，逐条点会让人在活动当天反复等待请求。
 * - ids 上限 200：再多就不是「现场批量」而是数据修复，应当走导入/脚本；
 * - 只传意图，每条仍按单条逻辑逐条校验状态机，非法的那几条跳过而不是整批失败。
 */
export const adminRegistrationBatchSchema = z
  .object({
    action: z.enum(['CANCEL', 'CHECK_IN', 'CONFIRM_PAYMENT']),
    ids: z.array(idSchema).min(1, '请至少选择一条报名').max(200, '单次最多处理 200 条'),
    reason: reasonSchema.optional(),
  })
  .strict();
export type AdminRegistrationBatchPayload = z.infer<typeof adminRegistrationBatchSchema>;

/** 批量结果：成功的 id 与失败明细，前端据此提示「成功 N 条 / 跳过 M 条」 */
export interface AdminRegistrationBatchResult {
  action: AdminRegistrationBatchPayload['action'];
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
}
