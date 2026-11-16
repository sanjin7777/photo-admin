<script setup lang="ts">
/**
 * 概览：只放运营每天真正要看的数字与待办。
 * 说明性/开发性文字统一收进「使用帮助」，不占主界面。
 */
import { computed, onMounted, ref } from 'vue';
import type { Capability, EventDto } from '@photo/shared';
import { highestRoleLabel } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { emptyPage, loadAllPages } from '../utils/loadAll';
import { EVENT_STATUS, metaOf, shortTime } from '../utils/labels';

const ui = useUiStore();
const session = useSessionStore();

const loading = ref(true);
const events = ref<EventDto[]>([]);
const counts = ref({ events: 0, registrations: 0, unpaid: 0, refunds: 0, openEvents: 0 });

const roleText = computed(() => highestRoleLabel(session.roles) || '后台账号');

/** 概览卡片：cap 用 Capability 类型约束，权限名写错会在编译期报错（原先 as never 把检查关掉了） */
const cards = computed(() => ([
  { label: '场次', value: counts.value.events, hint: `${counts.value.openEvents} 个报名中`, to: '/events', cap: 'admin:event:write', warn: false },
  { label: '报名', value: counts.value.registrations, hint: '全部记录', to: '/registrations', cap: 'admin:registration:write', warn: false },
  { label: '待收款', value: counts.value.unpaid, hint: '线下支付待确认', to: '/registrations?pay=UNPAID', cap: 'admin:registration:write', warn: true },
  { label: '待审核退款', value: counts.value.refunds, hint: '已退款的不计入', to: '/finance?tab=refunds', cap: 'admin:refund:review', warn: true },
] as Array<{ label: string; value: number; hint: string; to: string; cap: Capability; warn: boolean }>)
  .filter((c) => session.can(c.cap)));

const todos = computed(() => [
  counts.value.unpaid > 0 && { text: `${counts.value.unpaid} 笔报名待确认收款`, to: '/registrations?pay=UNPAID', cap: 'admin:registration:write' },
  counts.value.refunds > 0 && { text: `${counts.value.refunds} 张退款单待审核`, to: '/finance?tab=refunds', cap: 'admin:refund:review' },
].filter(Boolean) as Array<{ text: string; to: string; cap: string }>);

/** 近期场次：只取还没结束的时段，按开始时间排，补足首页下半屏 */
const upcoming = computed(() =>
  events.value
    .filter((e) => e.status !== 'DRAFT' && e.status !== 'CANCELLED' && e.status !== 'FINISHED')
    .flatMap((e) => e.sessions.map((s) => ({ event: e, session: s })))
    .filter((x) => new Date(x.session.endAt).getTime() >= Date.now())
    .sort((a, b) => +new Date(a.session.startAt) - +new Date(b.session.startAt))
    .slice(0, 6),
);

