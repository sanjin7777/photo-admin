/**
 * 认证相关 schema。
 *
 * ⚠️ 合规边界：邮箱仅做**格式**与唯一性校验，不代表实名认证能力；
 * 系统不实现、也不声称具备实名核验。密码由服务端 argon2id/bcrypt 哈希。
 * 手机号已按 2026-11-10 用户决策从注册与用户资料中移除，字段保留在 DDL 里
 * 以兼容历史数据，但不再对外采集与展示。
 */
import { z } from 'zod';
import { MEMBER_LEVELS } from '../roles';
import { ASSIGNABLE_BACKEND_ROLES } from '../roles';

export const emailSchema = z.string().trim().email('邮箱格式不正确').max(128);

export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 位')
  .max(64, '密码不超过 64 位')
  .regex(/[A-Za-z]/, '密码需包含字母')
  .regex(/\d/, '密码需包含数字');

/** 微信号：字母开头，6–20 位，允许数字、下划线、连字符 */
export const wechatIdSchema = z
  .string()
  .trim()
  .min(6, '微信号至少 6 位')
  .max(20, '微信号最多 20 位')
  .regex(/^[A-Za-z][A-Za-z0-9_-]{5,19}$/, '微信号需字母开头，仅含字母、数字、下划线、连字符');

/** 邀请码：生成时全大写、剔除易混淆字符；服务端统一转大写后比对 */
export const inviteCodeSchema = z
  .string()
  .trim()
  .min(8, '邀请码至少 8 位')
  .max(16, '邀请码最多 16 位')
  .regex(/^[A-Za-z2-9]{8,16}$/, '邀请码格式不正确，请向管理员获取')
  .transform((value) => value.toUpperCase());

export const registerSchema = z
  .object({
    wechatId: wechatIdSchema,
    password: passwordSchema,
    nickname: z.string().trim().min(2).max(24),
    /** 注册必填：一码一次性，由管理员在后台生成 */
    inviteCode: inviteCodeSchema,
    /** 必须主动勾选同意用户协议与隐私政策，服务端留痕 */
    agreed: z.literal(true, { message: '请阅读并同意用户协议与隐私政策' }),
  })
  .strict();
export type RegisterPayload = z.infer<typeof registerSchema>;

/** 同意最新版协议：只接受明确的 true，避免误传空对象被当成同意 */
export const consentAcceptSchema = z
  .object({ agreed: z.literal(true, { message: '请阅读并勾选同意' }) })
  .strict();
export type ConsentAcceptPayload = z.infer<typeof consentAcceptSchema>;

export const loginSchema = z
  .object({
    wechatId: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(64),
  })
  .strict();
export type LoginPayload = z.infer<typeof loginSchema>;

/**
 * 本人修改密码：需验证当前密码（导入账号首次登录时即为运营发放的初始口令）。
 * 新密码沿用注册规则；改密成功后所有其它设备的会话立即失效。
 */
export const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1, '请输入当前密码').max(64),
    newPassword: passwordSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.oldPassword === v.newPassword) {
      ctx.addIssue({ code: 'custom', message: '新密码不能与当前密码相同', path: ['newPassword'] });
    }
  });
export type ChangePasswordPayload = z.infer<typeof changePasswordSchema>;

export const refreshSchema = z
  .object({ refreshToken: z.string().min(1) })
  .strict();
export type RefreshPayload = z.infer<typeof refreshSchema>;

/**
 * 后台创建用户（运营代注册 / 老会员补录）。
 * 注意：roles 只能是 ASSIGNABLE_BACKEND_ROLES，**不含运维账号**。
 */
export const adminCreateUserSchema = z
  .object({
    wechatId: wechatIdSchema,
    nickname: z.string().trim().min(2, '昵称至少 2 个字').max(24),
    password: passwordSchema,
    level: z.enum(MEMBER_LEVELS).default('NONE'),
    /** 不传 = 永久有效（内部存 9999-12-31） */
    expireAt: z.string().datetime({ offset: true }).nullable().optional(),
    roles: z.array(z.enum(ASSIGNABLE_BACKEND_ROLES)).max(3).default([]),
    /** 初始积分（1 积分 = 1 元）；仅会员可填，0 或不填表示不建积分账户 */
    balanceYuan: z.number().min(0, '积分不能为负').max(1_000_000).optional(),
    /** 赠送积分（元）；随初始积分一起发放，单独记一条 BONUS 流水；仅会员可填 */
    bonusYuan: z.number().min(0, '赠送积分不能为负').max(1_000_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.expireAt && new Date(v.expireAt).getTime() <= Date.now()) {
      ctx.addIssue({ code: 'custom', message: '有效期必须晚于当前时间', path: ['expireAt'] });
    }
    if (v.level === 'NONE' && v.balanceYuan) {
      ctx.addIssue({ code: 'custom', message: '普通用户没有积分账户，请先选择会员等级', path: ['balanceYuan'] });
    }
    if (v.level === 'NONE' && v.bonusYuan) {
      ctx.addIssue({ code: 'custom', message: '普通用户没有积分账户，请先选择会员等级', path: ['bonusYuan'] });
    }
  });
export type AdminCreateUserPayload = z.infer<typeof adminCreateUserSchema>;

/**
 * 后台编辑用户。
 * 微信号是登录标识，不允许改；密码走单独的重置流程。
 */
export const adminUpdateUserSchema = z
  .object({
    nickname: z.string().trim().min(2, '昵称至少 2 个字').max(24).optional(),
    /** 传 NONE 表示降级为普通用户（会结束当前会员记录） */
    level: z.enum(MEMBER_LEVELS).optional(),
    /** 仅在 level 为 VIP/SVIP 时有意义；null 表示改为永久有效 */
    expireAt: z.string().datetime({ offset: true }).nullable().optional(),
    roles: z.array(z.enum(ASSIGNABLE_BACKEND_ROLES)).max(3).optional(),
    status: z.enum(['ACTIVE', 'FROZEN']).optional(),
  })
  .strict();
export type AdminUpdateUserPayload = z.infer<typeof adminUpdateUserSchema>;

/**
 * 重置密码：仅管理员 / 运维超管可用；用微信号定位。
 * 服务端生成随机临时口令并一次性返回，旧会话立即失效。
 */
export const adminResetPasswordSchema = z
  .object({
    wechatId: z.string().trim().min(1, '请填写微信号').max(64),
  })
  .strict();
export type AdminResetPasswordPayload = z.infer<typeof adminResetPasswordSchema>;
