<script setup lang="ts">
/**
 * 财务与退款：三个页签都以列表为主，操作按钮在每行末尾；人工调账走弹窗。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { BalanceTransactionDto, RefundOrderDto } from '@photo/shared';
import { balanceAdjustmentSchema, labelOf, pointsToCent, BALANCE_BIZ_TYPES } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { REFUND_STATUS, TXN_DIRECTION, metaOf, personLabel, points, shortTime } from '../utils/labels';
import { emptyPage } from '../utils/loadAll';
import UserPicker from '../components/UserPicker.vue';
import AppPagination from '../components/AppPagination.vue';

const ui = useUiStore();
const session = useSessionStore();
const route = useRoute();

// 概览「待审核退款」直接落到退款页签
const tab = ref(route.query.tab === 'txns' ? 'txns' : 'refunds');
const refunds = ref<RefundOrderDto[]>([]);
const txns = ref<BalanceTransactionDto[]>([]);
const loading = ref(true);

/* ---------------- 服务端分页 ----------------
 * 退款单与积分流水都只增不减，全量拉取迟早撑不住；筛选与分页全部下推服务端。
 * 两个页签各管各的页码，切换页签不会互相串页。
 * 待审核角标用服务端聚合的 pendingTotal，而不是当前页里的 REQUESTED 条数：
 * 分页后当前页可能一条待审核都没有，角标却显示 0，会让人误以为清空了。
 */
const refundPage = ref(1);
const refundPageSize = ref(20);
const refundTotal = ref(0);
/** 全局角标：待审核 / 待线下退款（挂账），由服务端单独聚合 */
const pendingTotal = ref(0);
const unsettledTotal = ref(0);
const refundPageCount = computed(() => Math.max(1, Math.ceil(refundTotal.value / refundPageSize.value)));

const txnPage = ref(1);
const txnPageSize = ref(20);
const txnTotal = ref(0);
const txnPageCount = computed(() => Math.max(1, Math.ceil(txnTotal.value / txnPageSize.value)));

const refundStatus = ref('');
const refundKeyword = ref('');
const txnKeyword = ref('');
const txnBizType = ref('');
/** 时间范围（本地自然日，含首含尾）：两个列表各自独立，对账时按天看 */
const refundDateFrom = ref('');
const refundDateTo = ref('');
const txnDateFrom = ref('');
const txnDateTo = ref('');

/**
 * el-date-picker 的 daterange 只接受单个数组，而筛选逻辑用两个独立 ref。
 * 这里用可写 computed 桥接：读时拼数组、写时拆回两个 ref，避免新增状态导致两处不同步。
 */
const refundDateRange = computed<string[] | null>({
  get: () => (refundDateFrom.value && refundDateTo.value
    ? [refundDateFrom.value, refundDateTo.value]
    : null),
  set: (v: string[] | null) => {
    refundDateFrom.value = v?.[0] ?? '';
    refundDateTo.value = v?.[1] ?? '';
  },
});
const txnDateRange = computed<string[] | null>({
  get: () => (txnDateFrom.value && txnDateTo.value
    ? [txnDateFrom.value, txnDateTo.value]
    : null),
  set: (v: string[] | null) => {
    txnDateFrom.value = v?.[0] ?? '';
    txnDateTo.value = v?.[1] ?? '';
  },
});

/** 列表已是服务端筛选后的结果，模板仍用 visibleRefunds/visibleTxns 这两个名字 */
const visibleRefunds = computed(() => refunds.value);
const visibleTxns = computed(() => txns.value);