onMounted(async () => {
  try {
    // 各统计接口按能力调用：运营没有退款审核、财务没有活动/报名权限，避免进首页就 3001
    // 服务端单页上限 100：按页拉全量，否则待收款/待审核会漏统计
    const empty = emptyPage<{ paymentStatus?: string; status?: string }>();
    const [eventPage, regPage, refundPage] = await Promise.all([
      session.can('admin:event:write')
        ? loadAllPages((page, pageSize) => api.admin.events.list({ page, pageSize })).catch(() => emptyPage<EventDto>())
        : emptyPage<EventDto>(),
      session.can('admin:registration:write')
        ? loadAllPages((page, pageSize) => api.admin.registrations.list({ page, pageSize })).catch(() => empty)
        : empty,
      session.can('admin:refund:review')
        ? loadAllPages((page, pageSize) => api.admin.refunds.list({ page, pageSize })).catch(() => emptyPage<{ status?: string }>())
        : emptyPage<{ status?: string }>(),
    ]);
    events.value = eventPage.list;
    counts.value = {
      events: eventPage.total,
      registrations: regPage.total,
      unpaid: regPage.list.filter((r) => r.paymentStatus === 'UNPAID').length,
      // 只统计「待审核」，已退款/已驳回的不算待办，否则永远清不掉
      refunds: refundPage.list.filter((r) => r.status === 'REQUESTED').length,
      openEvents: eventPage.list.filter((e) => e.status === 'REGISTRATION_OPEN').length,
    };
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">概览</h1>
        <p class="mt-1 text-sm text-slate-500">欢迎回来，{{ session.user?.nickname }}</p>
      </div>
      <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{{ roleText }}</span>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <RouterLink v-for="c in cards" :key="c.label" :to="c.to"
        class="rounded-xl border p-4 transition hover:-translate-y-0.5 hover:shadow-sm"
        :class="c.warn && c.value > 0 ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-white'">
        <p class="text-xs text-slate-500">{{ c.label }}</p>
        <p class="mt-1.5 text-2xl font-semibold" :class="c.warn && c.value > 0 ? 'text-amber-700' : 'text-slate-900'">{{ loading ? '—' : c.value }}</p>
        <p class="mt-0.5 text-xs text-slate-500">{{ c.hint }}</p>
      </RouterLink>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <!-- 待办 -->
      <div class="rounded-xl border border-slate-200 bg-white p-4">
        <h2 class="mb-2 text-sm font-semibold text-slate-900">待办</h2>
        <template v-if="todos.length">
          <RouterLink v-for="t in todos" :key="t.text" :to="t.to"
            class="flex items-center justify-between border-t border-slate-100 py-2.5 text-sm text-slate-700 hover:text-blue-600">
            <span>{{ t.text }}</span>
            <span class="text-xs text-slate-500">去处理 →</span>
          </RouterLink>
        </template>
        <p v-else class="py-6 text-center text-xs text-slate-500">暂时没有需要处理的待办</p>
      </div>

      <!-- 快捷入口 -->
      <div class="rounded-xl border border-slate-200 bg-white p-4">
        <h2 class="mb-2 text-sm font-semibold text-slate-900">快捷入口</h2>
        <div class="flex flex-wrap gap-2">
          <RouterLink v-if="session.can('admin:event:write')" to="/events?new=1"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:border-blue-400 hover:text-blue-600">新建场次</RouterLink>
          <RouterLink v-if="session.can('admin:vote:write')" to="/votes"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:border-blue-400 hover:text-blue-600">配置投票</RouterLink>
          <RouterLink v-if="session.can('admin:membership:grant')" to="/members"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:border-blue-400 hover:text-blue-600">会员授予 / 导入</RouterLink>
          <RouterLink v-if="session.can('admin:refund:review')" to="/finance?tab=refunds"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:border-blue-400 hover:text-blue-600">审核退款</RouterLink>
        </div>
        <p class="mt-3 text-xs leading-relaxed text-slate-500">
          积分为站内权益记录，不可购买、不可兑现；会员登记按等级结算积分，普通用户登记后在「报名管理」确认到场。
        </p>
      </div>
    </div>

    <!-- 近期场次：把首页下半屏用起来，运营不用先跳场次页才能看排期 -->
    <div v-if="session.can('admin:event:write')" class="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 class="text-sm font-semibold text-slate-900">近期场次</h2>
        <RouterLink to="/events" class="text-xs text-blue-600 hover:underline">全部场次 →</RouterLink>
      </div>
      <p v-if="loading" class="px-4 py-8 text-center text-xs text-slate-500">加载中…</p>
      <p v-else-if="!upcoming.length" class="px-4 py-8 text-center text-xs text-slate-500">暂无待进行的场次</p>
      <template v-else>
        <RouterLink v-for="u in upcoming" :key="u.session.id" to="/events"
          class="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-0 hover:bg-slate-50/60">
          <div class="min-w-0">
            <p class="truncate text-sm text-slate-800">{{ u.event.title }}</p>
            <p class="mt-0.5 text-xs text-slate-500">
              {{ u.session.label }} · {{ shortTime(u.session.startAt) }}–{{ shortTime(u.session.endAt) }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs" :class="metaOf(EVENT_STATUS, u.event.status).cls">
              {{ metaOf(EVENT_STATUS, u.event.status).label }}
            </span>
            <span class="whitespace-nowrap text-xs" :class="u.session.capacityUsed >= u.session.capacity ? 'text-rose-600' : 'text-slate-500'">
              {{ u.session.capacityUsed >= u.session.capacity ? '已满' : `余 ${u.session.capacity - u.session.capacityUsed} 位` }}
            </span>
          </div>
        </RouterLink>
      </template>
    </div>
  </section>
</template>
