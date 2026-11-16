<script setup lang="ts">
/**
 * 积分明细：余额概览 + 完整流水。
 *
 * 从「个人中心」拆出来——原来流水直接铺在个人中心里，
 * 首页越滚越长，会员每次想看一眼最近登记都要先划过 10 条流水。
 */
import { computed, onMounted, ref } from 'vue';
import type { BalanceTransactionDto, BalanceViewDto } from '@photo/shared';
import { formatPoints, labelOf } from '@photo/shared';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

const session = useSessionStore();
const ui = useUiStore();

const balance = ref<BalanceViewDto | null>(null);
const txns = ref<BalanceTransactionDto[]>([]);
const loading = ref(true);

const available = computed(() => balance.value?.account?.availableCent ?? 0);
const frozen = computed(() => balance.value?.account?.frozenCent ?? 0);
const bonus = computed(() => balance.value?.account?.bonusGrantedCent ?? 0);

onMounted(async () => {
  try {
    const [b, t] = await Promise.all([
      api.balance.account(),
      api.balance.transactions({ pageSize: 50 }),
    ]);
    balance.value = b;
    // 普通用户没有余额账户：接口返回 applicable=false / account=null
    txns.value = b?.applicable ? t.list : [];
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败', 'fail');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="mx-auto max-w-2xl space-y-4 pb-6">
    <div class="flex items-center gap-2">
      <RouterLink to="/profile" class="text-xs text-slate-500 hover:text-slate-900">← 返回个人中心</RouterLink>
    </div>

    <div v-if="!session.isMember" class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <p class="text-xs font-medium text-slate-500">当前为普通用户</p>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        普通用户没有积分账户，登记后由运营核对身份并确认名额。
      </p>
    </div>

    <template v-else>
      <!-- 余额 -->
      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <p class="text-xs text-slate-500">可用积分</p>
        <p class="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
          {{ formatPoints(available) }}<span class="ml-1 text-sm font-normal text-slate-500">积分</span>
        </p>
        <div class="mt-3 flex flex-wrap gap-1.5">
          <span class="chip bg-slate-100 text-slate-600">冻结 {{ formatPoints(frozen) }}</span>
          <span v-if="bonus > 0" class="chip bg-amber-50 text-amber-700">累计赠送 {{ formatPoints(bonus) }}</span>
        </div>
        <p class="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          积分是本会内部的活动权益单位，仅用于登记时结算消耗。积分由运营发放，<b>不可购买、不可转让、不可兑现</b>，也不设有效期。
        </p>
      </div>

      <!-- 流水 -->
      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div class="mb-1 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-900">积分流水</h2>
          <span class="text-xs text-slate-500">最近 {{ txns.length }} 条</span>
        </div>
        <div v-if="loading" class="space-y-2 py-2">
          <div v-for="i in 3" :key="i" class="h-10 animate-pulse rounded-lg bg-slate-100" />
        </div>
        <template v-else>
          <div v-for="t in txns" :key="t.id" class="flex items-center justify-between border-t border-slate-100 py-2.5">
            <div class="min-w-0">
              <p class="text-sm text-slate-800">{{ labelOf(t.bizType) }}</p>
              <p class="text-xs text-slate-500">{{ new Date(t.createdAt).toLocaleString('zh-CN') }}</p>
            </div>
            <span class="shrink-0 text-sm font-medium"
              :class="t.direction === 'IN' || t.direction === 'UNFREEZE' ? 'text-emerald-600' : 'text-slate-700'">
              {{ t.direction === 'IN' || t.direction === 'UNFREEZE' ? '+' : '-' }}{{ formatPoints(t.amountCent) }}
            </span>
          </div>
          <p v-if="!txns.length" class="py-6 text-center text-xs text-slate-500">暂无流水</p>
        </template>
      </div>
    </template>
  </section>
</template>
