/**
 * 资金与会员相关 schema。
 *
 * ⚠️ 合规边界：本系统只做内部记账（线下收款后由财务手工入账），
 * 不接支付通道、不做清算与提现；上线前需评估预付资金资质，见方案 §7.4。
 * 所有余额写入必须由服务端在事务内追加 append-only 流水，禁止直改账户余额。
 */
import { z } from 'zod';
import { PAID_LEVELS } from '../roles';
import { BALANCE_BIZ_TYPES, REFUND_STATUSES } from '../enums';
import { dateRangeSchema, idSchema, reasonSchema, signedCentSchema, refineChronological, isoDateTimeSchema, pageQuerySchema } from './common';

export const refundRequestSchema = z
  .object({
    registrationId: idSchema,
    reason: z.string().trim().max(200).optional(),
  })
  .strict();
export type RefundRequestPayload = z.infer<typeof refundRequestSchema>;

export const refundReviewSchema = z
  .object({
    approve: z.boolean(),
    /** 拒绝时必填 */
    remark: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.approve && !v.remark) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remark'],
        message: '拒绝退款时必须填写原因',
      });
    }
  });
export type RefundReviewPayload = z.infer<typeof refundReviewSchema>;

/**
 * 线下退款落定（补记对账痕迹）。
 *
 * 非会员走线下支付，审核通过只代表「同意退款」，钱还要运营线下转给用户。
 * 运营实际退款后调这个接口补记经办人与时间，财务据此区分「已批准」与「已实际退款」。
 * remark 选填，用来记转账尾号 / 收款方式等对账线索。
 */
export const refundSettleSchema = z
  .object({
    remark: z.string().trim().max(200).optional(),
  })
  .strict();
export type RefundSettlePayload = z.infer<typeof refundSettleSchema>;

/**
 * 后台退款单列表查询。
 *
 * 退款单只增不减，筛选必须下推到 SQL（全量拉取再前端过滤迟早撑不住）。
 * settle 维度单独给一个枚举：`UNSETTLED` = 已通过但线下还没退钱的挂账单，
 * 这个口径是 `status='REFUNDED' AND settled_at IS NULL`，不能用 status 表达。
 */
export const adminRefundListQuerySchema = pageQuerySchema.extend({
  status: z.enum(REFUND_STATUSES).optional(),
  settle: z.enum(['UNSETTLED', 'SETTLED']).optional(),
  /** 关键词：匹配申请人微信号 / 昵称 / 场次名 / 时段名 / 报名编号 */
  keyword: z.string().trim().max(64).optional(),
  /** 申请时间范围（含首含尾的自然日）：财务按月对账时不必导出 CSV 再筛 */
  ...dateRangeSchema,
});
export type AdminRefundListQueryInput = z.infer<typeof adminRefundListQuerySchema>;

/** 后台积分流水列表查询：按业务类型与关键词筛，同样下推 SQL */
export const adminBalanceTxnListQuerySchema = pageQuerySchema.extend({
  bizType: z.enum(BALANCE_BIZ_TYPES).optional(),
  /** 关键词：匹配账户微信号 / 流水备注 */
  keyword: z.string().trim().max(64).optional(),
  /** 流水时间范围（含首含尾的自然日） */
  ...dateRangeSchema,
});
export type AdminBalanceTxnListQueryInput = z.infer<typeof adminBalanceTxnListQuerySchema>;

/** 一步调账：提交即走账本入账，不再二次复核；用**微信号**定位用户（后台看不到用户 ID） */
export const balanceAdjustmentSchema = z
  .object({
    /** 微信号：唯一登录标识 */
    wechatId: z.string().trim().min(1, '请填写微信号').max(64),
    amountCent: signedCentSchema,
    /** 赠送积分（分）；仅在充值（amountCent>0）时可填，单独记一条 BONUS 流水 */
    bonusCent: z.number().int('赠送积分必须为整数分').min(0, '赠送积分不能为负').max(100_000_000).optional(),
    reason: reasonSchema,
    evidenceUrl: z.string().url().max(512).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.bonusCent && v.amountCent <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bonusCent'], message: '赠送积分只能随充值（正数金额）一起发放' });
    }
  });
export type BalanceAdjustmentPayload = z.infer<typeof balanceAdjustmentSchema>;

/**
 * 授予会员。
 *
 * 2026-11-10 用户决策：
 *  · 用**微信号**定位用户（后台人员看到的是微信号，用户 ID 不直观）；
 *  · 增加「入账金额」，授予时同步给余额账户入账（线下收款后财务一次性登记）；
 *  · 有效期默认永久：expireAt 不传即永久有效（服务端存 9999-12-31）。
 */
export const membershipGrantBaseSchema = z
  .object({
    /** 微信号：唯一登录标识 */
    wechatId: z.string().trim().min(1, '请填写微信号').max(64),
    level: z.enum(PAID_LEVELS),
    startAt: isoDateTimeSchema,
    /** 不传 = 永久有效 */
    expireAt: isoDateTimeSchema.optional(),
    /** 同步入账金额（元）；0 或不填表示不充值 */
    amountYuan: z.number().min(0, '入账金额不能为负').max(1_000_000).optional(),
    /** 赠送积分（元）；随入账一起发放，单独记一条 BONUS 流水 */
    bonusYuan: z.number().min(0, '赠送积分不能为负').max(1_000_000).optional(),
    reason: reasonSchema,
  })
  .strict();

export const membershipGrantSchema = membershipGrantBaseSchema.superRefine((v, ctx) => {
  if (v.expireAt) {
    refineChronological(v as unknown as Record<string, unknown>, ['startAt', 'expireAt'], ctx);
  }
});
export type MembershipGrantPayload = z.infer<typeof membershipGrantSchema>;

export const membershipRevokeSchema = z.object({ reason: reasonSchema }).strict();
export type MembershipRevokePayload = z.infer<typeof membershipRevokeSchema>;
