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

const menus = computed(() => {
  const base: Array<{ to: string; label: string }> = [{ to: '/', label: '场次' }];
  // 未登录只留场次入口；「我的报名 / 个人中心」必须登录后才展示
  if (!session.user) return base;
  base.push({ to: '/my', label: '我的报名' });
  // 仅 SVIP 具备 vote:cast；非 SVIP 不渲染入口（后端与路由守卫同样会拦）
  if (session.can('vote:cast')) base.push({ to: '/vote', label: '服装投票' });
  base.push({ to: '/profile', label: '个人中心' });
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

    <!-- 移动端底部导航 -->
    <nav v-if="isMobile" class="safe-bottom fixed bottom-0 left-0 right-0 z-40 flex border-t border-slate-200 bg-white/95 backdrop-blur md:hidden">
      <RouterLink v-for="m in menus" :key="m.to" :to="m.to"
        class="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs"
        :class="active(m.to) ? 'font-medium text-brand-soft' : 'text-slate-500'">
        <span class="h-1 w-1 rounded-full" :class="active(m.to) ? 'bg-brand' : 'bg-transparent'" />
        {{ m.label }}
      </RouterLink>
    </nav>
  </div>
</template>
