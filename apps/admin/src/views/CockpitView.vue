<script setup lang="ts">
/**
 * 数据驾驶舱：暗房仪表风格的经营分析页。
 * 数据全部来自现有后台接口（按能力分别拉取，前端聚合），不新增 API、不动数据库。
 * 图表用 ECharts（按需注册），支持时间范围 / 场次筛选、60s 自动刷新与快照导出。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type {
  AdminCouponDto, AdminUserListItemDto, Capability, EventDto, PaymentStatus,
  RegistrationDto, RefundOrderDto,
} from '@photo/shared';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import { emptyPage, loadAllPages } from '../utils/loadAll';
import { personLabel } from '../utils/labels';
import { useCountUp } from '../composables/useCountUp';
import CkChart from '../components/cockpit/CkChart.vue';
import {
  createCouponOption, createDonutOption, createFillOption, createGaugeOption,
  createHeatmapOption, createTrendOption, fmtYuan,
} from './cockpit/chartOptions';

const router = useRouter();
const session = useSessionStore();
const ui = useUiStore();

const DAY = 86_400_000;
/** 占位中的报名状态：候补下线后只会出现后两种，历史 WAITLISTED/OFFERED 仍计入在营口径 */
const ACTIVE_STATUSES = ['WAITLISTED', 'OFFERED', 'CONFIRMED', 'CHECKED_IN'];

/* ---------------- 状态 ---------------- */
const loading = ref(true);
const refreshing = ref(false);
const lastUpdated = ref<Date | null>(null);
const now = ref(Date.now());
const rangeDays = ref(30);
const eventFilter = ref('');
const autoRefresh = ref(true);

const events = ref<EventDto[]>([]);
const regs = ref<RegistrationDto[]>([]);
const refunds = ref<RefundOrderDto[]>([]);
const coupons = ref<AdminCouponDto[]>([]);
const users = ref<AdminUserListItemDto[]>([]);

const canEvents = computed(() => session.can('admin:event:write'));
const canRegs = computed(() => session.can('admin:registration:write'));
const canRefunds = computed(() => session.can('admin:refund:review'));
const canMembers = computed(() => session.can('admin:membership:grant'));

const ranges = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 0, label: '全部' },
];