async function loadRefunds(): Promise<void> {
  const res = await api.admin.refunds.list({
    page: refundPage.value,
    pageSize: refundPageSize.value,
    ...(refundStatus.value ? { settle: refundStatus.value === 'UNSETTLED' ? 'UNSETTLED' as const : undefined } : {}),
    ...(refundStatus.value && refundStatus.value !== 'UNSETTLED'
      ? { status: refundStatus.value as RefundOrderDto['status'] }
      : {}),
    ...(refundKeyword.value.trim() ? { keyword: refundKeyword.value.trim() } : {}),
    ...(refundDateFrom.value ? { dateFrom: refundDateFrom.value } : {}),
    ...(refundDateTo.value ? { dateTo: refundDateTo.value } : {}),
  }).catch(() => ({ ...emptyPage<RefundOrderDto>(), page: 1, pageSize: refundPageSize.value, pendingTotal: 0, unsettledTotal: 0 }));
  refunds.value = res.list;
  refundTotal.value = res.total;
  pendingTotal.value = res.pendingTotal;
  unsettledTotal.value = res.unsettledTotal;
  // 页码越界（筛选变化后总数变小）时回到最后一页，避免空白页
  if (refundPage.value > refundPageCount.value) { refundPage.value = refundPageCount.value; await loadRefunds(); }
}

