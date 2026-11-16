<script setup lang="ts">
/**
 * 个人中心（首页版）：只放「一眼要看的东西」。
 *
 * 拆出去了三块，避免所有内容堆在一页：
 *   - 积分流水  → /points   （明细单独看，不在首页铺 10 条）
 *   - 修改密码 / 退出 / 注销 → /settings（危险操作集中隔离）
 */
import { computed, onMounted, ref } from 'vue';
import type {
  BalanceViewDto, CouponDto, MembershipDto, RegistrationDto,
} from '@photo/shared';
import { couponStatusLabel, formatPoints, labelOf } from '@photo/shared';
import { pts, ptsNum } from '../composables/usePricing';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

const session = useSessionStore();
const ui = useUiStore();

const balance = ref<BalanceViewDto | null>(null);
const memberships = ref<MembershipDto[]>([]);
const recent = ref<RegistrationDto[]>([]);
const coupons = ref<CouponDto[]>([]);

const couponAvailable = computed(() => coupons.value.filter((c) => c.status === 'UNUSED').length);
const couponStatusClass: Record<string, string> = {
  UNUSED: 'bg-emerald-50 text-emerald-700',
  USED: 'bg-slate-100 text-slate-500',
  EXPIRED: 'bg-slate-100 text-slate-500',
  REVOKED: 'bg-slate-100 text-slate-500',
};

function couponText(c: CouponDto): string {
  if (c.type === 'AMOUNT') return `减免 ${pts(Number(c.amountCent ?? 0))}`;
  const rate = (Number(c.discountBp ?? 10000) / 1000).toFixed(1).replace(/\.0$/, '');
  return `${rate} 折${c.maxDiscountCent ? `（最高减 ${pts(c.maxDiscountCent)}）` : ''}`;
}

const activeMembership = computed(() => memberships.value.find((m) => m.status === 'ACTIVE') ?? null);
const levelLabel = computed(() => (session.level === 'SVIP' ? 'SVIP 会员' : session.level === 'VIP' ? 'VIP 会员' : '普通用户'));
const levelClass = computed(() => (session.level === 'SVIP' ? 'badge-svip' : session.level === 'VIP' ? 'badge-vip' : 'badge-public'));