/* ---------------- 数据加载 ---------------- */
async function load(silent = false): Promise<void> {
  if (silent) refreshing.value = true;
  else loading.value = true;
  // 各接口按能力调用；空页用带泛型的 emptyPage()，避免 as never 把类型检查关掉
  try {
    const [ev, rg, rf, cp, us] = await Promise.all([
      canEvents.value ? loadAllPages((page, pageSize) => api.admin.events.list({ page, pageSize })).catch(() => emptyPage<EventDto>()) : emptyPage<EventDto>(),
      canRegs.value ? loadAllPages((page, pageSize) => api.admin.registrations.list({ page, pageSize })).catch(() => emptyPage<RegistrationDto>()) : emptyPage<RegistrationDto>(),
      canRefunds.value ? loadAllPages((page, pageSize) => api.admin.refunds.list({ page, pageSize })).catch(() => emptyPage<RefundOrderDto>()) : emptyPage<RefundOrderDto>(),
      canMembers.value ? loadAllPages((page, pageSize) => api.admin.coupons.list({ page, pageSize })).catch(() => emptyPage<AdminCouponDto>()) : emptyPage<AdminCouponDto>(),
      canMembers.value ? loadAllPages((page, pageSize) => api.admin.members.list({ page, pageSize })).catch(() => emptyPage<AdminUserListItemDto>()) : emptyPage<AdminUserListItemDto>(),
    ]);
    events.value = ev.list;
    regs.value = rg.list;
    refunds.value = rf.list;
    coupons.value = cp.list;
    users.value = us.list;
    lastUpdated.value = new Date();
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

let clockTimer = 0;
let refreshTimer = 0;
onMounted(() => {
  void load();
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
watch(autoRefresh, (on) => {
  window.clearInterval(refreshTimer);
  if (on) refreshTimer = window.setInterval(() => void load(true), 60_000);
}, { immediate: true });
onBeforeUnmount(() => {
  window.clearInterval(clockTimer);
  window.clearInterval(refreshTimer);
});

/* ---------------- 范围与过滤 ---------------- */
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const rangeStart = computed(() => (rangeDays.value ? startOfDay(now.value) - (rangeDays.value - 1) * DAY : 0));
const inRange = (isoTime: string): boolean => Date.parse(isoTime) >= rangeStart.value;
const matchEvent = (id: string | null): boolean => !eventFilter.value || id === eventFilter.value;
const isActive = (r: RegistrationDto): boolean => ACTIVE_STATUSES.includes(r.status);
const isPaid = (r: RegistrationDto): boolean =>
  (r.status === 'CONFIRMED' || r.status === 'CHECKED_IN') && (r.paymentStatus === 'PAID' || r.paymentStatus === 'NOT_REQUIRED');

const regsInRange = computed(() => regs.value.filter((r) => inRange(r.createdAt) && matchEvent(r.eventId)));
const activeRegs = computed(() => regsInRange.value.filter(isActive));
const paidRegs = computed(() => regsInRange.value.filter(isPaid));
const revenue = computed(() => paidRegs.value.reduce((s, r) => s + r.feeCent, 0));
const pointsPaid = computed(() => paidRegs.value.filter((r) => r.paymentStatus === 'NOT_REQUIRED').reduce((s, r) => s + r.feeCent, 0));
const cancelledCount = computed(() => regsInRange.value.filter((r) => r.status === 'CANCELLED').length);
const unpaidRegs = computed(() => regsInRange.value.filter((r) => r.paymentStatus === 'UNPAID' && r.status === 'CONFIRMED'));
const unpaidAmount = computed(() => unpaidRegs.value.reduce((s, r) => s + r.feeCent, 0));

const refundsInRange = computed(() => refunds.value.filter((r) => inRange(r.createdAt) && matchEvent(r.eventId)));
const pendingRefunds = computed(() => refundsInRange.value.filter((r) => r.status === 'REQUESTED'));
const pendingAmount = computed(() => pendingRefunds.value.reduce((s, r) => s + r.amountCent, 0));
const refundedAmount = computed(() => refundsInRange.value.filter((r) => r.status === 'REFUNDED').reduce((s, r) => s + r.amountCent, 0));
const rejectedCount = computed(() => refundsInRange.value.filter((r) => r.status === 'REJECTED').length);
const refundRate = computed(() => {
  const base = revenue.value + refundedAmount.value;
  return base ? Math.round((refundedAmount.value / base) * 100) : 0;
});
const recentRefunds = computed(() =>
  [...refundsInRange.value].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 4),
);

/* 环比：与上一等长周期对比（全部范围无环比） */
const prevRegs = computed(() => {
  if (!rangeDays.value) return [];
  const prevStart = rangeStart.value - rangeDays.value * DAY;
  return regs.value.filter((r) => {
    const t = Date.parse(r.createdAt);
    return t >= prevStart && t < rangeStart.value && matchEvent(r.eventId);
  });
});
const pctDelta = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
const revenueDelta = computed(() => pctDelta(revenue.value, prevRegs.value.filter(isPaid).reduce((s, r) => s + r.feeCent, 0)));
const regsDelta = computed(() => pctDelta(activeRegs.value.length, prevRegs.value.filter(isActive).length));

/* ---------------- 趋势分桶 ---------------- */
interface Bucket { label: string; count: number; revenue: number }
const trend = computed<Bucket[]>(() => {
  let span = rangeDays.value;
  if (!span) {
    const ts = regs.value.map((r) => Date.parse(r.createdAt));
    const oldest = ts.length ? Math.min(...ts) : now.value - 29 * DAY;
    span = Math.max(7, Math.min(90, Math.ceil((startOfDay(now.value) - startOfDay(oldest)) / DAY) + 1));
  }
  const bucketDays = span > 31 ? 7 : 1;
  const n = Math.ceil(span / bucketDays);
  const start = startOfDay(now.value) - (span - 1) * DAY;
  const out: Bucket[] = Array.from({ length: n }, (_, i) => {
    const d = new Date(start + i * bucketDays * DAY);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0, revenue: 0 };
  });
  for (const r of regsInRange.value) {
    const idx = Math.floor((startOfDay(Date.parse(r.createdAt)) - start) / DAY / bucketDays);
    if (idx < 0 || idx >= n) continue;
    if (isActive(r)) out[idx].count += 1;
    if (isPaid(r)) out[idx].revenue += r.feeCent;
  }
  return out;
});

/* ---------------- 场次满员率 ---------------- */
const publishedEvents = computed(() =>
  events.value.filter((e) => e.status !== 'DRAFT' && e.status !== 'CANCELLED' && matchEvent(e.id)),
);
const fillRows = computed(() =>
  publishedEvents.value
    .map((e) => {
      const cap = e.sessions.reduce((s, x) => s + x.capacity, 0);
      const used = e.sessions.reduce((s, x) => s + x.capacityUsed, 0);
      return { id: e.id, title: e.title, cap, used, pct: cap ? Math.round((used / cap) * 100) : 0 };
    })
    .sort((a, b) => b.pct - a.pct || b.used - a.used)
    .slice(0, 6),
);
const occupancy = computed(() => {
  const cap = publishedEvents.value.reduce((s, e) => s + e.sessions.reduce((a, x) => a + x.capacity, 0), 0);
  const used = publishedEvents.value.reduce((s, e) => s + e.sessions.reduce((a, x) => a + x.capacityUsed, 0), 0);
  return cap ? Math.round((used / cap) * 100) : 0;
});
const fullSessions = computed(() =>
  publishedEvents.value.reduce((s, e) => s + e.sessions.filter((x) => x.capacityUsed >= x.capacity).length, 0),
);

/* ---------------- 分布 ---------------- */
const payDist = computed(() => {
  const cnt: Record<PaymentStatus, number> = { PAID: 0, NOT_REQUIRED: 0, UNPAID: 0, REFUNDED: 0 };
  for (const r of regsInRange.value) cnt[r.paymentStatus] += 1;
  return [
    { label: '已收款', value: cnt.PAID, color: '#34d399' },
    { label: '积分抵扣', value: cnt.NOT_REQUIRED, color: '#22d3ee' },
    { label: '待收款', value: cnt.UNPAID, color: '#f5a524' },
    { label: '已退款', value: cnt.REFUNDED, color: '#f43f7a' },
  ];
});
const levelDist = computed(() => {
  const cnt = { NONE: 0, VIP: 0, SVIP: 0 };
  for (const u of users.value) cnt[u.level] += 1;
  return [
    { label: 'SVIP', value: cnt.SVIP, color: '#f7c948' },
    { label: 'VIP', value: cnt.VIP, color: '#f43f7a' },
    { label: '普通用户', value: cnt.NONE, color: '#8b93a7' },
  ];
});
const memberCount = computed(() => levelDist.value[0].value + levelDist.value[1].value);
const newUsers = computed(() => users.value.filter((u) => inRange(u.createdAt)).length);
/** 会员累计赠送积分（分）：由各用户 bonusGrantedCent 求和，BONUS 流水派生值 */
const bonusGrantedTotal = computed(() => users.value.reduce((s, u) => s + (u.bonusGrantedCent ?? 0), 0));

const couponStats = computed(() => {
  const cnt = { UNUSED: 0, USED: 0, EXPIRED: 0, REVOKED: 0 };
  for (const c of coupons.value.filter((x) => inRange(x.createdAt))) cnt[c.status] += 1;
  const total = cnt.UNUSED + cnt.USED + cnt.EXPIRED + cnt.REVOKED;
  const denom = total - cnt.REVOKED;
  return { ...cnt, total, rate: denom ? Math.round((cnt.USED / denom) * 100) : 0 };
});
const discountTotal = computed(() => regsInRange.value.filter((r) => r.couponId).reduce((s, r) => s + r.discountCent, 0));

/* 报名热力：星期 × 小时 */
const heatmap = computed(() => {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of regsInRange.value) {
    const d = new Date(r.createdAt);
    grid[(d.getDay() + 6) % 7][d.getHours()] += 1;
  }
  const data: Array<[number, number, number]> = [];
  let max = 0;
  grid.forEach((row, y) => row.forEach((v, x) => { data.push([x, y, v]); max = Math.max(max, v); }));
  return { data, max };
});

const feed = computed(() =>
  [...regsInRange.value].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 8),
);

