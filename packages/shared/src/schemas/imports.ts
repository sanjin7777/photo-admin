/**
 * 会员导入的请求校验。
 *
 * commit 阶段回传的是 preview 阶段服务端产出的归一化行，这里再校验一次结构，
 * 业务层还会重新跑格式/唯一性校验——前端回传值一律视为不可信。
 */
import { z } from 'zod';
import { MEMBER_LEVELS } from '../roles';

export const memberImportRowSchema = z
  .object({
    row: z.number().int().min(1),
    wechatId: z.string().trim().min(1).max(64),
    nickname: z.string().trim().min(2).max(24),
    level: z.enum(MEMBER_LEVELS),
    expireAt: z.string().datetime({ offset: true }).nullable(),
    balanceCent: z.number().int().min(0).max(100_000_000).nullable(),
    bonusCent: z.number().int().min(0).max(100_000_000).nullable(),
    remark: z.string().trim().max(200).nullable(),
    status: z.enum(['OK', 'WARN', 'ERROR']),
    messages: z.array(z.string()).max(20),
    exists: z.boolean(),
    existingUserId: z.string().nullable(),
  })
  .strict();

export const memberImportCommitSchema = z
  .object({
    rows: z.array(memberImportRowSchema).min(1, '没有可导入的数据').max(2000, '单次最多导入 2000 行'),
    strict: z.boolean().default(false),
    overwrite: z.boolean().default(false),
  })
  .strict();
export type MemberImportCommitPayloadInput = z.infer<typeof memberImportCommitSchema>;
