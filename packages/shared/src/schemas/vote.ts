/**
 * 投票相关 schema。
 *
 * 安全边界：SVIP 资格**不在此校验**（schema 拿不到会话），
 * 必须由服务端在每次提交/改票时按 now 重查有效会员状态；一人一票由 DB 唯一约束兜底。
 */
import { z } from 'zod';
import { idSchema, refineChronological, isoDateTimeSchema } from './common';

/** 方案图允许站内上传路径（/uploads/...）或 http(s) 绝对地址；z.url() 会误杀前者 */
const voteImageUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (v) => (v.startsWith('/') ? !v.startsWith('//') : /^https?:\/\//i.test(v)),
    '图片地址必须是 http(s) 链接或以 / 开头的站内路径',
  );

/**
 * 方案输入：后台编辑时带 id 表示更新已有方案，不带 id 表示新增。
 * 未提交的已选方案视为删除，服务端会拒绝删除已有票的方案。
 */
export const voteOptionInputSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(60),
    imageUrl: voteImageUrlSchema.nullable().optional(),
    sort: z.number().int().min(0).max(9999).default(0),
  })
  .strict();

export const voteCampaignCreateBaseSchema = z
  .object({
    /** 可选：投票活动可以独立于场次存在；不关联时传 null 或省略 */
    eventId: idSchema.nullish(),
    /** 可选：直接关联模特（点C），前台投票页据此展示模特资料；不关联时传 null 或省略 */
    modelId: idSchema.nullish(),
    title: z.string().trim().min(2).max(80),
    openAt: isoDateTimeSchema,
    closeAt: isoDateTimeSchema,
    maxVotesPerUser: z.number().int().min(1).max(10).default(1),
    options: z.array(voteOptionInputSchema).min(2, '至少 2 个服装方案').max(20),
  })
  .strict();

export const voteCampaignCreateSchema = voteCampaignCreateBaseSchema.superRefine((v, ctx) => {
  refineChronological(v as unknown as Record<string, unknown>, ['openAt', 'closeAt'], ctx);
});
export type VoteCampaignCreatePayload = z.infer<typeof voteCampaignCreateSchema>;

export const voteCampaignPatchSchema = voteCampaignCreateBaseSchema.partial().strict();
export type VoteCampaignPatchPayload = z.infer<typeof voteCampaignPatchSchema>;

export const voteCastSchema = z
  .object({
    campaignId: idSchema,
    optionId: idSchema,
  })
  .strict();
export type VoteCastPayload = z.infer<typeof voteCastSchema>;
