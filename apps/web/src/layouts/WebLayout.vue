<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useBreakpoint } from '../composables/useBreakpoint';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';

const { isMobile, isDesktop } = useBreakpoint();
const ui = useUiStore();
const session = useSessionStore();
const route = useRoute();

/**
 * 底部 tab 图标（24×24 线性图标，stroke 随 currentColor 变化）。
 * 用内联 SVG 而不是图标库：只有 4 个图标，引一整个图标包不值得。
 */
const ICONS = {
  calendar: [
    'M8 2v4M16 2v4M3 10h18',
    'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  ],
  ticket: [
    'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 6v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-6V7Z',
    'M13 5v3M13 12v3M13 18v1',
  ],
  shirt: [
    'M15.5 3 20 5.2a1 1 0 0 1 .5 1.2l-1 3a1 1 0 0 1-.9.6H17v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9H6.4a1 1 0 0 1-.9-.6l-1-3A1 1 0 0 1 5 5.2L9.5 3a2.5 2.5 0 0 0 6 0Z',
  ],
  user: [
    'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1',
  ],
} as const;

const menus = computed(() => {
  const base: Array<{ to: string; label: string; icon: readonly string[] }> = [
    { to: '/', label: '场次', icon: ICONS.calendar },
  ];
  // 未登录只留场次入口；「我的登记 / 个人中心」必须登录后才展示
  if (!session.user) return base;
  base.push({ to: '/my', label: '我的登记', icon: ICONS.ticket });
  // 仅 SVIP 具备 vote:cast；非 SVIP 不渲染入口（后端与路由守卫同样会拦）
  if (session.can('vote:cast')) base.push({ to: '/vote', label: '服装投票', icon: ICONS.shirt });
  base.push({ to: '/profile', label: '个人中心', icon: ICONS.user });
  return base;
});
const active = (p: string) => route.path === p;

/** 只有会员才显示等级徽章；普通用户不显示「普通用户」这种无信息量标签 */
const levelLabel = computed(() => (session.level === 'SVIP' ? 'SVIP' : session.level === 'VIP' ? 'VIP' : ''));
const levelClass = computed(() => (session.level === 'SVIP' ? 'badge-svip' : 'badge-vip'));
const avatarText = computed(() => (session.user?.nickname ?? '游').slice(0, 1));
</script>

<template>
  <div class="min-h-dvh bg-slate-50">
    <!-- PC 顶部导航 -->
    <header class="sticky top-0 z-30 hidden border-b border-slate-200 bg-white/90 backdrop-blur md:block">
      <div class="mx-auto flex max-w-6xl items-center gap-8 px-6 py-3">
        <RouterLink to="/" class="flex shrink-0 items-center gap-2">
          <img src="/logo.jpg" alt="猫爪社摄影会" class="h-9 w-9 rounded-full object-cover ring-1 ring-brand/15" />
          <span class="text-lg font-semibold tracking-tight text-slate-900">猫爪社<span class="text-brand">摄影会</span></span>
        </RouterLink>
        <nav class="flex gap-1 text-sm">
          <RouterLink v-for="m in menus" :key="m.to" :to="m.to"
            class="rounded-lg px-3 py-1.5 transition"
            :class="active(m.to) ? 'bg-brand-50 font-medium text-brand-soft' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'">
            {{ m.label }}
          </RouterLink>
        </nav>
        <RouterLink :to="session.user ? '/profile' : '/login'" class="ml-auto flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900">
          <span class="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-700">{{ avatarText }}</span>
          <span class="max-w-[9rem] truncate">{{ session.user?.nickname ?? '未登录' }}</span>
          <span v-if="levelLabel" class="chip" :class="levelClass">{{ levelLabel }}</span>
        </RouterLink>
      </div>
    </header>

    <!-- 移动端顶栏 -->
    <header class="safe-top flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-3 md:hidden">
      <button class="text-xl leading-none text-slate-700" aria-label="打开菜单" @click="ui.drawerOpen = true">☰</button>
      <RouterLink to="/" class="flex items-center gap-1.5">
        <img src="/logo.jpg" alt="猫爪社摄影会" class="h-7 w-7 rounded-full object-cover ring-1 ring-brand/15" />
        <span class="font-semibold text-slate-900">猫爪社摄影会</span>
      </RouterLink>
      <span v-if="levelLabel" class="chip" :class="levelClass">{{ levelLabel }}</span>
      <RouterLink :to="session.user ? '/profile' : '/login'" class="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-700">
        {{ avatarText }}
      </RouterLink>
    </header>

    <!-- 移动端抽屉 -->
    <div v-if="isMobile && ui.drawerOpen" class="fixed inset-0 z-50 flex">
      <div class="fade-up h-full w-72 bg-white p-4 shadow-float">
        <div class="mb-5 flex items-center gap-3 border-b border-slate-100 pb-4">
          <span class="flex h-11 w-11 items-center justify-center rounded-full bg-slate-200 text-sm font-medium text-slate-700">{{ avatarText }}</span>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-slate-900">{{ session.user?.nickname ?? '未登录' }}</p>
            <p class="muted truncate text-xs">{{ session.user?.wechatId ? `微信号 ${session.user.wechatId}` : '未登录' }}</p>
          </div>
        </div>
        <RouterLink v-for="m in menus" :key="m.to" :to="m.to"
          class="flex items-center rounded-lg px-3 py-3 text-sm"
          :class="active(m.to) ? 'bg-brand-50 font-medium text-brand-soft' : 'text-slate-700'"
          @click="ui.drawerOpen = false">{{ m.label }}</RouterLink>
      </div>
      <div class="flex-1 bg-slate-900/30" @click="ui.drawerOpen = false" />
    </div>

    <main :class="isDesktop ? 'mx-auto max-w-6xl px-6' : 'px-3'" class="pb-24 pt-4 md:pb-10">
      <RouterView />
    </main>

    <!-- 页脚：备案号与协议入口为对外公示要求，须保持可见 -->
    <footer :class="isDesktop ? 'mx-auto max-w-6xl px-6' : 'px-3'" class="pb-28 pt-6 text-center text-xs leading-relaxed text-slate-500 md:pb-8">
      <p>本站为猫爪社摄影会会员内部活动管理系统，仅限受邀会员使用。</p>
      <p class="mt-1">
        <RouterLink to="/terms" class="hover:text-slate-700">用户协议</RouterLink>
        <span class="mx-1">·</span>
        <RouterLink to="/privacy" class="hover:text-slate-700">隐私政策</RouterLink>
        <span class="mx-1">·</span>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener" class="hover:text-slate-700">湘ICP备2026012181号-2</a>
      </p>
    </footer>

    <!-- 移动端底部导航：图标 + 文字，高度 4rem（原 3.25rem 偏矮，图标放不下） -->
    <nav v-if="isMobile" class="safe-bottom fixed bottom-0 left-0 right-0 z-40 flex border-t border-slate-200 bg-white/95 backdrop-blur md:hidden">
      <RouterLink v-for="m in menus" :key="m.to" :to="m.to"
        class="flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none transition"
        :class="active(m.to) ? 'font-medium text-brand-soft' : 'text-slate-500'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          :stroke-width="active(m.to) ? 2.2 : 1.8" stroke-linecap="round" stroke-linejoin="round"
          class="h-[22px] w-[22px]" aria-hidden="true">
          <path v-for="(d, i) in m.icon" :key="i" :d="d" />
        </svg>
        <span>{{ m.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
