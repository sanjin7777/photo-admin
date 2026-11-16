import { createRouter, createWebHistory } from 'vue-router';
import type { Capability } from '@photo/shared';
import { useSessionStore } from '../stores/session';
import { tokens } from '../api';
import WebLayout from '../layouts/WebLayout.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true, title: '登录' } },
    { path: '/terms', component: () => import('../views/TermsView.vue'), meta: { public: true, title: '用户协议' } },
    { path: '/privacy', component: () => import('../views/PrivacyView.vue'), meta: { public: true, title: '隐私政策' } },
    { path: '/403', component: () => import('../views/ForbiddenView.vue'), meta: { public: true, title: '无权限' } },
    /** 改密独立于主布局：导入账号登录后被强制停留在此，主动改密也从个人中心进入 */
    { path: '/password', component: () => import('../views/ChangePasswordView.vue'), meta: { title: '修改密码' } },
    {
      path: '/', component: WebLayout,
      children: [
        { path: '', component: () => import('../views/EventsView.vue'), meta: { public: true, title: '场次' } },
        { path: 'events/:id', component: () => import('../views/EventDetailView.vue'), meta: { public: true, title: '场次详情' } },
        { path: 'my', component: () => import('../views/MyRegistrationsView.vue'), meta: { title: '我的登记' } },
        /** 电子票根：登记成功后凭此到场核销 */
        { path: 'tickets/:id', component: () => import('../views/TicketView.vue'), meta: { title: '电子票根' } },
        /** 投票入口仅 SVIP：capabilities 里 vote:cast 只在 SVIP 等级下发，守卫会拦下其他人 */
        { path: 'vote', component: () => import('../views/VoteListView.vue'), meta: { title: '服装投票', capabilities: ['vote:cast'] } },
        { path: 'vote/:id', component: () => import('../views/VoteView.vue'), meta: { title: '服装投票', capabilities: ['vote:cast'] } },
        { path: 'profile', component: () => import('../views/ProfileView.vue'), meta: { title: '个人中心' } },
        /** 积分明细：从个人中心拆出，避免首页被流水撑长 */
        { path: 'points', component: () => import('../views/PointsView.vue'), meta: { title: '积分明细' } },
        /** 设置：改密 / 退出 / 注销集中一页，危险操作与常规浏览隔离 */
        { path: 'settings', component: () => import('../views/SettingsView.vue'), meta: { title: '设置' } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  /**
   * 返回列表时恢复原滚动位置（savedPosition），前进则回到顶部。
   * 手机端从第 6 个场次点进详情、再返回时若跳回顶部，等于每次都要重新找位置。
   */
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 };
  },
});

router.beforeEach(async (to) => {
  document.title = `${String(to.meta.title ?? '摄影会')} · 猫爪社摄影会`;
  const session = useSessionStore();
  // 公开页也尝试装载能力，用于显示 VIP/SVIP 入口（失败按游客处理）
  if (!session.loaded && tokens.read()) await session.hydrate();
  if (to.meta.public) {
    // 导入账号未改密前，连公开页也不放行
    if (session.mustChangePassword && to.path !== '/password') return '/password';
    return true;
  }

  await session.hydrate();
  if (!session.user) return { path: '/login', query: { redirect: to.fullPath } };
  if (session.mustChangePassword && to.path !== '/password') return '/password';
  const required = to.meta.capabilities as Capability[] | undefined;
  if (required && !required.every((c) => session.can(c))) return '/403';
  return true;
});

export default router;