/* ---------------- KPI ---------------- */
const dRevenue = useCountUp(computed(() => Math.round(revenue.value / 100)));
const dActive = useCountUp(computed(() => activeRegs.value.length));
const dOcc = useCountUp(occupancy);
const dUnpaid = useCountUp(computed(() => unpaidRegs.value.length));
const dPending = useCountUp(computed(() => pendingRefunds.value.length));
const dMembers = useCountUp(memberCount);

interface Kpi {
  key: string; label: string; display: string; sub: string;
  delta: number | null; accent: string; to: string; cap: Capability;
  warn?: boolean; spark?: number[];
}
const cards = computed<Kpi[]>(() => ([
  {
    key: 'revenue', label: '实收金额', display: `${dRevenue.value.toLocaleString('zh-CN')} 积分`,
    sub: `其中积分抵扣 ${fmtYuan(pointsPaid.value)}`, delta: revenueDelta.value,
    accent: '#f5a524', to: '/registrations', cap: 'admin:registration:write', spark: trend.value.map((b) => b.revenue),
  },
  {
    key: 'regs', label: '报名名额', display: String(dActive.value),
    sub: `期内取消 ${cancelledCount.value} 条`, delta: regsDelta.value,
    accent: '#22d3ee', to: '/registrations', cap: 'admin:registration:write', spark: trend.value.map((b) => b.count),
  },
  {
    key: 'occ', label: '上座率', display: `${dOcc.value}%`,
    sub: `${fullSessions.value} 个时段已满`, delta: null,
    accent: '#34d399', to: '/events', cap: 'admin:event:write',
  },
  {
    key: 'unpaid', label: '待收款', display: String(dUnpaid.value),
    sub: `合计 ${fmtYuan(unpaidAmount.value)} 积分`, delta: null,
    accent: '#f5a524', to: '/registrations?pay=UNPAID', cap: 'admin:registration:write', warn: true,
  },
  {
    key: 'pending', label: '待审核退款', display: String(dPending.value),
    sub: `合计 ${fmtYuan(pendingAmount.value)} 积分`, delta: null,
    accent: '#f43f7a', to: '/finance?tab=refunds', cap: 'admin:refund:review', warn: true,
  },
  {
    key: 'members', label: '会员', display: String(dMembers.value),
    sub: `VIP ${levelDist.value[1].value} · SVIP ${levelDist.value[0].value} · 期内新增 ${newUsers.value}`, delta: null,
    accent: '#f7c948', to: '/members', cap: 'admin:membership:grant',
  },
] as Kpi[]).filter((c) => session.can(c.cap)));

