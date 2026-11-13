/**
 * 能力（capability）常量与「等级/后台身份 → 能力」的唯一映射。
 *
 * 安全边界：
 * 1. 后端接口按 capability 判定，禁止散落 `if (level === 'VIP')`；
 * 2. 前端复用同一份能力清单，但**只用于渲染**，不构成安全边界；
 * 3. 等级由服务端按有效期实时计算后传入，不信任 token 中的角色声明。
 */
import { BACKEND_ROLES, type BackendRole, type MemberLevel } from './roles';

export const CAPABILITIES = [
  'event:public:view',
  'event:vip:view',
  'event:svip:view',
  'model:public:view',
  'registration:create',
  'registration:special:create',
  'registration:cancel:self',
  'refund:request:self',
  'balance:read:self',
  'vote:result:read',
  'vote:cast',
  'model:self:write',
  'admin:event:write',
  'admin:model:write',
  /** 场景库：拍摄场地档案的增删改（点4） */
  'admin:scene:write',
  'admin:registration:write',
  'admin:refund:review',
  'admin:balance:adjust:request',
  /** 重置用户密码：仅管理员与运维账号可用 */
  'admin:user:reset-password',
  'admin:membership:grant',
  'admin:membership:revoke',
  'admin:vote:write',
  'admin:vote:publish',
  /** 后台上传图片（场次海报、当日服装、投票方案图） */
  'admin:media:upload',
  /** 注册邀请码：查看列表 / 批量生成与作废 */
  'admin:invite:read',
  'admin:invite:write',
  'admin:audit:read',
  /** 权限变更日志（授予/撤销会员、角色调整）——比审计更敏感，单独一个能力 */
  'admin:permission:log:read',
  'admin:export',
  'admin:system:config',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** 游客：仅公开内容 */
const GUEST: readonly Capability[] = ['event:public:view', 'model:public:view'];

/** 注册用户（level=NONE 但已登录） */
const REGISTERED: readonly Capability[] = [
  ...GUEST,
  'registration:create',
  'registration:cancel:self',
  'refund:request:self',
  'balance:read:self',
];

/** 各有效等级的**完整**能力集（已含继承），避免运行时合并出错 */
export const LEVEL_CAPABILITIES: Readonly<Record<MemberLevel, readonly Capability[]>> = {
  NONE: REGISTERED,
  VIP: [...REGISTERED, 'event:vip:view', 'registration:special:create'],
  SVIP: [
    ...REGISTERED,
    'event:vip:view',
    'registration:special:create',
    'event:svip:view',
    'vote:cast',
    'vote:result:read',
  ],
};

/**
 * 后台身份能力集；与等级正交，取并集。
 *
 * 权限边界：
 * - ADMIN 是**日常业务最高权限**：场次/模特/报名/投票/会员/财务全权，
 *   但**不碰系统区**（审计日志、权限日志、脱敏导出、系统配置一律没有）；
 * - SUPER_ADMIN 面向运维：独占系统区四项能力，账号不出现在用户列表、也不能在后台创建；
 * - OPERATOR 不碰钱与会员；FINANCE 只管钱；MODEL 只维护自己的资料。
 */
export const BACKEND_ROLE_CAPABILITIES: Readonly<Record<BackendRole, readonly Capability[]>> = {
  MODEL: ['model:self:write'],
  OPERATOR: [
    'admin:event:write',
    'admin:model:write',
    'admin:scene:write',
    'admin:registration:write',
    'admin:vote:write',
    'admin:vote:publish',
    'admin:media:upload',
  ],
  FINANCE: [
    'admin:refund:review',
    'admin:balance:adjust:request',
  ],
  ADMIN: [
    'admin:event:write',
    'admin:model:write',
    'admin:scene:write',
    'admin:registration:write',
    'admin:refund:review',
    'admin:balance:adjust:request',
    'admin:user:reset-password',
    'admin:membership:grant',
    'admin:membership:revoke',
    'admin:vote:write',
    'admin:vote:publish',
    'admin:media:upload',
    'admin:invite:read',
    'admin:invite:write',
  ],
  SUPER_ADMIN: [
    'admin:event:write',
    'admin:model:write',
    'admin:scene:write',
    'admin:registration:write',
    'admin:refund:review',
    'admin:balance:adjust:request',
    'admin:user:reset-password',
    'admin:membership:grant',
    'admin:membership:revoke',
    'admin:vote:write',
    'admin:vote:publish',
    'admin:media:upload',
    'admin:invite:read',
    'admin:invite:write',
    'admin:audit:read',
    'admin:permission:log:read',
    'admin:export',
    'admin:system:config',
  ],
};

/** 只有运维级超级管理员才有的能力（系统区四项，管理员一律没有） */
export const SUPER_ADMIN_ONLY_CAPABILITIES: readonly Capability[] = [
  'admin:audit:read',
  'admin:permission:log:read',
  'admin:export',
  'admin:system:config',
];

/** 供服务端 /me/capabilities 使用的入参；level 必须是「按 now 计算后的有效等级」 */
export interface CapabilityContext {
  authenticated: boolean;
  level: MemberLevel;
  backendRoles: readonly BackendRole[];
}

export function capabilitiesFor(ctx: CapabilityContext): ReadonlySet<Capability> {
  const result = new Set<Capability>();
  const base: readonly Capability[] = ctx.authenticated
    ? LEVEL_CAPABILITIES[ctx.level]
    : GUEST;
  base.forEach((c) => result.add(c));
  if (ctx.authenticated) {
    for (const role of ctx.backendRoles) {
      if (!(BACKEND_ROLES as readonly string[]).includes(role)) continue;
      BACKEND_ROLE_CAPABILITIES[role].forEach((c) => result.add(c));
    }
  }
  return result;
}

export function can(capabilities: ReadonlySet<string>, required: Capability): boolean {
  return capabilities.has(required);
}

export function canAll(capabilities: ReadonlySet<string>, required: readonly Capability[]): boolean {
  return required.every((c) => capabilities.has(c));
}
