<script setup lang="ts">
import { computed } from 'vue';
import type { EventDto } from '@photo/shared';
import { useSessionStore } from '../stores/session';
import { priceFor, publicPriceOf, timeRange, yuan } from '../composables/usePricing';

const props = defineProps<{ event: EventDto; closed?: boolean }>();
const session = useSessionStore();

const cover = computed(() => props.event.coverUrl ?? props.event.posterUrls?.[0] ?? '');
const sessionCount = computed(() => props.event.sessions?.length ?? 0);
const firstSession = computed(() => props.event.sessions?.[0] ?? null);
const timeLabel = computed(() => {
  const s = firstSession.value;
  return s ? timeRange(s.startAt, s.endAt) : timeRange(props.event.startAt, props.event.endAt);
});
const full = computed(() => props.event.capacityUsed >= props.event.capacity);
const myPrice = computed(() => priceFor(props.event, session.level));
const fullPrice = computed(() => publicPriceOf(props.event));
const badgeText = computed(() => (props.event.visibility === 'PUBLIC' ? '公开' : props.event.visibility));
const badgeClass = computed(() =>
  props.event.visibility === 'SVIP' ? 'badge-svip'
    : props.event.visibility === 'VIP' ? 'badge-vip'
      : 'badge-public');
const unit = computed(() => props.event.prices?.[0]?.unitLabel ?? '场');
</script>

<template>
  <!-- 报名已截止：只展示基础信息，整卡不可点击、不进详情 -->
  <component :is="closed ? 'div' : 'RouterLink'" :to="closed ? undefined : `/events/${event.id}`"
    class="block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card transition"
    :class="closed
      ? 'opacity-90'
      : 'group hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-float'">
    <!-- 封面：竖版海报用 contain 完整显示，两侧用自身模糊填充，避免裁掉海报文字 -->
    <div class="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
      <template v-if="cover">
        <img :src="cover" alt="" aria-hidden="true"
          class="absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-lg" />
        <img :src="cover" :alt="event.title"
          class="relative h-full w-full object-contain transition duration-500 group-hover:scale-[1.02]" loading="lazy"
          @error="($event.target as HTMLImageElement).style.display = 'none'" />
      </template>
      <div v-else class="flex h-full w-full flex-col items-center justify-center gap-1 px-4 text-center">
        <img src="/logo.jpg" alt="" class="h-9 w-9 rounded-full object-cover opacity-70" />
        <span class="text-xs tracking-[0.3em] text-slate-500">猫爪社摄影会</span>
        <span class="clamp-2 text-base font-semibold text-slate-800">{{ event.title }}</span>
      </div>
      <span class="chip absolute left-3 top-3 bg-white/90 shadow-sm backdrop-blur" :class="badgeClass">{{ badgeText }}</span>
      <span v-if="sessionCount > 1" class="chip absolute right-3 top-3 bg-slate-900/60 text-white backdrop-blur">
        {{ sessionCount }} 个时段
      </span>
      <!-- 候补已下线（2026-11-13）：满员仅提示已满 -->
      <span v-if="closed" class="chip absolute bottom-3 left-3 bg-slate-700/85 text-white">报名已截止</span>
      <span v-else-if="full" class="chip absolute bottom-3 left-3 bg-amber-500/90 text-white">已满</span>
    </div>

    <div class="p-4">
      <h3 class="clamp-2 text-[15px] font-semibold leading-snug text-slate-900">{{ event.title }}</h3>
      <p v-if="event.subtitle" class="clamp-1 mt-1 text-xs text-slate-500">{{ event.subtitle }}</p>

      <div class="mt-3 space-y-1 text-xs text-slate-500">
        <p class="flex items-center gap-1.5">
          <span class="text-slate-500">时间</span>
          <span class="text-slate-700">{{ timeLabel }}</span>
        </p>
        <p class="flex items-center gap-1.5">
          <span class="text-slate-500">场地</span>
          <span class="clamp-1 text-slate-700">{{ event.venue }}<span v-if="event.scene"> · {{ event.scene }}</span></span>
        </p>
        <p v-if="event.model" class="flex items-center gap-1.5">
          <span class="text-slate-500">模特</span>
          <span class="text-slate-700">{{ event.model.stageName }}<span v-if="event.ratioLabel"> · {{ event.ratioLabel }}</span></span>
        </p>
      </div>

      <div class="mt-3 flex items-end justify-between border-t border-slate-100 pt-3">
        <div>
          <p class="text-base font-semibold text-brand-soft">
            {{ yuan(myPrice) }}<span class="ml-1 text-xs font-normal text-slate-500">/{{ unit }}</span>
          </p>
          <p v-if="session.isMember && myPrice !== fullPrice" class="text-xs text-slate-500 line-through">{{ yuan(fullPrice) }}</p>
          <p v-else-if="!session.isMember" class="text-xs text-slate-500">线下支付 · 会员可用积分抵扣</p>
        </div>
        <span v-if="closed" class="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">
          报名已截止
        </span>
        <span v-else class="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition group-hover:bg-brand">
          查看详情
        </span>
      </div>
    </div>
  </component>
</template>