async function loadTxns(): Promise<void> {
  const res = await api.admin.balance.transactions({
    page: txnPage.value,
    pageSize: txnPageSize.value,
    ...(txnBizType.value ? { bizType: txnBizType.value as BalanceTransactionDto['bizType'] } : {}),
    ...(txnKeyword.value.trim() ? { keyword: txnKeyword.value.trim() } : {}),
    ...(txnDateFrom.value ? { dateFrom: txnDateFrom.value } : {}),
    ...(txnDateTo.value ? { dateTo: txnDateTo.value } : {}),
  }).catch(() => ({ ...emptyPage<BalanceTransactionDto>(), page: 1, pageSize: txnPageSize.value }));
  txns.value = res.list;
  txnTotal.value = res.total;
  if (txnPage.value > txnPageCount.value) { txnPage.value = txnPageCount.value; await loadTxns(); }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([loadRefunds(), loadTxns()]);
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// 筛选变化回到第 1 页再查
watch([refundStatus, refundKeyword, refundDateFrom, refundDateTo], () => { refundPage.value = 1; void loadRefunds(); });
watch([txnBizType, txnKeyword, txnDateFrom, txnDateTo], () => { txnPage.value = 1; void loadTxns(); });

function goRefundPage(next: number): void {
  const target = Math.min(Math.max(1, next), refundPageCount.value);
  if (target === refundPage.value) return;
  refundPage.value = target;
  void loadRefunds();
}

function goTxnPage(next: number): void {
  const target = Math.min(Math.max(1, next), txnPageCount.value);
  if (target === txnPage.value) return;
  txnPage.value = target;
  void loadTxns();
}

/** 分页组件回调（页码已由组件保证合法） */
function goRefundPageTo(next: number): void {
  if (next === refundPage.value) return;
  refundPage.value = next;
  void loadRefunds();
}

function goTxnPageTo(next: number): void {
  if (next === txnPage.value) return;
  txnPage.value = next;
  void loadTxns();
}

/** 切换每页条数：两处独立，各自回到第 1 页 */
function changeRefundPageSize(size: number): void {
  refundPageSize.value = size;
  refundPage.value = 1;
  void loadRefunds();
}

function changeTxnPageSize(size: number): void {
  txnPageSize.value = size;
  txnPage.value = 1;
  void loadTxns();
}

/* ---------------- 退款审核 ---------------- */
async function review(order: RefundOrderDto, approve: boolean): Promise<void> {
  // 退款渠道由报名支付方式决定，而非会员等级：积分支付才回充，线下支付（含会员线下付款）需线下退款
  const pointsRefund = order.paymentStatus === 'NOT_REQUIRED';
  try {
    await ui.confirm(
      approve
        ? (pointsRefund
          ? `通过退款 ${points(order.amountCent)}？该报名为积分支付，通过后积分立即回充。`
          : `通过退款 ${points(order.amountCent)}？该报名为线下支付，通过后请线下退款，系统不回充积分。`)
        : `驳回该退款申请？报名会回到「已确认」，名额继续保留。`,
      approve ? '确认通过退款' : '确认驳回',
    );
  } catch { return; }
  try {
    await api.admin.refunds.review(order.id, {
      approve,
      remark: approve ? undefined : '后台驳回：不符合退款规则',
    });
    ui.notify(approve ? (pointsRefund ? '退款已回充积分' : '已通过，请线下退款') : '已驳回', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/** 退款方式标识：积分支付回充积分，线下支付需线下退款（不回充） */
function refundChannel(r: RefundOrderDto): { label: string; cls: string } {
  return r.paymentStatus === 'NOT_REQUIRED'
    ? { label: '积分回充', cls: 'text-emerald-600' }
    : { label: '线下退款', cls: 'text-amber-600' };
}

/**
 * 资金落定状态（对账口径）：
 *  · 会员回充在审核通过时由服务端自动写入 settledAt，无需人工登记；
 *  · 非会员线下退款审核通过后 settledAt 仍为空，说明钱还没退出去，列表里要显式标出来，
 *    运营实际转账后点「登记已处理」补记经办人与时间。
 */
function settleStateOf(r: RefundOrderDto): { label: string; cls: string } | null {
  if (r.status !== 'REFUNDED') return null;
  return r.settledAt
    ? { label: '资金已落定', cls: 'text-emerald-600' }
    : { label: '待线下退款', cls: 'text-rose-600' };
}

/** 已批准但线下尚未退款的单子才需要人工登记 */
function needSettle(r: RefundOrderDto): boolean {
  return r.status === 'REFUNDED' && !r.settledAt;
}

const settling = ref('');
async function settle(order: RefundOrderDto): Promise<void> {
  try {
    await ui.confirm(
      `确认已向「${personLabel(order.requesterNickname, order.requesterWechatId, order.requestedBy)}」线下退款 ${points(order.amountCent)}？登记后计入资金落定，仅用于对账留痕。`,
      '登记线下退款完成',
    );
  } catch { return; }
  settling.value = order.id;
  try {
    await api.admin.refunds.settle(order.id, { remark: '后台登记：线下已退款' });
    ui.notify('已登记线下退款完成', 'success');
    await load();
  } catch {
    // 统一错误提示
  } finally {
    settling.value = '';
  }
}

/* ---------------- 人工调账（一步入账） ---------------- */
const adjustOpen = ref(false);
const adjusting = ref(false);
const adjust = reactive({ wechatId: '', amountPoints: 0, bonusPoints: 0, reason: '' });

function openAdjust(): void {
  adjust.wechatId = '';
  adjust.amountPoints = 0;
  adjust.bonusPoints = 0;
  adjust.reason = '';
  adjustOpen.value = true;
}

async function submitAdjust(): Promise<void> {
  const parsed = balanceAdjustmentSchema.safeParse({
    wechatId: adjust.wechatId.trim(),
    amountCent: pointsToCent(adjust.amountPoints),
    bonusCent: adjust.bonusPoints > 0 ? pointsToCent(adjust.bonusPoints) : undefined,
    reason: adjust.reason.trim(),
  });
  if (!parsed.success) { ui.notify(parsed.error.issues[0]?.message ?? '表单校验未通过', 'warning'); return; }
  adjusting.value = true;
  try {
    await api.admin.balance.adjust(parsed.data);
    ui.notify('调账已入账', 'success');
    adjustOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    adjusting.value = false;
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">积分与权益</h1>
        <p class="mt-1 text-sm text-slate-500">积分为站内权益记录，不可购买、不可转让、不可兑现；所有变更落流水，不可直接改账户。</p>
      </div>
      <div class="flex gap-2">
        <el-button v-if="session.can('admin:balance:adjust:request')" type="primary" @click="openAdjust">发起调账</el-button>
      </div>
    </div>

    <el-tabs v-model="tab">
      <!-- 取消登记审核 -->
      <el-tab-pane name="refunds">
        <template #label>
          取消审核<span v-if="pendingTotal" class="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-700">{{ pendingTotal }}</span>
        </template>
        <el-form inline class="mb-3 rounded-xl border border-slate-200 bg-white p-3">
          <el-form-item label="状态">
            <el-select v-model="refundStatus" placeholder="全部状态" clearable class="!w-44">
              <el-option label="待审核" value="REQUESTED" />
              <el-option label="待线下确认" value="UNSETTLED" />
              <el-option label="已通过" value="APPROVED" />
              <el-option label="已驳回" value="REJECTED" />
            </el-select>
          </el-form-item>
          <el-form-item label="关键词">
            <el-input v-model="refundKeyword" placeholder="搜索微信号 / 场次 / 报名编号"
              clearable class="!w-64" />
          </el-form-item>
          <!-- 申请时间范围：按本地自然日（含首含尾） -->
          <el-form-item label="申请时间">
            <el-date-picker v-model="refundDateRange" type="daterange" unlink-panels
              range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
              format="YYYY-MM-DD" value-format="YYYY-MM-DD" class="!w-64" />
          </el-form-item>
          <el-form-item>
            <span class="text-xs text-slate-500">共 {{ refundTotal }} 条</span>
          </el-form-item>
        </el-form>
        <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table class="hidden w-full text-left text-sm md:table">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2.5 font-medium">申请单</th>
                <th class="px-3 py-2.5 font-medium">申请人</th>
                <th class="px-3 py-2.5 font-medium">场次 / 报名</th>
                <th class="px-3 py-2.5 font-medium">积分</th>
                <th class="px-3 py-2.5 font-medium">申请时间</th>
                <th class="px-3 py-2.5 font-medium">状态</th>
                <th class="px-3 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in visibleRefunds" :key="r.id" class="border-t border-slate-100 hover:bg-slate-50/60">
                <td class="px-3 py-2.5 font-medium text-slate-900">#{{ r.id }}</td>
                <td class="px-3 py-2.5">
                  <p class="text-slate-800">{{ personLabel(r.requesterNickname, r.requesterWechatId, r.requestedBy, { withWechat: false }) }}</p>
                  <p class="text-xs text-slate-500">{{ r.requesterWechatId ? `微信号 ${r.requesterWechatId}` : `用户 #${r.requestedBy}` }}</p>
                </td>
                <td class="px-3 py-2.5">
                  <p class="text-slate-800">{{ r.eventTitle ?? (r.eventId ? `场次 #${r.eventId}` : '场次未知') }}</p>
                  <p class="text-xs text-slate-500">
                    {{ r.sessionLabel ?? '时段未知' }}<template v-if="r.sessionStartAt"> · {{ shortTime(r.sessionStartAt) }}</template>
                    · 报名 #{{ r.registrationId }}
                  </p>
                </td>
                <td class="px-3 py-2.5 font-medium text-slate-900">
                  {{ points(r.amountCent) }}
                  <p class="text-xs font-normal" :class="refundChannel(r).cls">{{ refundChannel(r).label }}</p>
                </td>
                <td class="px-3 py-2.5 text-xs text-slate-500">{{ shortTime(r.createdAt) }}</td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(REFUND_STATUS, r.status).cls">
                    {{ metaOf(REFUND_STATUS, r.status).label }}
                  </span>
                  <!-- 对账口径：已通过但资金未落定的线下退款要显式标出来 -->
                  <p v-if="settleStateOf(r)" class="mt-1 text-xs" :class="settleStateOf(r)!.cls">{{ settleStateOf(r)!.label }}</p>
                </td>
                <td class="px-3 py-2.5 text-right whitespace-nowrap">
                  <template v-if="r.status === 'REQUESTED'">
                    <el-button size="small" type="primary" @click="review(r, true)">通过</el-button>
                    <el-button size="small" text type="danger" @click="review(r, false)">驳回</el-button>
                  </template>
                  <el-button v-else-if="needSettle(r)" size="small" :loading="settling === r.id" @click="settle(r)">
                    登记已处理
                  </el-button>
                  <span v-else class="text-xs text-slate-300">—</span>
                </td>
              </tr>
              <tr v-if="!loading && !visibleRefunds.length">
                <td colspan="7" class="px-3 py-14 text-center">
                  <p class="text-sm text-slate-600">{{ refunds.length ? '没有符合筛选条件的申请单' : '没有取消申请' }}</p>
                  <p class="mt-1 text-xs text-slate-500">取消已登记的记录后自动生成申请单：审核通过后积分回充账户</p>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="divide-y divide-slate-100 md:hidden">
            <div v-for="r in visibleRefunds" :key="r.id" class="p-3">
              <div class="flex items-start justify-between">
                <div>
                  <p class="font-medium text-slate-900">#{{ r.id }} · {{ points(r.amountCent) }} <span class="text-xs font-normal" :class="refundChannel(r).cls">{{ refundChannel(r).label }}</span></p>
                  <p class="mt-0.5 text-xs text-slate-500">{{ r.eventTitle ?? '场次未知' }} · {{ r.sessionLabel ?? '时段未知' }}</p>
                  <p class="mt-0.5 text-xs text-slate-500">报名 #{{ r.registrationId }} · {{ shortTime(r.createdAt) }}</p>
                </div>
                <span class="rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(REFUND_STATUS, r.status).cls">{{ metaOf(REFUND_STATUS, r.status).label }}</span>
              </div>
              <p v-if="settleStateOf(r)" class="mt-1 text-xs" :class="settleStateOf(r)!.cls">{{ settleStateOf(r)!.label }}</p>
              <div v-if="r.status === 'REQUESTED'" class="mt-2 flex gap-2">
                <el-button size="small" type="primary" @click="review(r, true)">通过</el-button>
                <el-button size="small" text type="danger" @click="review(r, false)">驳回</el-button>
              </div>
              <div v-else-if="needSettle(r)" class="mt-2">
                <el-button size="small" :loading="settling === r.id" @click="settle(r)">登记已处理</el-button>
              </div>
            </div>
          </div>

          <AppPagination
            :page="refundPage"
            :page-size="refundPageSize"
            :total="refundTotal"
            :hide-on-single-page="true"
            :summary="`共 ${refundTotal} 条`"
            @change="(p) => goRefundPageTo(p)"
            @size-change="(s) => changeRefundPageSize(s)"
          />
        </div>
      </el-tab-pane>

      <!-- 积分流水 -->
      <el-tab-pane label="积分流水" name="txns">
        <el-form inline class="mb-3 rounded-xl border border-slate-200 bg-white p-3">
          <el-form-item label="业务">
            <el-select v-model="txnBizType" placeholder="全部业务" clearable class="!w-40">
              <el-option v-for="b in BALANCE_BIZ_TYPES" :key="b" :label="labelOf(b)" :value="b" />
            </el-select>
          </el-form-item>
          <el-form-item label="关键词">
            <el-input v-model="txnKeyword" placeholder="搜索微信号 / 业务类型" clearable class="!w-64" />
          </el-form-item>
          <!-- 流水时间范围：按本地自然日（含首含尾） -->
          <el-form-item label="流水时间">
            <el-date-picker v-model="txnDateRange" type="daterange" unlink-panels
              range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
              format="YYYY-MM-DD" value-format="YYYY-MM-DD" class="!w-64" />
          </el-form-item>
          <el-form-item>
            <span class="text-xs text-slate-500">共 {{ txnTotal }} 条</span>
          </el-form-item>
        </el-form>
        <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table class="hidden w-full text-left text-sm md:table">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2.5 font-medium">流水</th>
                <th class="px-3 py-2.5 font-medium">用户</th>
                <th class="px-3 py-2.5 font-medium">业务</th>
                <th class="px-3 py-2.5 font-medium">方向</th>
                <th class="px-3 py-2.5 font-medium">积分</th>
                <th class="px-3 py-2.5 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in visibleTxns" :key="t.id" class="border-t border-slate-100">
                <td class="px-3 py-2.5 text-slate-500">#{{ t.id }}</td>
                <td class="px-3 py-2.5">
                  <p class="font-medium text-slate-800">{{ personLabel(t.accountNickname, t.accountWechatId, t.accountUserId, { withWechat: false }) }}</p>
                  <p class="text-xs text-slate-500">{{ t.accountWechatId ? `微信号 ${t.accountWechatId}` : `用户 #${t.accountUserId}` }}</p>
                </td>
                <td class="px-3 py-2.5 text-slate-600">{{ labelOf(t.bizType) }}</td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(TXN_DIRECTION, t.direction).cls">
                    {{ metaOf(TXN_DIRECTION, t.direction).label }}
                  </span>
                </td>
                <td class="px-3 py-2.5 font-medium" :class="t.direction === 'IN' || t.direction === 'UNFREEZE' ? 'text-emerald-600' : 'text-slate-900'">
                  {{ points(t.amountCent) }}
                </td>
                <td class="px-3 py-2.5 text-xs text-slate-500">{{ shortTime(t.createdAt) }}</td>
              </tr>
              <tr v-if="!loading && !visibleTxns.length">
                <td colspan="6" class="px-3 py-14 text-center text-sm text-slate-500">{{ txns.length ? '没有符合筛选条件的流水' : '暂无流水' }}</td>
              </tr>
            </tbody>
          </table>

          <div class="divide-y divide-slate-100 md:hidden">
            <div v-for="t in visibleTxns" :key="t.id" class="flex items-center justify-between p-3">
              <div>
                <p class="text-sm text-slate-800">{{ labelOf(t.bizType) }}</p>
                <p class="text-xs text-slate-500">{{ personLabel(t.accountNickname, t.accountWechatId, t.accountUserId) }} · {{ shortTime(t.createdAt) }}</p>
              </div>
              <span class="text-sm font-medium" :class="t.direction === 'IN' || t.direction === 'UNFREEZE' ? 'text-emerald-600' : 'text-slate-900'">
                {{ points(t.amountCent) }}
              </span>
            </div>
          </div>

          <AppPagination
            :page="txnPage"
            :page-size="txnPageSize"
            :total="txnTotal"
            :hide-on-single-page="true"
            :summary="`共 ${txnTotal} 条`"
            @change="(p) => goTxnPageTo(p)"
            @size-change="(s) => changeTxnPageSize(s)"
          />
        </div>
        <p class="mt-2 text-xs text-slate-500">
          方向说明：入账＝充值/发放增加可用积分；冻结（预扣）＝报名时先占用可用积分；解冻（退回）＝取消报名后退回可用积分；扣款（结算）＝活动结束正式出账。数值恒为正数，方向由标签表示。
        </p>
        <p class="mt-1 text-xs text-slate-500">流水 append-only；账户积分为物化值，需定期按流水重算对账。</p>
      </el-tab-pane>
    </el-tabs>

    <!-- 发起调账（一步入账） -->
    <el-dialog v-model="adjustOpen" title="积分调账" width="min(520px, 94vw)" destroy-on-close>
      <el-form label-width="96px" label-position="left">
        <el-form-item label="微信号" required>
          <div class="w-full">
            <UserPicker v-model="adjust.wechatId" placeholder="搜索并选择微信号或昵称" />
            <span class="mt-1 block text-xs text-slate-500">仅可选已注册用户；未注册请先在「用户管理」新增。</span>
          </div>
        </el-form-item>
        <el-form-item label="积分" required>
          <div class="w-full">
            <el-input-number v-model="adjust.amountPoints" :step="1" :precision="2"
              controls-position="right" class="!w-full" placeholder="正数发放 / 负数扣减" />
            <span class="mt-1 block text-xs text-slate-500">正数为发放、负数为扣减，不能为 0。</span>
          </div>
        </el-form-item>
        <el-form-item label="赠送积分">
          <div class="w-full">
            <el-input-number v-model="adjust.bonusPoints" :min="0" :step="1" :precision="2"
              controls-position="right" class="!w-full" placeholder="选填" />
            <span class="mt-1 block text-xs text-slate-500">仅发放（正数）时可填；与发放额一起计入可用积分。</span>
          </div>
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="adjust.reason" placeholder="至少 2 个字，会写入审计日志" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false"
        title="提交后立即入账并记一笔积分流水，动作写入审计日志（BALANCE_ADJUST），不可撤销；仅会员有积分账户。积分可由运营发放，也可按线下收款登记充值。" />
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="adjustOpen = false">取消</el-button>
          <el-button type="primary" :loading="adjusting" @click="submitAdjust">确认入账</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
