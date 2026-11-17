<script setup lang="ts">
/**
 * 电子票根：登记成功后凭此到场。
 *
 * 去商业化后不再有「付款凭证」的概念，票根承担两件事：
 *   1. 让用户确认自己登记的是哪一场、哪个时段（避免记错时间跑空）
 *   2. 到场时作为已登记的凭证出示
 *
 * 刻意不设「核销编号」：后台没有按编号检索/核销的入口，
 * 印一个查不到的数字只会让人误以为它能用（现场核销仍由运营在报名管理页操作）。
 *
 * 不出现任何金额：消耗多少积分只在「我的登记」列表里作为内部记录展示，
 * 票根本身只讲时间与地点。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { EventDto, RegistrationDto } from '@photo/shared';
import { api } from '../api';
import { timeRange } from '../composables/usePricing';

const route = useRoute();
const id = String(route.params.id);

const reg = ref<RegistrationDto | null>(null);
/** 场次详情单独拉：票根要展示场地、场景、模特，这些字段不在报名记录里 */
const ev = ref<EventDto | null>(null);
const loading = ref(true);
const error = ref('');

const STATUS_TEXT: Record<string, string> = {
  PENDING_PAYMENT: '待支付', CONFIRMED: '已确认', CHECKED_IN: '已签到', COMPLETED: '已完成',
  CANCELLED: '已取消', REFUND_PENDING: '取消中', REFUNDED: '已取消',
  WAITLISTED: '候补中', OFFERED: '待确认', EXPIRED: '已失效',
};
const statusText = computed(() => (reg.value ? STATUS_TEXT[reg.value.status] ?? reg.value.status : ''));
// 待支付不算可用票根：钱没确认，不能凭它入场
const usable = computed(() => reg.value != null
  && reg.value.status !== 'CANCELLED' && reg.value.status !== 'REFUNDED' && reg.value.status !== 'EXPIRED'
  && reg.value.status !== 'PENDING_PAYMENT');
const pendingPayment = computed(() => reg.value?.status === 'PENDING_PAYMENT');

const sessionLabel = computed(() => reg.value?.session?.label ?? reg.value?.sessionLabel ?? '时段待确认');
const sessionTime = computed(() => {
  const s = reg.value?.session ?? ev.value?.sessions?.find((x) => x.id === reg.value?.sessionId) ?? null;
  if (s) return timeRange(s.startAt, s.endAt);
  const at = reg.value?.sessionStartAt;
  if (!at) return '';
  const d = new Date(at);
  return `${d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
});

const eventTitle = computed(() => reg.value?.eventTitle ?? ev.value?.title ?? '');
const venue = computed(() => ev.value?.venue ?? '');
const scene = computed(() => ev.value?.scene ?? '');
const modelName = computed(() => ev.value?.model?.stageName ?? '');

onMounted(async () => {
  try {
    reg.value = await api.registrations.detail(id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '票根加载失败';
    loading.value = false;
    return;
  }
  // 场次详情是增强信息：拉不到也不该让整张票根报废
  try {
    ev.value = await api.events.detail(reg.value.eventId);
  } catch {
    ev.value = null;
  }
  loading.value = false;
});
</script>

<template>
  <section class="mx-auto max-w-md pb-10">
    <RouterLink to="/my" class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900">
      ← 返回我的登记
    </RouterLink>

    <div v-if="loading" class="mt-4 h-72 animate-pulse rounded-3xl border border-slate-200 bg-white" />

    <p v-else-if="error" class="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-600">
      {{ error }}
    </p>

    <template v-else-if="reg">
      <!-- 票根主体：上下两块用齿孔/虚线分隔，模拟实体票 -->
      <div class="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-float">
        <!-- 上部：场次信息 -->
        <div class="bg-gradient-to-br from-slate-900 via-slate-800 to-brand px-5 pb-6 pt-5 text-white">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-[11px] uppercase tracking-[0.3em] text-white/60">猫爪社摄影会 · 电子票根</p>
              <h1 class="mt-1.5 text-lg font-semibold leading-snug">{{ eventTitle }}</h1>
              <p v-if="ev?.subtitle || reg.event?.subtitle" class="mt-0.5 text-xs text-white/70">{{ ev?.subtitle ?? reg.event?.subtitle }}</p>
            </div>
            <span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
              :class="usable ? 'bg-white/20 text-white' : 'bg-white/10 text-white/60'">
              {{ statusText }}
            </span>
          </div>

          <div class="mt-5 space-y-2.5 text-[13px]">
            <div class="flex items-baseline gap-3">
              <span class="w-12 shrink-0 text-[11px] text-white/50">时段</span>
              <span class="font-medium">{{ sessionLabel }}</span>
            </div>
            <div class="flex items-baseline gap-3">
              <span class="w-12 shrink-0 text-[11px] text-white/50">时间</span>
              <span class="font-medium tabular-nums">{{ sessionTime }}</span>
            </div>
            <div v-if="venue" class="flex items-baseline gap-3">
              <span class="w-12 shrink-0 text-[11px] text-white/50">场地</span>
              <span class="font-medium">{{ venue }}<span v-if="scene" class="text-white/70"> · {{ scene }}</span></span>
            </div>
            <div v-if="modelName" class="flex items-baseline gap-3">
              <span class="w-12 shrink-0 text-[11px] text-white/50">模特</span>
              <span class="font-medium">{{ modelName }}</span>
            </div>
          </div>
        </div>

        <!-- 撕线：两侧半圆缺口 + 虚线 -->
        <div class="relative h-0">
          <span class="absolute -left-2.5 -top-2.5 h-5 w-5 rounded-full bg-slate-50" />
          <span class="absolute -right-2.5 -top-2.5 h-5 w-5 rounded-full bg-slate-50" />
          <div class="absolute inset-x-5 -top-px border-t border-dashed border-slate-300" />
        </div>

        <!-- 下部：到场提示（不设编号：后台没有按号核销的入口，编号只会让人误以为有用） -->
        <div class="px-5 pb-5 pt-4">
          <div v-if="pendingPayment" class="rounded-xl bg-amber-50 px-3 py-3 text-center text-xs leading-relaxed text-amber-700">
            该登记尚未付款，票根暂不可用。<br />请联系客服完成付款，运营确认收款后即可凭票根到场。
          </div>
          <div v-else-if="!usable" class="rounded-xl bg-slate-50 px-3 py-3 text-center text-xs text-slate-500">
            该记录{{ statusText }}，票根已失效，无法用于现场核销。
          </div>
          <div v-else class="rounded-xl bg-slate-50 px-3 py-3 text-center text-xs leading-relaxed text-slate-600">
            请按所选时段到场，向工作人员出示本页核销。<br />
            迟到不延长拍摄时间。
          </div>

          <div class="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400">
            <span>登记于 {{ new Date(reg.createdAt).toLocaleString('zh-CN') }}</span>
            <span>{{ reg.eventId ? `场次 #${reg.eventId}` : '' }}</span>
          </div>
        </div>
      </div>

      <p class="mt-4 text-center text-xs text-slate-400">
        建议截图保存；如需取消登记，请回到「我的登记」操作。
      </p>
    </template>
  </section>
</template>
