<script setup lang="ts">
/**
 * 我的报名：分页 + 滚动加载。
 *
 * 报名记录只增不减，原来一次拉 50 条、没有分页——老用户翻不到更早的报名，
 * 而且首屏白等一坨数据。改成 van-list 触底加载：首屏 10 条，滚到底再要下一页。
 */
import { onMounted, ref } from 'vue';
import { showConfirmDialog } from 'vant';
import type { RegistrationDto } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { timeRange, yuan } from '../composables/usePricing';

const ui = useUiStore();
const list = ref<RegistrationDto[]>([]);
const page = ref(1);
const pageSize = 10;
const total = ref(0);
const loading = ref(false);
const finished = ref(false);
/** 首屏骨架屏与「加载更多」要分开：骨架只在一条都还没有时出现 */
const firstLoad = ref(true);

// WAITLISTED / OFFERED / EXPIRED 是候补时代的历史状态，保留以便旧记录正常显示
const statusLabel: Record<string, string> = {
  CONFIRMED: '已确认', WAITLISTED: '候补中', OFFERED: '待确认递补', EXPIRED: '已失效',
  REFUND_PENDING: '退款中', REFUNDED: '已退款', CHECKED_IN: '已签到', COMPLETED: '已完成', CANCELLED: '已取消',
};
const statusClass: Record<string, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700',
  WAITLISTED: 'bg-slate-100 text-slate-600',
  OFFERED: 'bg-gold-soft text-gold',
  REFUND_PENDING: 'bg-amber-50 text-amber-700',
  REFUNDED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-500',
  EXPIRED: 'bg-slate-100 text-slate-500',
};

async function loadMore(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.registrations.mine({ page: page.value, pageSize });
    list.value = page.value === 1 ? res.list : [...list.value, ...res.list];
    total.value = res.total;
    // 用已加载条数与 total 比较，而不是「本页不满 pageSize 就结束」：
    // 服务端若因权限过滤少返回几条，后者会提前判定没有更多。
    finished.value = list.value.length >= res.total || !res.list.length;
    page.value += 1;
  } catch (e) {
    finished.value = true;
    ui.notify(e instanceof Error ? e.message : '加载失败', 'fail');
  } finally {
    loading.value = false;
    firstLoad.value = false;
  }
}

/** 取消后重新从第一页拉：状态变了，本地列表直接重载最省心 */
async function reload(): Promise<void> {
  page.value = 1;
  finished.value = false;
  list.value = [];
  await loadMore();
}

onMounted(loadMore);

function sessionText(r: RegistrationDto): string {
  if (r.session) return `${r.session.label} · ${timeRange(r.session.startAt, r.session.endAt)}`;
  if (r.sessionLabel && r.sessionStartAt) {
    return `${r.sessionLabel} · ${new Date(r.sessionStartAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  return r.sessionLabel ?? '时段待确认';
}

async function cancel(r: RegistrationDto): Promise<void> {
  const tip = r.paymentStatus === 'UNPAID'
    ? `本单为线下支付，取消后请与客服确认退款事宜（金额 ${yuan(r.feeCent)}）。`
    : `取消后需等待运营审核退款，退款金额以取消规则为准（约 ${yuan(r.feeCent)} 起）。取消后名额将释放。`;
  try {
    await showConfirmDialog({ title: '确认取消报名？', message: tip, confirmButtonText: '确认取消', cancelButtonText: '再想想' });
  } catch { return; }
  try {
    await api.registrations.cancel(r.id, {});
    ui.notify('已提交取消申请', 'success');
    await reload();
  } catch { /* 统一提示 */ }
}
</script>

<template>
  <section class="mx-auto max-w-3xl pb-6">
    <div class="mb-4">
      <h1 class="text-2xl font-semibold tracking-tight text-slate-900">我的报名</h1>
      <p class="mt-1 text-sm text-slate-500">
        按所选时段到场，取消规则以场次说明为准<template v-if="total"> · 共 {{ total }} 条</template>
      </p>
    </div>

    <div v-if="firstLoad" class="space-y-3">
      <div v-for="i in 3" :key="i" class="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white" />
    </div>

    <van-list
      v-else
      v-model:loading="loading"
      :finished="finished"
      finished-text="没有更多了"
      :immediate-check="false"
      @load="loadMore"
    >
      <div v-for="r in list" :key="r.id" class="mb-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="clamp-1 text-[15px] font-semibold text-slate-900">{{ r.eventTitle ?? r.event?.title ?? `场次 #${r.eventId}` }}</p>
            <p class="mt-1 text-xs text-slate-500">
              {{ sessionText(r) }}
            </p>
            <p class="mt-1 text-xs text-slate-500">报名于 {{ new Date(r.createdAt).toLocaleString('zh-CN') }}</p>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <span class="chip" :class="statusClass[r.status] ?? 'bg-slate-100 text-slate-600'">{{ statusLabel[r.status] ?? r.status }}</span>
            <span class="text-sm font-semibold text-slate-900">{{ yuan(r.feeCent) }}</span>
            <span v-if="r.discountCent > 0" class="text-xs text-emerald-600">
              原价 {{ yuan(r.originalFeeCent) }} · {{ r.couponTitle ?? '优惠券' }}
            </span>
          </div>
        </div>

        <div v-if="r.paymentStatus === 'UNPAID'" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          <b>待线下支付</b>：请联系客服完成付款，运营确认后状态会更新为已支付。
        </div>
        <div v-else-if="r.paymentStatus === 'PAID'" class="mt-3 text-xs text-slate-500">已完成收款确认</div>

        <div class="mt-3 flex gap-2">
          <!-- 候补已下线（2026-11-13）：不再展示「确认递补」 -->
          <button v-if="r.status === 'CONFIRMED' || r.status === 'WAITLISTED'" class="btn-ghost flex-1 py-2 text-xs" @click="cancel(r)">取消报名</button>
          <RouterLink :to="`/events/${r.eventId}`" class="btn-ghost flex-1 py-2 text-center text-xs">查看场次</RouterLink>
        </div>
      </div>
    </van-list>

    <div v-if="!firstLoad && !list.length" class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white py-14 text-center">
      <p class="text-sm font-medium text-slate-700">还没有报名记录</p>
      <RouterLink to="/" class="btn-primary mt-2 px-5 py-2 text-xs">去看看场次</RouterLink>
    </div>
  </section>
</template>
