<script setup lang="ts">
/**
 * 服装投票列表（仅 SVIP 可见）。
 * 路由 meta.capabilities = ['vote:cast']，该能力只在 SVIP 等级下发，非 SVIP 会被守卫送去 /403。
 */
import { onMounted, ref } from 'vue';
import type { VoteCampaignSummaryDto } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
const list = ref<VoteCampaignSummaryDto[]>([]);
const loading = ref(true);

const statusMeta: Record<string, { label: string; cls: string }> = {
  OPEN: { label: '进行中', cls: 'bg-emerald-50 text-emerald-700' },
  CLOSED: { label: '已截止', cls: 'bg-amber-50 text-amber-700' },
  PUBLISHED: { label: '结果已公布', cls: 'bg-blue-50 text-blue-700' },
  DRAFT: { label: '未开始', cls: 'bg-slate-100 text-slate-600' },
};

onMounted(async () => {
  try {
    list.value = await api.votes.list();
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败', 'fail');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="mx-auto max-w-3xl">
    <div class="mb-5 rounded-2xl border border-slate-200 bg-gradient-to-r from-white via-brand-50 to-white p-5 shadow-card">
      <p class="text-xs tracking-[0.35em] text-brand">SVIP 专属</p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight text-slate-900">服装投票</h1>
      <p class="mt-1.5 text-sm text-slate-500">
        为本会下一场的服装方案投票。同一人可改票，结果只公布聚合数据。
      </p>
    </div>

    <div v-if="loading" class="space-y-3">
      <div v-for="i in 2" :key="i" class="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white" />
    </div>

    <div v-else class="space-y-3">
      <RouterLink v-for="c in list" :key="c.id" :to="`/vote/${c.id}`"
        class="flex gap-3 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-card transition hover:-translate-y-0.5 hover:shadow-float">
        <div class="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100">
          <img v-if="c.coverImageUrl" :src="c.coverImageUrl" :alt="c.title" class="h-full w-full object-cover" />
          <div v-else class="flex h-full w-full items-center justify-center text-xs text-slate-500">无图</div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <p class="clamp-1 text-[15px] font-semibold text-slate-900">{{ c.title }}</p>
            <span class="chip shrink-0" :class="statusMeta[c.status]?.cls">{{ statusMeta[c.status]?.label }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            {{ c.optionCount }} 个方案<span v-if="c.eventTitle"> · {{ c.eventTitle }}</span>
          </p>
          <p class="mt-1 text-xs text-slate-500">
            {{ new Date(c.openAt).toLocaleDateString('zh-CN') }} 至 {{ new Date(c.closeAt).toLocaleDateString('zh-CN') }}
          </p>
          <p class="mt-1.5 text-xs" :class="c.myVoted ? 'text-emerald-600' : 'text-brand'">
            {{ c.myVoted ? '你已投票，可进入修改' : '还没投票，点进来选一套 →' }}
          </p>
        </div>
      </RouterLink>

      <div v-if="!list.length" class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white py-14 text-center">
        <p class="text-sm font-medium text-slate-700">暂时没有进行中的投票</p>
        <p class="text-xs text-slate-500">有新活动时会出现在这里</p>
        <RouterLink to="/" class="btn-ghost mt-2 px-4 py-2 text-xs">去看场次</RouterLink>
      </div>
    </div>
  </section>
</template>
