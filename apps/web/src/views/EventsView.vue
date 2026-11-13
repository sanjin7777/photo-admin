<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EventDto } from '@photo/shared';
import { api } from '../api';
import { useBreakpoint } from '../composables/useBreakpoint';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import EventCard from '../components/EventCard.vue';

type EventTab = 'cat' | 'jade';

const events = ref<EventDto[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const page = ref(1);
const pageSize = 12;
const total = ref(0);
const hasMore = computed(() => events.value.length < total.value);
const activeTab = ref<EventTab>('cat');
const { isDesktop } = useBreakpoint();
const session = useSessionStore();
const ui = useUiStore();
const columns = computed(() => (isDesktop.value ? 'lg:grid-cols-3' : 'sm:grid-cols-2'));

const catEvents = computed(() => events.value.filter((e) => e.visibility === 'PUBLIC'));
const jadeEvents = computed(() => events.value.filter((e) => e.visibility !== 'PUBLIC'));
/* 玉竹为会员场次：普通会员不展示入口 */
const showJade = computed(() => session.level !== 'NONE');
const tabs = computed(() => {
  const list: { key: EventTab; label: string; count: number }[] = [
    { key: 'cat', label: '猫爪', count: catEvents.value.length },
  ];
  if (showJade.value) list.push({ key: 'jade', label: '玉竹', count: jadeEvents.value.length });
  return list;
});
const currentEvents = computed(() =>
  activeTab.value === 'jade' && showJade.value ? jadeEvents.value : catEvents.value,
);
/** 报名时间已过（或场次已关闭/进行中/结束/取消）：只读展示，不提供点击操作 */
function isRegistrationClosed(e: EventDto): boolean {
  const byTime = new Date(e.registrationCloseAt).getTime() <= Date.now();
  const byStatus = e.status === 'REGISTRATION_CLOSED' || e.status === 'ONGOING'
    || e.status === 'FINISHED' || e.status === 'CANCELLED';
  return byTime || byStatus;
}
const openEvents = computed(() => currentEvents.value.filter((e) => !isRegistrationClosed(e)));
const closedEvents = computed(() => currentEvents.value.filter(isRegistrationClosed));
const emptyTitle = computed(() => (activeTab.value === 'jade' ? '暂无会员场次' : '暂无公开场次'));
const emptyHint = computed(() =>
  activeTab.value === 'jade' ? '新发布的会员专场会出现在这里' : '新场次发布后会出现在这里',
);

async function loadMore(): Promise<void> {
  loadingMore.value = true;
  try {
    const res = await api.events.list({ page: page.value, pageSize });
    events.value = page.value === 1 ? res.list : [...events.value, ...res.list];
    total.value = res.total;
    page.value += 1;
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败', 'fail');
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

onMounted(loadMore);
</script>

<template>
  <section>
    <!-- 头图区：浅色渐变 + 品牌标识 -->
    <div class="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-r from-white via-brand-50 to-white p-5 shadow-card md:p-7">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-xs tracking-[0.35em] text-brand">猫爪社摄影会</p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">近期场次</h1>
          <p class="mt-1.5 text-sm text-slate-500">
            选好时段在线报名，会员价按报名时的等级结算。
          </p>
        </div>
        <span class="chip bg-white px-3 py-1 text-slate-600 ring-1 ring-slate-200">
          已显示 {{ currentEvents.length }} 场
        </span>
      </div>
    </div>

    <!-- 双 Tab：猫爪（公开场次）/ 玉竹（会员场次） -->
    <div class="mb-4 flex items-center gap-2">
      <div class="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <button v-for="tab in tabs" :key="tab.key" type="button"
          class="rounded-lg px-4 py-1.5 text-sm font-medium transition"
          :class="activeTab === tab.key
            ? 'bg-brand text-white shadow-sm'
            : 'text-slate-500 hover:text-slate-800'"
          @click="activeTab = tab.key">
          {{ tab.label }}
          <span class="ml-1 text-xs"
            :class="activeTab === tab.key ? 'text-white/80' : 'text-slate-500'">{{ tab.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading" class="grid grid-cols-1 gap-4" :class="columns">
      <div v-for="i in 3" :key="i" class="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
    </div>

    <template v-else-if="currentEvents.length">
      <!-- 报名中：可进入详情报名 -->
      <div v-if="openEvents.length" class="mb-2 flex items-center gap-2">
        <h2 class="text-sm font-semibold text-slate-900">报名中</h2>
        <span class="text-xs text-slate-500">{{ openEvents.length }} 场</span>
      </div>
      <div v-if="openEvents.length" class="grid grid-cols-1 gap-4" :class="columns">
        <EventCard v-for="event in openEvents" :key="event.id" :event="event" />
      </div>
      <p v-else class="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-xs text-slate-500">
        暂无报名中的场次
      </p>

      <!-- 报名已截止：与报名中分隔，只读基础信息 -->
      <div v-if="closedEvents.length" class="mt-8 border-t border-slate-200 pt-5">
        <div class="mb-3 flex items-baseline gap-2">
          <h2 class="text-sm font-semibold text-slate-600">报名已截止</h2>
          <span class="text-xs text-slate-500">{{ closedEvents.length }} 场 · 仅供查看</span>
        </div>
        <div class="grid grid-cols-1 gap-4" :class="columns">
          <EventCard v-for="event in closedEvents" :key="event.id" :event="event" closed />
        </div>
      </div>
    </template>

    <div v-else class="mt-2 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white py-14 text-center">
      <p class="text-sm font-medium text-slate-700">{{ emptyTitle }}</p>
      <p class="text-xs text-slate-500">{{ emptyHint }}</p>
    </div>

    <!-- 分页：一次只拉一页，避免首屏等全量；到底后按钮自然消失 -->
    <div v-if="!loading && hasMore" class="mt-6 flex justify-center">
      <button class="btn-ghost px-6 py-2 text-sm disabled:opacity-50" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : `加载更多（已显示 ${events.length} / ${total}）` }}
      </button>
    </div>
  </section>
</template>
