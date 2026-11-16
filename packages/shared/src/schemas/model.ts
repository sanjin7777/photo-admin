/**
 * 模特档案的写入校验（后台上传资料）。
 */
import { z } from 'zod';
import { SOCIAL_PLATFORMS } from '../types/domain';

/** 只允许 http/https：挡住 javascript: / data: 等伪协议，前端直接绑 href 才安全 */
const httpUrlSchema = (message: string) =>
  z
    .string()
    .url(message)
    .max(512)
    .refine((v) => /^https?:\/\//i.test(v), '仅支持 http/https 链接');

export const modelSocialAccountSchema = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    handle: z.string().trim().min(1, '账号不能为空').max(64),
    url: httpUrlSchema('主页地址格式不正确').nullable().default(null),
  })
  .strict();

export const modelProfileUpsertSchema = z
  .object({
    /** 新建时必须给（绑定已注册用户）；编辑时从路径取，忽略此字段 */
    userId: z.string().trim().min(1).optional(),
    stageName: z.string().trim().min(1, '舞台名必填').max(64),
    heightCm: z.number().int().min(100, '身高不合理').max(250, '身高不合理').nullable().optional(),
    /** 三围（敏感，仅会员可见）；各项可空，单位 cm */
    measurements: z
      .object({
        bustCm: z.number().int().min(50, '胸围不合理').max(200, '胸围不合理').nullable().optional(),
        waistCm: z.number().int().min(40, '腰围不合理').max(200, '腰围不合理').nullable().optional(),
        hipCm: z.number().int().min(50, '臀围不合理').max(200, '臀围不合理').nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    portfolioUrl: httpUrlSchema('作品集地址格式不正确').nullable().optional(),
    /** 模特照片（多图），由上传组件写入同源 URL */
    photoUrls: z.array(z.string().trim().max(512)).max(9).default([]),
    socialAccounts: z.array(modelSocialAccountSchema).max(10, '最多 10 个社交账号').default([]),
    /** 模特档案不再有可见性字段（visibility 列已在 007 移除）；场次的可见性另算 */
    portraitAuthStatus: z.enum(['PENDING', 'GRANTED', 'EXPIRED', 'REVOKED']).optional(),
    /**
     * 身高/三围属《个人信息保护法》第 28 条的敏感个人信息，需**单独同意**。
     * 运营勾选此项表示已取得模特本人对「收录并在会员端展示身高与三围」的明确同意；
     * 服务端据此写入 body_data_consent_at 留痕。
     */
    bodyDataConsent: z.boolean().optional(),
    /** 同意方式留痕（口头/书面/线上），选填 */
    bodyDataConsentNote: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
export type ModelProfileUpsertPayload = z.infer<typeof modelProfileUpsertSchema>;
