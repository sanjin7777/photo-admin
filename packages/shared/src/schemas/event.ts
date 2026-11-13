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
    modelId: idSchema.nullable().optional(),
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
export const adminRegistrationCreateSchema = z
  .object({
    wechatId: z.string().trim().min(1, '请填写报名账号的微信号').max(64),
    eventId: idSchema,
    sessionId: idSchema,
    paymentStatus: z.enum(['PAID', 'UNPAID']).default('UNPAID'),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();
export type AdminRegistrationCreatePayload = z.infer<typeof adminRegistrationCreateSchema>;

/** 手动录入前按微信号查账号，避免运营盲填后提交才报错 */
export const adminRegistrationLookupQuerySchema = z
  .object({ wechatId: z.string().trim().min(1).max(64) })
  .strict();
export type AdminRegistrationLookupQuery = z.infer<typeof adminRegistrationLookupQuerySchema>;

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