function sparkPts(series: number[]): string {
  const max = Math.max(1, ...series);
  const n = Math.max(1, series.length - 1);
  return series.map((v, i) => `${((i / n) * 100).toFixed(1)},${(26 - (v / max) * 22).toFixed(1)}`).join(' ');
}

/* ---------------- ECharts 配置（纯映射抽到 ./cockpit/chartOptions.ts） ---------------- */
const trendOption = computed(() => createTrendOption(trend.value));
const gaugeOption = computed(() => createGaugeOption(occupancy.value));
const payOption = computed(() => createDonutOption(payDist.value, '报名单量'));
const levelOption = computed(() => createDonutOption(levelDist.value, '用户总数'));
const fillOption = computed(() => createFillOption(fillRows.value));
const heatmapOption = computed(() => createHeatmapOption(heatmap.value));
const couponOption = computed(() => createCouponOption(couponStats.value));

function onFillClick(params: Record<string, unknown>): void {
  const row = fillRows.value[Number(params.dataIndex)];
  if (row) void router.push({ path: '/registrations', query: { eventId: row.id, title: row.title } });
}

/* ---------------- 头部信息 ---------------- */
const clockText = computed(() => new Date(now.value).toLocaleTimeString('zh-CN', { hour12: false }));
const dateText = computed(() => new Date(now.value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }));
const updatedText = computed(() => (lastUpdated.value ? lastUpdated.value.toLocaleTimeString('zh-CN', { hour12: false }) : '—'));

