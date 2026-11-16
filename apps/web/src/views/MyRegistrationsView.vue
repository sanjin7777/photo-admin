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
import { formatUntilStart, refundAmountOf } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { timeRange, pts, ptsNum } from '../composables/usePricing';

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
  const snapshot = r.refundPolicySnapshot ?? { freeCancelBeforeHours: 48, feeRatio: 0 };
  const startAt = r.session?.startAt ?? r.sessionStartAt ?? null;
  const returnable = refundAmountOf(r.feeCent, snapshot.feeRatio);

  /**
   * 取消前的确认框要讲清楚「退回多少积分、什么时点退回」。
   * 全程只提积分，不出现金额——积分是站内权益单位，不可兑现。
   */
  const lines: string[] = [];
  if (returnable <= 0) {
    lines.push(`已超过可退回时间，本次消耗的 ${pts(r.feeCent)} 将不予退回。`);
  } else if (returnable < r.feeCent) {
    const fee = r.feeCent - returnable;
    lines.push(`将退回 ${pts(returnable)}，按规则扣除 ${pts(fee)}（扣减比例 ${Math.round(snapshot.feeRatio * 100)}%）。`);
  } else {
    lines.push(`将全额退回 ${pts(returnable)}，不扣除积分。`);
  }
  if (startAt) {
    lines.push(`当前${formatUntilStart(startAt)}，免费取消需提前 ${snapshot.freeCancelBeforeHours} 小时。`);
  }
  lines.push('取消后名额立即释放，无法撤销。');

  try {
    await showConfirmDialog({
      title: '确认取消登记？',
      message: lines.join('\n'),
      confirmButtonText: '确认取消',
      cancelButtonText: '再想想',
    });
  } catch { return; }

  try {
    await api.registrations.cancel(r.id, {});
    const done = returnable <= 0
      ? '已取消登记'
      : `已取消登记，退回 ${pts(returnable)}`;
    ui.notify(done, 'success');
    await reload();
  } catch { /* 统一提示 */ }
}
</script>

<template>
  <section class="mx-auto max-w-3xl pb-6">
    <div class="mb-4">
      <h1 class="text-2xl font-semibold tracking-tight text-slate-900">我的登记</h1>
      <p class="mt-1 text-sm text-slate-500">
        按所选时段到场，凭票根核销<template v-if="total"> · 共 {{ total }} 条</template>
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
            <p class="mt-1 text-xs text-slate-500">登记于 {{ new Date(r.createdAt).toLocaleString('zh-CN') }}</p>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <span class="chip" :class="statusClass[r.status] ?? 'bg-slate-100 text-slate-600'">{{ statusLabel[r.status] ?? r.status }}</span>
            <span class="text-sm font-semibold text-slate-900">消耗 {{ ptsNum(r.feeCent) }}</span>
            <span v-if="r.discountCent > 0" class="text-xs text-emerald-600">
              基准 {{ ptsNum(r.originalFeeCent) }} · {{ r.couponTitle ?? '优惠券' }}
            </span>
          </div>
        </div>

        <div class="mt-3 flex gap-2">
          <!-- 票根：登记成功后凭此到场与核销 -->
          <RouterLink v-if="r.status !== 'CANCELLED'" :to="`/tickets/${r.id}`"
            class="btn-primary flex-1 py-2 text-center text-xs">查看票根</RouterLink>
          <button v-if="r.status === 'CONFIRMED' || r.status === 'WAITLISTED'" class="btn-ghost flex-1 py-2 text-xs" @click="cancel(r)">取消登记</button>
          <RouterLink :to="`/events/${r.eventId}`" class="btn-ghost flex-1 py-2 text-center text-xs">查看场次</RouterLink>
        </div>
      </div>
    </van-list>

    <div v-if="!firstLoad && !list.length" class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white py-14 text-center">
      <p class="text-sm font-medium text-slate-700">还没有登记记录</p>
      <RouterLink to="/" class="btn-primary mt-2 px-5 py-2 text-xs">去看看场次</RouterLink>
    </div>
  </section>
</template>
