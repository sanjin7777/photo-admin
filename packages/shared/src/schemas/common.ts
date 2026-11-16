/**
 * 共享 Zod 校验原语。
 *
 * 这些 schema 由「前端 Vant / Element Plus 表单 adapter」与「Node 服务端」共同引用，
 * 是唯一一份规则来源。前端校验只做提示，服务端必须二次校验。
 */
import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants';
import { PAYMENT_STATUSES, REGISTRATION_STATUSES } from '../enums';
import type { RefundPolicy } from '../types/common';

/** BIGINT 主键以字符串传输 */
export const idSchema = z.string().regex(/^[1-9]\d*$/, 'ID 必须为正整数字符串');

/** 金额：非负整数分 */
export const centSchema = z
  .number()
  .int('金额必须为整数（分）')
  .nonnegative('金额不能为负')
  .max(Number.MAX_SAFE_INTEGER, '金额超出安全范围');

/** 人工调账金额：可正可负，但不得为 0 */
export const signedCentSchema = z
  .number()
  .int('金额必须为整数（分）')
  .refine((v) => v !== 0 && Number.isSafeInteger(v), '调账金额必须为非零安全整数');

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: '时间必须为带时区的 ISO 8601 字符串' });

export const idempotencyKeySchema = z.string().uuid('幂等键必须为 UUID');

export const reasonSchema = z.string().trim().min(2, '请填写操作原因').max(200, '原因不超过 200 字');

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  sort: z.string().max(64).optional(),
});
export type PageQueryInput = z.infer<typeof pageQuerySchema>;

/**
 * 前台场次列表查询。
 *
 * `scope` 用来区分「近期场次」与「历史活动」两块：
 * - `upcoming`：还没开始的场次（游客默认只看这块）
 * - `past`：已经结束的场次，**仅登录用户可请求**，游客请求会被服务端拒绝
 *
 * 判定基准是场次的开始时间 `start_at`（不是报名截止时间）——一次活动一旦开演，
 * 就归入历史，避免把正在进行中的场次算作「即将开始」。
 */
export const publicEventListQuerySchema = pageQuerySchema.extend({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
});
export type PublicEventListQueryInput = z.infer<typeof publicEventListQuerySchema>;

/**
 * 日期范围筛选（财务对账、报名统计都按自然日看）。
 *
 * 只收 `YYYY-MM-DD`，不收到秒的时间戳：运营选的是「10 月 1 日到 10 月 7 日」，
 * 语义是**含首含尾的自然日**。服务端据此转成 `>= dateFrom 00:00:00` 与
 * `< dateTo 次日 00:00:00`，避免「10 月 7 日 15:00 的单子被漏掉」这类经典错。
 * 不校验 from <= to：顺序反了返回空列表比报错更符合预期（用户自己能看出来）。
 */
export const dateRangeSchema = {
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional(),
};

/**
 * 后台用户列表查询。
 *
 * ⚠️ validateQuery 会用校验结果**整体覆盖** req.query，schema 里没声明的键会被丢掉。
 * 所以凡是接口要用的筛选参数，都必须在这里显式声明，否则筛选会静默失效。
 */
export const adminUserListQuerySchema = pageQuerySchema.extend({
  keyword: z.string().trim().max(64).optional(),
  level: z.enum(['NONE', 'VIP', 'SVIP']).optional(),
});
export type AdminUserListQueryInput = z.infer<typeof adminUserListQuerySchema>;

/**
 * 后台报名列表查询。
 *
 * eventId 用于「从场次管理进入报名管理，只看该场次的报名」；
 * 同样受 validateQuery 覆盖 req.query 的约束，参数必须显式声明。
 */
export const adminRegistrationListQuerySchema = pageQuerySchema.extend({
  eventId: idSchema.optional(),
  sessionId: idSchema.optional(),
  /** 状态筛选：报名量会持续增长，筛选必须下推到 SQL，不能只在前端过滤当前页 */
  status: z.enum(REGISTRATION_STATUSES).optional(),
  /** 收款状态筛选：概览「待收款」入口直接带 pay=UNPAID 进来 */
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  /** 关键词：匹配微信号或场次名称 */
  keyword: z.string().trim().max(64).optional(),
  /** 报名时间范围（含首含尾的自然日），财务对账与运营复盘按天看 */
  ...dateRangeSchema,
});
export type AdminRegistrationListQueryInput = z.infer<typeof adminRegistrationListQuerySchema>;

/**
 * 下拉选人选项查询（手动录入 / 发券共用）。
 * 只返回运营需要的最小字段；limit caps 防止一次拉全表。
 */
export const adminUserOptionsQuerySchema = z
  .object({
    keyword: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type AdminUserOptionsQueryInput = z.infer<typeof adminUserOptionsQuerySchema>;

/** 审计 / 权限日志查询：按动作精确筛，keyword 匹配操作人微信号、动作、对象类型或对象 ID */
export const auditLogQuerySchema = pageQuerySchema.extend({
  action: z.string().trim().max(64).optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;

/** 与 types/common.ts 的 RefundPolicy 单一来源：类型不符会在编译期报错 */
export const refundPolicySchema: z.ZodType<RefundPolicy> = z
  .object({
    freeCancelBeforeHours: z.number().int().min(0).max(720),
    feeRatio: z.number().min(0).max(1),
  })
  .strict();

/**
 * 通用时间链校验：按 keys 顺序要求严格递增。
 * 各域 schema 在自己的 superRefine 中调用，避免时间窗口规则各写一份。
 */
export function refineChronological(
  value: Record<string, unknown>,
  keys: readonly string[],
  ctx: z.RefinementCtx,
): void {
  for (let i = 0; i < keys.length - 1; i += 1) {
    const current = keys[i] as string;
    const next = keys[i + 1] as string;
    const a = value[current];
    const b = value[next];
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) continue;
    if (ta >= tb) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [next],
        message: `${next} 必须晚于 ${current}`,
      });
    }
  }
}
