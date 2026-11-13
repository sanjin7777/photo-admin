/**
 * 邀请码相关请求校验。
 *
 * 规则：前台注册必须携带邀请码；一个邀请码只能使用一次；由管理员在后台批量生成。
 * 管理员代注册（/admin/users）与 Excel 导入不走此 schema，也不消耗邀请码。
 */
import { z } from 'zod';
import { pageQuerySchema } from './common';

/** 单次最多生成 50 个；默认不设有效期，直到被使用或作废 */
export const inviteCodeCreateSchema = z
  .object({
    count: z.number().int().min(1, '至少生成 1 个').max(50, '单次最多生成 50 个').default(1),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now()) {
      ctx.addIssue({ code: 'custom', message: '有效期必须晚于当前时间', path: ['expiresAt'] });
    }
  });
export type InviteCodeCreatePayload = z.infer<typeof inviteCodeCreateSchema>;

/**
 * 后台邀请码列表查询。
 * ⚠️ validateQuery 会用解析结果覆盖 req.query，筛选参数必须在这里显式声明。
 */
export const inviteCodeListQuerySchema = pageQuerySchema.extend({
  status: z.enum(['UNUSED', 'USED', 'REVOKED']).optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type InviteCodeListQueryInput = z.infer<typeof inviteCodeListQuerySchema>;
