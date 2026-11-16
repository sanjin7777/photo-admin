/**
 * 优惠券契约。
 *
 * 金额一律由服务端按「档位价（会员价/活动价）」重算：
 *   折扣券：round(基准价 × 折扣率)，可设最高优惠封顶；
 *   立减券：min(基准价, 立减金额)，最低减到 0 元。
 * 一次报名 N 个名额最多用 N 张券，多出的名额按原价。
 */
import { z } from 'zod';
import { COUPON_TYPES, type CouponType } from '../enums';
import { centSchema, idSchema, isoDateTimeSchema, pageQuerySchema } from './common';

/** 折扣率用万分比表示：8500 = 85 折，最低 1 折、最高 99.99 折 */
const discountBpSchema = z
  .number()
  .int('折扣必须为整数万分比')
  .min(100, '折扣不能低于 1 折')
  .max(9999, '折扣必须小于原价');

export const adminCouponIssueSchema = z
  .object({
    /** 按微信号发券，可一次发给多人；每个用户各生成一张独立券 */
    wechatIds: z.array(z.string().trim().min(1).max(64)).min(1, '至少选择 1 个用户').max(50, '单次最多发放 50 人'),
    title: z.string().trim().min(2, '券名称至少 2 个字符').max(32, '券名称不超过 32 个字符'),
    type: z.enum(COUPON_TYPES),
    /** 折扣券必填 */
    discountBp: discountBpSchema.nullable().optional(),
    /** 立减券必填 */
    amountCent: centSchema.nullable().optional(),
    /** 单席最低消费门槛；0 表示无门槛 */
    minSpendCent: centSchema.default(0),
    /** 折扣券最高优惠封顶；null 表示不封顶 */
    maxDiscountCent: centSchema.nullable().optional(),
    expiresAt: isoDateTimeSchema.nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.wechatIds).size !== v.wechatIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wechatIds'], message: '同一用户不要重复选择' });
    }
    if (v.type === 'DISCOUNT') {
      if (v.discountBp == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountBp'], message: '折扣券必须填写折扣' });
      }
      if (v.amountCent != null && v.amountCent > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountCent'], message: '折扣券不能同时填写立减金额' });
      }
    } else {
      if (v.amountCent == null || v.amountCent < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountCent'], message: '立减券必须填写立减金额' });
      }
      if (v.discountBp != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountBp'], message: '立减券不能填写折扣' });
      }
      if (v.maxDiscountCent != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxDiscountCent'], message: '立减券不支持优惠封顶' });
      }
    }
  });
export type AdminCouponIssuePayload = z.infer<typeof adminCouponIssueSchema>;

export const adminCouponListQuerySchema = pageQuerySchema.extend({
  status: z.enum(['UNUSED', 'USED', 'EXPIRED', 'REVOKED']).optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type AdminCouponListQueryInput = z.infer<typeof adminCouponListQuerySchema>;

/** 报名携带的券：每个名额一张，数量不得超过名额数 */
export const registrationCouponIdsSchema = z
  .array(idSchema)
  .max(10, '单次最多使用 10 张券')
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, '同一张券不能重复使用');

export interface CouponFace {
  type: CouponType;
  discountBp: number | null;
  amountCent: number | null;
  maxDiscountCent: number | null;
}

/**
 * 计算单席优惠金额（分）。
 * 与前端确认弹窗、服务端结算共用同一实现，避免「页面算出来和实际扣减不一致」。
 *
 * ⚠️ `discountBp` 的语义是**实付比例**：8 折 = 8000bp = 实付 80%。
 * 因此减免额 = 原价 ×(1 − bp/10000)，而不是 原价 × bp/10000
 * （后者算出来的是折后价，曾导致 8 折券被当成「减 80%」，实收只有原价的 20%）。
 */
export function couponDiscountOf(coupon: CouponFace, baseCent: number): number {
  const base = Math.max(0, Math.round(baseCent));
  if (base === 0) return 0;
  if (coupon.type === 'AMOUNT') {
    return Math.max(0, Math.min(base, Math.round(Number(coupon.amountCent ?? 0))));
  }
  const bp = Math.max(0, Math.min(10000, Math.round(Number(coupon.discountBp ?? 10000))));
  // 先算减免额（原价 − 折后价），封顶作用于减免额本身
  const raw = base - Math.round((base * bp) / 10000);
  const capped = coupon.maxDiscountCent == null
    ? raw
    : Math.min(raw, Math.max(0, Math.round(Number(coupon.maxDiscountCent))));
  return Math.max(0, Math.min(base, capped));
}
