import { createRouter, createWebHistory } from 'vue-router';
import type { Capability } from '@photo/shared';
import { useSessionStore } from '../stores/session';
import { tokens } from '../api';
import AdminLayout from '../layouts/AdminLayout.vue';

/**
 * 菜单与路由同一份 meta.capabilities，避免「菜单能看、接口 403」。
 *
 * 权限边界（详见 @photo/shared/capabilities）：
 *   MODE        —— 无后台菜单
 *   OPERATOR    —— 场次、报名、投票
 *   FINANCE     —— 财务与退款
 *   ADMIN       —— 场次、报名、财务、投票、会员、邀请码（日常最高权限）
 *   运维账号     —— 独占「权限与治理」，不在界面体现
 */
export const adminMenus = [
  { to: '/', label: '概览', group: '总览', capabilities: [] as Capability[] },
  { to: '/cockpit', label: '驾驶舱', group: '总览', capabilities: [] as Capability[] },
  { to: '/events', label: '场次管理', group: '运营', capabilities: ['admin:event:write'] as Capability[] },
  { to: '/models', label: '模特管理', group: '运营', capabilities: ['admin:model:write'] as Capability[] },
  { to: '/scenes', label: '场景管理', group: '运营', capabilities: ['admin:scene:write'] as Capability[] },
  { to: '/registrations', label: '报名管理', group: '运营', capabilities: ['admin:registration:write'] as Capability[] },
  { to: '/votes', label: '服装投票', group: '运营', capabilities: ['admin:vote:write'] as Capability[] },
  { to: '/members', label: '用户管理', group: '运营', capabilities: ['admin:membership:grant'] as Capability[] },
  { to: '/invite-codes', label: '邀请码', group: '运营', capabilities: ['admin:invite:read'] as Capability[] },
  { to: '/coupons', label: '优惠券', group: '运营', capabilities: ['admin:membership:grant'] as Capability[] },
  { to: '/finance', label: '财务与退款', group: '财务', capabilities: ['admin:refund:review'] as Capability[] },
  { to: '/governance', label: '权限与治理', group: '系统', capabilities: ['admin:audit:read'] as Capability[] },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true, title: '登录' } },
    { path: '/403', component: () => import('../views/ForbiddenView.vue'), meta: { public: true, title: '无权限' } },
    {
      path: '/', component: AdminLayout,
      children: [
        { path: '', component: () => import('../views/DashboardView.vue'), meta: { title: '概览' } },
        { path: 'cockpit', component: () => import('../views/CockpitView.vue'), meta: { title: '驾驶舱' } },
        { path: 'events', component: () => import('../views/EventsView.vue'), meta: { title: '场次管理', capabilities: ['admin:event:write'] } },
        { path: 'models', component: () => import('../views/ModelsView.vue'), meta: { title: '模特管理', capabilities: ['admin:model:write'] } },
        { path: 'scenes', component: () => import('../views/ScenesView.vue'), meta: { title: '场景管理', capabilities: ['admin:scene:write'] } },
        { path: 'registrations', component: () => import('../views/RegistrationsView.vue'), meta: { title: '报名管理', capabilities: ['admin:registration:write'] } },
        { path: 'votes', component: () => import('../views/VotesView.vue'), meta: { title: '服装投票', capabilities: ['admin:vote:write'] } },
        { path: 'members', component: () => import('../views/MembersView.vue'), meta: { title: '用户管理', capabilities: ['admin:membership:grant'] } },
        { path: 'invite-codes', component: () => import('../views/InviteCodesView.vue'), meta: { title: '邀请码', capabilities: ['admin:invite:read'] } },
        { path: 'coupons', component: () => import('../views/CouponsView.vue'), meta: { title: '优惠券', capabilities: ['admin:membership:grant'] } },
        { path: 'finance', component: () => import('../views/FinanceView.vue'), meta: { title: '财务与退款', capabilities: ['admin:refund:review'] } },
        { path: 'governance', component: () => import('../views/GovernanceView.vue'), meta: { title: '权限与治理', capabilities: ['admin:audit:read'] } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  /** 切页回到顶部：后台列表动辄几十行，翻页后停留在上一页的滚动位置会让人以为没加载 */
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 };
  },
});

router.beforeEach(async (to) => {
  document.title = `${String(to.meta.title ?? '管理后台')} · 猫爪社摄影会`;
  const session = useSessionStore();
  if (!session.loaded && tokens.read()) await session.hydrate();
  if (to.meta.public) return true;
  await session.hydrate();
  if (!session.user) return { path: '/login', query: { redirect: to.fullPath } };
  if (!session.isBackend) return '/403';
  const required = to.meta.capabilities as Capability[] | undefined;
  if (required && !required.every((c) => session.can(c))) return '/403';
  return true;
});

export default router;