function relTime(isoTime: string): string {
  const diff = now.value - Date.parse(isoTime);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

const REG_DOT: Record<string, string> = {
  // WAITLISTED / OFFERED 为候补时代的历史状态配色，保留以便旧数据在图例上仍可区分
  CONFIRMED: '#34d399', CHECKED_IN: '#22d3ee', CANCELLED: '#8b93a7', WAITLISTED: '#f5a524', OFFERED: '#a78bfa',
};
const REFUND_META: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: '待审核', cls: 'text-[#f5a524] border-[#f5a524]/40 bg-[#f5a524]/10' },
  REFUNDED: { label: '已退款', cls: 'text-[#34d399] border-[#34d399]/40 bg-[#34d399]/10' },
  REJECTED: { label: '已驳回', cls: 'text-[#f43f7a] border-[#f43f7a]/40 bg-[#f43f7a]/10' },
  APPROVED: { label: '退款中', cls: 'text-[#22d3ee] border-[#22d3ee]/40 bg-[#22d3ee]/10' },
  REFUNDING: { label: '退款中', cls: 'text-[#22d3ee] border-[#22d3ee]/40 bg-[#22d3ee]/10' },
};

/* ---------------- 快照导出 ---------------- */
function exportSnapshot(): void {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = ['指标,值'];
  lines.push(`统计范围,${rangeDays.value ? `近 ${rangeDays.value} 天` : '全部'}`);
  lines.push(`场次筛选,${eventFilter.value ? events.value.find((e) => e.id === eventFilter.value)?.title ?? eventFilter.value : '全部场次'}`);
  lines.push(`实收积分,${(revenue.value / 100).toFixed(2)}`);
  lines.push(`报名名额,${activeRegs.value.length}`);
  lines.push(`上座率(%),${occupancy.value}`);
  lines.push(`待收款(笔),${unpaidRegs.value.length}`);
  lines.push(`待确认金额,${(unpaidAmount.value / 100).toFixed(2)}`);
  lines.push(`待审核退款(笔),${pendingRefunds.value.length}`);
  lines.push(`已退回积分,${(refundedAmount.value / 100).toFixed(2)}`);
  lines.push(`会员数,${memberCount.value}`);
  lines.push(`优惠券核销率(%),${couponStats.value.rate}`);
  lines.push('', '场次,已报,容量,满员率(%)');
  for (const r of fillRows.value) lines.push([esc(r.title), r.used, r.cap, r.pct].join(','));
  lines.push('', '日期,报名名额,实收积分');
  for (const b of trend.value) lines.push([b.label, b.count, (b.revenue / 100).toFixed(2)].join(','));
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `驾驶舱快照_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ui.notify('已导出驾驶舱快照', 'success');
}
</script>

<template>
  <section class="cockpit-root relative -m-3 min-h-[calc(100dvh-57px)] overflow-hidden p-4 lg:-m-6 lg:min-h-dvh lg:p-6">
    <div class="ck-bg" aria-hidden="true" />

    <div class="relative">
      <!-- 指挥台头部 -->
      <header class="ck-panel mb-3 flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
        <div class="flex items-center gap-3">
          <svg viewBox="0 0 40 40" class="h-9 w-9 ck-aperture" aria-hidden="true">
            <circle cx="20" cy="20" r="17" fill="none" stroke="#f5a524" stroke-width="1.5" opacity="0.9" />
            <g v-for="i in 6" :key="i" :transform="`rotate(${i * 60} 20 20)`">
              <line x1="20" y1="4" x2="27.5" y2="18" stroke="#22d3ee" stroke-width="1.5" opacity="0.85" />
            </g>
            <circle cx="20" cy="20" r="5" fill="none" stroke="#f43f7a" stroke-width="1.5" />
          </svg>
          <div>
            <h1 class="text-lg font-semibold tracking-wide text-slate-100">数据驾驶舱</h1>
            <p class="text-[11px] tracking-[0.25em] text-[#8b93a7]">CAT'S PAW · DATA COCKPIT</p>
          </div>
        </div>

        <div class="hidden items-center gap-2 md:flex">
          <span class="relative flex h-2 w-2">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#34d399] opacity-60" />
            <span class="relative inline-flex h-2 w-2 rounded-full bg-[#34d399]" />
          </span>
          <div class="font-mono text-sm text-slate-200">{{ clockText }}</div>
          <div class="text-xs text-[#8b93a7]">{{ dateText }} · 更新于 {{ updatedText }}</div>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <div class="ck-seg" role="group" aria-label="统计时间范围">
            <button v-for="r in ranges" :key="r.days" type="button"
              :class="rangeDays === r.days ? 'ck-seg-on' : ''"
              @click="rangeDays = r.days">{{ r.label }}</button>
          </div>

          <select v-model="eventFilter" class="ck-select" aria-label="按场次筛选">
            <option value="">全部场次</option>
            <option v-for="e in events" :key="e.id" :value="e.id">{{ e.title }}</option>
          </select>

          <button type="button" class="ck-toggle" :class="autoRefresh ? 'ck-toggle-on' : ''"
            :aria-pressed="autoRefresh" @click="autoRefresh = !autoRefresh">
            <span class="ck-toggle-dot" />自动刷新
          </button>

          <button type="button" class="ck-btn" :disabled="refreshing" @click="load(true)">
            <span class="inline-block" :class="refreshing ? 'animate-spin' : ''">⟳</span> 刷新
          </button>
          <button type="button" class="ck-btn ck-btn-amber" @click="exportSnapshot">导出快照</button>
        </div>
      </header>

      <!-- 加载骨架 -->
      <div v-if="loading" class="grid gap-3">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div v-for="i in 6" :key="i" class="ck-panel ck-shimmer h-28" />
        </div>
        <div class="grid gap-3 xl:grid-cols-3">
          <div class="ck-panel ck-shimmer h-72 xl:col-span-2" />
          <div class="ck-panel ck-shimmer h-72" />
        </div>
      </div>

      <template v-else>
        <!-- KPI -->
        <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <RouterLink v-for="(c, i) in cards" :key="c.key" :to="c.to"
            class="ck-panel ck-kpi group px-4 py-3"
            :style="{ '--accent': c.accent, animationDelay: `${i * 60}ms` }">
            <div class="flex items-center justify-between">
              <span class="text-xs tracking-wider text-[#8b93a7]">{{ c.label }}</span>
              <span v-if="c.delta != null" class="font-mono text-[11px]"
                :class="c.delta >= 0 ? 'text-[#34d399]' : 'text-[#f43f7a]'">
                {{ c.delta >= 0 ? '▲' : '▼' }} {{ Math.abs(c.delta) }}%
              </span>
              <span v-else-if="c.warn" class="h-1.5 w-1.5 rounded-full" :style="{ background: c.accent }" />
            </div>
            <p class="mt-1.5 font-mono text-2xl font-semibold leading-none text-slate-100 transition group-hover:text-white">{{ c.display }}</p>
            <p class="mt-1.5 truncate text-[11px] text-[#8b93a7]">{{ c.sub }}</p>
            <svg v-if="c.spark" viewBox="0 0 100 28" preserveAspectRatio="none" class="mt-1 h-6 w-full opacity-70">
              <polyline :points="sparkPts(c.spark)" fill="none" :stroke="c.accent" stroke-width="1.5" vector-effect="non-scaling-stroke" />
            </svg>
          </RouterLink>
        </div>

        <!-- 第一排：趋势 + 上座率仪表 -->
        <div class="mb-3 grid gap-3 xl:grid-cols-3">
          <div class="ck-panel ck-rise p-4 xl:col-span-2">
            <div class="ck-head">
              <h2>报名与营收趋势</h2>
              <span class="ck-head-meta">拖动下方滑块可缩放区间</span>
            </div>
            <CkChart :option="trendOption" height="300px" />
          </div>
          <div class="ck-panel ck-rise p-4" style="animation-delay: 80ms">
            <div class="ck-head">
              <h2>上座率仪表</h2>
              <RouterLink v-if="canEvents" to="/events" class="ck-link">场次管理 →</RouterLink>
            </div>
            <CkChart v-if="canEvents" :option="gaugeOption" height="210px" />
            <div class="mt-1 grid grid-cols-3 gap-2 text-center">
              <div class="ck-mini">
                <p class="font-mono text-base text-slate-100">{{ publishedEvents.length }}</p>
                <p class="text-[11px] text-[#8b93a7]">在架场次</p>
              </div>
              <div class="ck-mini">
                <p class="font-mono text-base text-[#f43f7a]">{{ fullSessions }}</p>
                <p class="text-[11px] text-[#8b93a7]">已满时段</p>
              </div>
              <div class="ck-mini">
                <p class="font-mono text-base text-[#22d3ee]">{{ activeRegs.length }}</p>
                <p class="text-[11px] text-[#8b93a7]">活跃名额</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 第二排：满员率 / 收款 / 等级 -->
        <div class="mb-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div v-if="canEvents" class="ck-panel ck-rise p-4" style="animation-delay: 120ms">
            <div class="ck-head">
              <h2>场次满员率</h2>
              <span class="ck-head-meta">点击条形查看报名</span>
            </div>
            <CkChart :option="fillOption" height="230px" @click="onFillClick" />
          </div>
          <div v-if="canRegs" class="ck-panel ck-rise p-4" style="animation-delay: 160ms">
            <div class="ck-head"><h2>收款状态</h2></div>
            <CkChart :option="payOption" height="230px" />
          </div>
          <div v-if="canMembers" class="ck-panel ck-rise p-4" style="animation-delay: 200ms">
            <div class="ck-head">
              <h2>会员等级</h2>
              <RouterLink to="/members" class="ck-link">用户管理 →</RouterLink>
            </div>
            <CkChart :option="levelOption" height="230px" />
            <p class="mt-1 text-[11px] text-[#8b93a7]">会员累计赠送 <span class="font-mono text-[#f7c948]">{{ fmtYuan(bonusGrantedTotal) }}</span></p>
          </div>
        </div>

        <!-- 第三排：热力图 + 优惠券 -->
        <div class="mb-3 grid gap-3 xl:grid-cols-3">
          <div v-if="canRegs" class="ck-panel ck-rise p-4 xl:col-span-2" style="animation-delay: 240ms">
            <div class="ck-head">
              <h2>报名时段热力</h2>
              <span class="ck-head-meta">星期 × 小时 · 颜色越暖报名越密集</span>
            </div>
            <CkChart :option="heatmapOption" height="230px" />
          </div>
          <div v-if="canMembers" class="ck-panel ck-rise p-4" style="animation-delay: 280ms">
            <div class="ck-head">
              <h2>优惠券核销</h2>
              <RouterLink to="/coupons" class="ck-link">优惠券 →</RouterLink>
            </div>
            <div class="mb-2 flex items-end justify-between">
              <div>
                <p class="font-mono text-3xl font-semibold text-[#34d399]">{{ couponStats.rate }}<span class="text-base">%</span></p>
                <p class="text-[11px] text-[#8b93a7]">核销率（已使用 / 有效发放）</p>
              </div>
              <div class="text-right">
                <p class="font-mono text-lg text-[#f5a524]">{{ fmtYuan(discountTotal) }}</p>
                <p class="text-[11px] text-[#8b93a7]">期内累计优惠</p>
              </div>
            </div>
            <CkChart :option="couponOption" height="96px" />
            <p class="mt-1 text-[11px] text-[#8b93a7]">期内发放 {{ couponStats.total }} 张 · 已使用 {{ couponStats.USED }} 张</p>
          </div>
        </div>

        <!-- 第四排：退款监控 + 实时动态 -->
        <div class="mb-3 grid gap-3 xl:grid-cols-3">
          <div v-if="canRefunds" class="ck-panel ck-rise p-4 xl:col-span-2" style="animation-delay: 320ms">
            <div class="ck-head">
              <h2>退款监控</h2>
              <RouterLink to="/finance?tab=refunds" class="ck-link">去审核 →</RouterLink>
            </div>
            <div class="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <div class="ck-mini">
                <p class="font-mono text-lg text-[#f5a524]">{{ pendingRefunds.length }}</p>
                <p class="text-[11px] text-[#8b93a7]">待审核 · {{ fmtYuan(pendingAmount) }}</p>
              </div>
              <div class="ck-mini">
                <p class="font-mono text-lg text-[#34d399]">{{ fmtYuan(refundedAmount) }}</p>
                <p class="text-[11px] text-[#8b93a7]">期内已退款</p>
              </div>
              <div class="ck-mini">
                <p class="font-mono text-lg text-[#f43f7a]">{{ rejectedCount }}</p>
                <p class="text-[11px] text-[#8b93a7]">已驳回</p>
              </div>
              <div class="ck-mini">
                <p class="font-mono text-lg text-[#22d3ee]">{{ refundRate }}%</p>
                <p class="text-[11px] text-[#8b93a7]">退款率（金额口径）</p>
              </div>
            </div>
            <ul v-if="recentRefunds.length" class="space-y-1.5">
              <li v-for="r in recentRefunds" :key="r.id"
                class="flex items-center gap-3 rounded-lg border border-[#1e2a45] bg-[#0d1428]/60 px-3 py-2 text-xs transition hover:border-[#2a3550]">
                <span class="font-mono text-slate-200">{{ personLabel(r.requesterNickname, r.requesterWechatId, r.requestedBy, { withWechat: false }) }}</span>
                <span class="truncate text-[#8b93a7]">{{ r.eventTitle ?? '未知场次' }} · {{ r.sessionLabel ?? '—' }}</span>
                <span class="ml-auto shrink-0 font-mono text-slate-200">{{ fmtYuan(r.amountCent) }}</span>
                <span class="shrink-0 rounded-full border px-2 py-0.5 text-[11px]" :class="REFUND_META[r.status]?.cls ?? ''">
                  {{ REFUND_META[r.status]?.label ?? r.status }}
                </span>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-xs text-[#8b93a7]">该时间范围内没有退款单</p>
          </div>

          <div v-if="canRegs" class="ck-panel ck-rise p-4" style="animation-delay: 360ms">
            <div class="ck-head">
              <h2>实时报名动态</h2>
              <span class="ck-head-meta">最新 {{ feed.length }} 条</span>
            </div>
            <ul v-if="feed.length" class="space-y-1.5">
              <li v-for="r in feed" :key="r.id">
                <RouterLink :to="{ path: '/registrations', query: { eventId: r.eventId, title: r.eventTitle ?? undefined } }"
                  class="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/5">
                  <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" :style="{ background: REG_DOT[r.status] ?? '#8b93a7' }" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs text-slate-200">
                      <span class="font-mono">{{ personLabel(r.userNickname, r.userWechatId, r.userId, { withWechat: false }) }}</span>
                      <span class="text-[#8b93a7]"> 报名了 </span>{{ r.eventTitle ?? '未知场次' }}
                    </p>
                    <p class="text-[11px] text-[#8b93a7]">{{ r.sessionLabel ?? '—' }} · {{ relTime(r.createdAt) }}</p>
                  </div>
                  <span class="shrink-0 font-mono text-xs text-[#f5a524]">{{ fmtYuan(r.feeCent) }}</span>
                </RouterLink>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-xs text-[#8b93a7]">该时间范围内没有报名</p>
          </div>
        </div>

        <p class="pb-2 text-[11px] leading-relaxed text-[#5d6577]">
          口径说明：实收 = 已确认且「已收款 / 积分抵扣」的报名实付金额；活跃名额含已确认与已签到；上座率与满员率为当前容量快照；
          退款率 = 已退金额 ÷（实收 + 已退）；环比为上一等长周期对比。数据{{ autoRefresh ? '每 60 秒自动刷新' : '手动刷新' }}，仅本人可见的经营数据，不会展示给前台用户。
        </p>
      </template>
    </div>
  </section>
</template>

<style>
/* 驾驶舱激活时，把页面滚动条也换成仪表配色 */
html:has(.cockpit-root) {
  scrollbar-width: thin;
  scrollbar-color: #2a3550 #0a0f1e;
}
html:has(.cockpit-root)::-webkit-scrollbar { width: 10px; height: 10px; }
html:has(.cockpit-root)::-webkit-scrollbar-track { background: #0a0f1e; }
html:has(.cockpit-root)::-webkit-scrollbar-thumb { background: #2a3550; border-radius: 6px; border: 2px solid #0a0f1e; }
html:has(.cockpit-root)::-webkit-scrollbar-thumb:hover { background: #f5a524; }
</style>
<style src="./cockpit.css" scoped></style>
