/**
 * 后台身份（面向用户只暴露「管理员 / 运营 / 财务 / 模特」四种）：
 *   ADMIN       管理员 —— 日常业务全权（场次/报名/退款/余额/会员/投票/邀请码）
 *   OPERATOR    运营   —— 只管场次、模特、报名、投票，不碰钱与会员
 *   FINANCE     财务   —— 只管退款审核与余额调增申请
 *   MODEL       模特   —— 仅维护自己的模特资料
 *   SUPER_ADMIN 为运维账号，只在数据层保留，独占系统区四项能力；
 *   不出现在用户列表、不可在后台创建、界面一律显示为「管理员」。
 *
 * ⚠️ 与「等级」(NONE/VIP/SVIP) 正交：等级决定可见性与报名资格，后台身份决定管理能力。
 */

export const MEMBER_LEVELS = ['NONE', 'VIP', 'SVIP'] as const;
export type MemberLevel = (typeof MEMBER_LEVELS)[number];

/** 有有效会员记录时的等级（会员表不含 NONE 记录） */
export type PaidLevel = Exclude<MemberLevel, 'NONE'>;
export const PAID_LEVELS = ['VIP', 'SVIP'] as const;

export const BACKEND_ROLES = ['MODEL', 'OPERATOR', 'FINANCE', 'ADMIN', 'SUPER_ADMIN'] as const;
export type BackendRole = (typeof BACKEND_ROLES)[number];

/** 角色展示信息与层级权重（数值越大越高，仅用于排序与提示，不参与判权） */
export const BACKEND_ROLE_META: Readonly<
  Record<BackendRole, { label: string; rank: number; scope: string }>
> = {
  MODEL: { label: '模特', rank: 1, scope: '仅自己的模特资料' },
  FINANCE: { label: '财务', rank: 2, scope: '退款审核、余额调增申请' },
  OPERATOR: { label: '运营', rank: 2, scope: '场次、模特、报名、投票' },
  ADMIN: { label: '管理员', rank: 3, scope: '全部业务管理，不含审计与导出' },
  SUPER_ADMIN: { label: '管理员', rank: 4, scope: '系统维护用，不在界面展示' },
};

/** 仅限运维账号使用的角色集合 */
export const SENSITIVE_ROLES: readonly BackendRole[] = ['SUPER_ADMIN'];

/**
 * 可以在后台界面上给他人授予的角色。
 * 运维账号刻意排除：只能由运维直接在数据库创建，避免后台被横向提权。
 */
export const ASSIGNABLE_BACKEND_ROLES = ['MODEL', 'OPERATOR', 'FINANCE', 'ADMIN'] as const;
export type AssignableBackendRole = (typeof ASSIGNABLE_BACKEND_ROLES)[number];

export function roleLabel(role: BackendRole): string {
  return BACKEND_ROLE_META[role]?.label ?? role;
}

/** 取用户角色中最高的展示名（用于顶栏/侧边栏） */
export function highestRoleLabel(roles: readonly BackendRole[]): string {
  let best: BackendRole | null = null;
  for (const r of roles) {
    const meta = BACKEND_ROLE_META[r];
    if (!meta) continue;
    if (!best || meta.rank > BACKEND_ROLE_META[best].rank) best = r;
  }
  return best ? BACKEND_ROLE_META[best].label : '';
}

export const EVENT_VISIBILITIES = ['PUBLIC', 'VIP', 'SVIP'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

/** 数值越大权限越高；两表同构，便于做「可见性 ≤ 用户等级」比较 */
export const LEVEL_RANK: Readonly<Record<MemberLevel, number>> = { NONE: 0, VIP: 1, SVIP: 2 };
export const VISIBILITY_RANK: Readonly<Record<EventVisibility, number>> = { PUBLIC: 0, VIP: 1, SVIP: 2 };

/** 场次可见性判定：列表 SQL 与详情判权共用同一语义 */
export function satisfiesVisibility(userLevel: MemberLevel, visibility: EventVisibility): boolean {
  return LEVEL_RANK[userLevel] >= VISIBILITY_RANK[visibility];
}

/** 等级门槛判定（等级继承：SVIP ⊃ VIP ⊃ NONE） */
export function satisfiesLevel(userLevel: MemberLevel, required: MemberLevel): boolean {
  return LEVEL_RANK[userLevel] >= LEVEL_RANK[required];
}

export function isBackendRole(value: string): value is BackendRole {
  return (BACKEND_ROLES as readonly string[]).includes(value);
}