onMounted(async () => {
  try {
    const [b, m, r, c] = await Promise.all([
      api.balance.account(),
      api.memberships.mine(),
      api.registrations.mine({ pageSize: 3 }),
      api.coupons.mine(),
    ]);
    balance.value = b;
    memberships.value = m;
    recent.value = r.list;
    coupons.value = c;
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败', 'fail');
  }
});
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-4 pb-6">
    <!-- 身份卡 -->
    <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
      <div class="h-16 bg-gradient-to-r from-brand-50 via-white to-gold-soft" />
      <div class="-mt-8 px-5 pb-5">
        <div class="flex items-end gap-3">
          <span class="flex h-16 w-16 items-center justify-center rounded-2xl border-4 border-white bg-slate-200 text-xl font-semibold text-slate-700 shadow-sm">
            {{ (session.user?.nickname ?? '游').slice(0, 1) }}
          </span>
          <div class="min-w-0 pb-1">
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="truncate text-xl font-semibold text-slate-900">{{ session.user?.nickname ?? '未登录' }}</h1>
              <span class="chip" :class="levelClass">{{ levelLabel }}</span>
            </div>
            <p class="mt-1 truncate text-xs text-slate-500">
              微信号 {{ session.user?.wechatId ?? '—' }}
            </p>
          </div>
        </div>
        <p v-if="activeMembership" class="mt-3 rounded-lg bg-gold-soft px-3 py-2 text-xs text-gold">
          会员有效期至 {{ new Date(activeMembership.expireAt).toLocaleDateString('zh-CN') }}
        </p>
      </div>
    </div>

    <!-- 会员：积分概览（明细另开一页） -->
    <RouterLink v-if="session.isMember" to="/points"
      class="block rounded-2xl border border-slate-200 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-float">
      <div class="flex items-end justify-between">
        <div>
          <p class="text-xs text-slate-500">可用积分</p>
          <p class="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
            {{ formatPoints(balance?.account?.availableCent ?? 0) }}<span class="ml-1 text-sm font-normal text-slate-500">积分</span>
          </p>
        </div>
        <div class="flex flex-col items-end gap-1.5">
          <span class="chip bg-slate-100 text-slate-600">冻结 {{ formatPoints(balance?.account?.frozenCent ?? 0) }}</span>
          <span class="text-xs text-brand">明细 ›</span>
        </div>
      </div>
    </RouterLink>

    <!-- 普通用户：无积分账户，不做开通引导 -->
    <div v-else class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <p class="text-xs font-medium text-slate-500">当前为普通用户</p>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">普通用户登记后由运营核对身份并确认名额，不涉及积分结算。</p>
    </div>

    <!-- 最近登记 -->
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-900">最近登记</h2>
        <RouterLink to="/my" class="text-xs text-brand">全部 ›</RouterLink>
      </div>
      <RouterLink v-for="r in recent" :key="r.id" :to="`/events/${r.eventId}`"
        class="flex items-center justify-between border-t border-slate-100 py-2.5">
        <div class="min-w-0">
          <p class="truncate text-sm text-slate-800">{{ r.eventTitle ?? r.event?.title ?? `场次 #${r.eventId}` }}</p>
          <p class="text-xs text-slate-500">
            {{ r.sessionLabel ?? r.session?.label ?? '—' }} · 消耗 {{ ptsNum(r.feeCent) }}
            <span v-if="r.discountCent > 0" class="text-emerald-600">（基准 {{ ptsNum(r.originalFeeCent) }}）</span>
          </p>
        </div>
        <span class="chip shrink-0 bg-slate-100 text-slate-600">{{ labelOf(r.status) }}</span>
      </RouterLink>
      <p v-if="!recent.length" class="py-4 text-center text-xs text-slate-500">还没有登记记录</p>
    </div>

    <!-- 我的优惠券 -->
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-900">我的优惠券</h2>
        <span class="text-xs" :class="couponAvailable ? 'text-brand' : 'text-slate-500'">
          {{ couponAvailable ? `${couponAvailable} 张可用` : '暂无可用' }}
        </span>
      </div>
      <div v-for="c in coupons" :key="c.id" class="flex items-start justify-between border-t border-slate-100 py-2.5">
        <div class="min-w-0">
          <p class="truncate text-sm text-slate-800">{{ c.title }}</p>
          <p class="text-xs text-slate-500">
            {{ couponText(c) }}<span v-if="c.minSpendCent > 0"> · 满 {{ pts(c.minSpendCent) }} 可用</span>
            <span v-if="c.expiresAt"> · {{ new Date(c.expiresAt).toLocaleDateString('zh-CN') }} 到期</span>
          </p>
        </div>
        <span class="chip ml-2 shrink-0" :class="couponStatusClass[c.status] ?? 'bg-slate-100 text-slate-600'">
          {{ couponStatusLabel(c.status) }}
        </span>
      </div>
      <p v-if="!coupons.length" class="py-4 text-center text-xs text-slate-500">暂无优惠券，活动发放后会显示在这里</p>
    </div>

    <!-- 服装投票（仅 SVIP 渲染） -->
    <RouterLink v-if="session.can('vote:cast')" to="/vote"
      class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-float">
      <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-lg text-brand">投</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-slate-900">服装投票</p>
        <p class="mt-0.5 text-xs text-slate-500">为下一场选服装方案，SVIP 专属</p>
      </div>
      <span class="text-slate-400">›</span>
    </RouterLink>

    <!-- 设置：改密 / 退出 / 注销都收进这一页 -->
    <RouterLink to="/settings"
      class="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-float">
      <div>
        <p class="text-sm font-semibold text-slate-900">设置</p>
        <p class="mt-0.5 text-xs text-slate-500">修改密码 · 退出登录 · 注销账号</p>
      </div>
      <span class="text-slate-400">›</span>
    </RouterLink>
  </section>
</template>
