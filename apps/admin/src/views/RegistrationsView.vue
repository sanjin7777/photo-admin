<script setup lang="ts">
/**
 * 报名管理：列表为主，所有操作按钮都在对应行末尾。
 * 手动录入与自助登记同口径：按等级取价、可用优惠券、可选扣积分；结算方式由运营指定。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type {
  AdminCouponDto, AdminManualSettleMode, AdminRegistrationLookupDto, AdminUserOptionDto,
  EventDto, MemberLevel, RegistrationDto, SessionAvoidRuleDto,
} from '@photo/shared';
import {
  ADMIN_MANUAL_SETTLE_META, adminRegistrationCreateSchema, couponDiscountOf,
} from '@photo/shared';
import { api } from '../api';
import UserPicker from '../components/UserPicker.vue';
import { useUiStore } from '../stores/ui';
import { EVENT_STATUS, MEMBER_LEVEL, PAYMENT_STATUS, REGISTRATION_SOURCE, REGISTRATION_STATUS, metaOf, shortTime, points } from '../utils/labels';
import { loadAllPages } from '../utils/loadAll';
import AppPagination from '../components/AppPagination.vue';

const ui = useUiStore();
const route = useRoute();
const router = useRouter();
const list = ref<RegistrationDto[]>([]);
const loading = ref(true);
const keyword = ref('');
const statusFilter = ref('');
const paymentFilter = ref('');
const sessionFilter = ref('');
/** 报名时间范围（本地自然日，含首含尾）：财务对账与月度复盘按天看，不必导出 CSV 再筛 */
const dateFrom = ref('');
const dateTo = ref('');
/**
 * el-date-picker 的 daterange 只接受单个数组，而筛选逻辑与 SQL 条件用两个独立 ref。
 * 用可写 computed 桥接，避免新增状态后两处不同步。
 */
const dateRange = computed<string[] | null>({
  get: () => (dateFrom.value && dateTo.value ? [dateFrom.value, dateTo.value] : null),
  set: (v: string[] | null) => {
    dateFrom.value = v?.[0] ?? '';
    dateTo.value = v?.[1] ?? '';
  },
});

/* ---------------- 服务端分页 ----------------
 * 报名表只增不减，全量拉取迟早撑不住；筛选与分页全部下推服务端。
 * 切换筛选条件要回到第 1 页，否则会停在一个不存在的页码上。
 */
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
/** 全局待收款数：由服务端单独聚合，不受当前页/筛选影响 */
const unpaidTotal = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

function queryValue(key: string): string {
  const raw = route.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? String(value) : '';
}
// 概览「待收款」等入口可以直接带筛选进来
statusFilter.value = queryValue('status');
paymentFilter.value = queryValue('pay');
sessionFilter.value = queryValue('sessionId');
dateFrom.value = queryValue('dateFrom');
dateTo.value = queryValue('dateTo');

/**
 * 从场次管理进入时带了 eventId → 只加载该场次的报名。
 * 顶部显示当前场次名，并提供「查看全部」回到全量列表。
 */
const eventId = computed(() => queryValue('eventId'));
const eventTitle = computed(() => queryValue('title'));
const scoped = computed(() => Boolean(eventId.value));
/** 当前场次的完整时段（含容量），用于时段占用条 */
const scopedEvent = ref<EventDto | null>(null);

/** 列表已经是服务端筛选后的结果，模板直接用 list（保留 filtered 别名以免破坏既有模板断言） */
const filtered = computed(() => list.value);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.admin.registrations.list({
      page: page.value,
      pageSize: pageSize.value,
      ...(eventId.value ? { eventId: eventId.value } : {}),
      // 点击时段占用条只看该时段：同样下推服务端，前端只过滤当前页会漏
      ...(sessionFilter.value ? { sessionId: sessionFilter.value } : {}),
      ...(statusFilter.value ? { status: statusFilter.value as RegistrationDto['status'] } : {}),
      ...(paymentFilter.value ? { paymentStatus: paymentFilter.value as RegistrationDto['paymentStatus'] } : {}),
      ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
      ...(dateFrom.value ? { dateFrom: dateFrom.value } : {}),
      ...(dateTo.value ? { dateTo: dateTo.value } : {}),
    });
    list.value = res.list;
    total.value = res.total;
    unpaidTotal.value = res.unpaidTotal;
    // 页码越界（删除/筛选变化后总数变小）时回到最后一页，避免空白页
    if (page.value > pageCount.value) { page.value = pageCount.value; await load(); return; }
    if (eventId.value) {
      // 录入/取消/收款后时段余量会变，这里强制重拉场次，避免占用条显示旧数据
      await ensureEvents(true);
      scopedEvent.value = manualEvents.value.find((e) => e.id === eventId.value) ?? null;
    } else {
      scopedEvent.value = null;
    }
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(eventId, () => { page.value = 1; void load(); });
// 筛选条件变化一律回到第 1 页再查
watch([keyword, statusFilter, paymentFilter, sessionFilter, dateFrom, dateTo], () => { page.value = 1; void load(); });
watch(
  () => [route.query.status, route.query.pay, route.query.sessionId, route.query.dateFrom, route.query.dateTo],
  () => {
    statusFilter.value = queryValue('status');
    paymentFilter.value = queryValue('pay');
    sessionFilter.value = queryValue('sessionId');
    dateFrom.value = queryValue('dateFrom');
    dateTo.value = queryValue('dateTo');
  },
);

function goPage(next: number): void {
  const target = Math.min(Math.max(1, next), pageCount.value);
  if (target === page.value) return;
  page.value = target;
  void load();
}

/** 分页组件回调：已由组件保证页码合法，直接跳转 */
function goPageTo(next: number): void {
  if (next === page.value) return;
  page.value = next;
  void load();
}

/** 切换每页条数：回到第 1 页，避免页码越界 */
function changePageSize(size: number): void {
  pageSize.value = size;
  page.value = 1;
  void load();
}

/** 取消场次筛选，回到全量报名列表 */
function clearScope(): void {
  sessionFilter.value = '';
  void router.push({ path: '/registrations' });
  void load();
}

function resetFilters(): void {
  keyword.value = '';
  statusFilter.value = '';
  paymentFilter.value = '';
  sessionFilter.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  selected.value = [];
}

// 候补已下线：不再产生 WAITLISTED 行，但历史存量行仍允许取消（走取消流程收尾）
const canCancel = (r: RegistrationDto) => r.status === 'CONFIRMED' || r.status === 'WAITLISTED';
const canCheckIn = (r: RegistrationDto) => r.status === 'CONFIRMED';
const canConfirmPay = (r: RegistrationDto) => r.paymentStatus === 'UNPAID';

async function act(r: RegistrationDto, action: 'CANCEL' | 'CHECK_IN'): Promise<void> {
  if (action === 'CANCEL') {
    // 退款渠道由支付方式决定：积分支付（NOT_REQUIRED）审核通过回充积分；线下支付审核通过后线下退款，不回充
    const refundHint = r.paymentStatus === 'NOT_REQUIRED'
      ? '将生成退款单，审核通过后积分自动回充。'
      : '将生成退款单，该报名为线下支付，审核通过后需线下退款，不回充积分。';
    try {
      await ui.confirm(`取消「${r.userWechatId ?? r.userId}」在「${r.event?.title ?? '该场次'}」的报名？${refundHint}`);
    } catch { return; }
  }
  try {
    await api.admin.registrations.act(r.id, { action, reason: `后台操作 ${action}` });
    ui.notify('操作成功', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

async function confirmPay(r: RegistrationDto): Promise<void> {
  try {
    await api.admin.registrations.confirmPayment(r.id);
    ui.notify('已确认到场', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/* ---------------- 批量操作（现场签到 / 确认收款） ----------------
 * 活动当天 20 个人排队，逐条点要等 20 次请求 + 20 次整页重载。
 * 勾选后一次提交，服务端逐条校验状态机、部分成功：成功的移除、跳过的原样保留。
 */
const selected = ref<string[]>([]);
const batchBusy = ref(false);

const selectedRows = computed(() => list.value.filter((r) => selected.value.includes(r.id)));
const batchCheckInIds = computed(() => selectedRows.value.filter(canCheckIn).map((r) => r.id));
const batchPayIds = computed(() => selectedRows.value.filter(canConfirmPay).map((r) => r.id));
const allChecked = computed(() => list.value.length > 0 && selected.value.length === list.value.length);

function toggleAll(checked: boolean): void {
  selected.value = checked ? list.value.map((r) => r.id) : [];
}

async function runBatch(action: 'CHECK_IN' | 'CONFIRM_PAYMENT'): Promise<void> {
  const ids = action === 'CHECK_IN' ? batchCheckInIds.value : batchPayIds.value;
  if (!ids.length) {
    ui.notify(action === 'CHECK_IN' ? '所选报名中没有可签到的' : '所选报名中没有待收款的', 'warning');
    return;
  }
  const label = action === 'CHECK_IN' ? '签到' : '确认收款';
  try {
    await ui.confirm(`确定对选中的 ${ids.length} 条报名执行「${label}」？`);
  } catch { return; }
  batchBusy.value = true;
  try {
    const res = await api.admin.registrations.batch({ action, ids });
    const skipped = res.skipped.length;
    ui.notify(
      skipped ? `已${label} ${res.succeeded.length} 条，跳过 ${skipped} 条（${res.skipped[0]?.reason ?? ''}）` : `已${label} ${res.succeeded.length} 条`,
      skipped ? 'warning' : 'success',
    );
    selected.value = res.skipped.map((s) => s.id);
    await load();
  } catch {
    // 统一错误提示
  } finally {
    batchBusy.value = false;
  }
}

/* ---------------- 手动录入（线下报名 / 补录） ---------------- */
const manualOpen = ref(false);
const manualSaving = ref(false);
const manualEvents = ref<EventDto[]>([]);
const manualForm = reactive({
  eventId: '',
  sessionId: '',
  wechatId: '',
  seats: 1,
  settleMode: 'OFFLINE_UNPAID' as AdminManualSettleMode,
  couponIds: [] as string[],
  /** 到场状态：现场已签到直接记 CHECKED_IN */
  arriveStatus: 'CONFIRMED' as 'CONFIRMED' | 'CHECKED_IN',
  reason: '',
});
const lookup = ref<AdminRegistrationLookupDto | null>(null);
const lookupError = ref('');
/** 该账号当前可用的优惠券（UNUSED）：线下收款同样允许使用 */
const userCoupons = ref<AdminCouponDto[]>([]);

const selectedEvent = computed(() => manualEvents.value.find((e) => e.id === manualForm.eventId) ?? null);

/** 按账号等级取价；与服务端同一规则（SVIP→VIP→PUBLIC，VIP→PUBLIC），仅用于录前预览 */
function priceForLevel(prices: EventDto['prices'], level: MemberLevel): number {
  const of = (lv: string) => prices.find((p) => p.level === lv)?.priceCent;
  if (level === 'SVIP') return of('SVIP') ?? of('VIP') ?? of('PUBLIC') ?? 0;
  if (level === 'VIP') return of('VIP') ?? of('PUBLIC') ?? 0;
  return of('PUBLIC') ?? 0;
}

/** 单席价格（按当前账号等级） */
const manualUnitFee = computed(() => {
  if (!lookup.value || !selectedEvent.value) return null;
  return priceForLevel(selectedEvent.value.prices, lookup.value.level);
});

/** 与自助登记一致：每名额一张券，按选择顺序套到名额上，其余名额按原价 */
const manualCouponDiscounts = computed<number[]>(() => {
  const unit = manualUnitFee.value;
  const seats = manualForm.seats;
  const out = new Array<number>(seats).fill(0);
  if (unit == null) return out;
  manualForm.couponIds.forEach((id, i) => {
    if (i >= seats) return;
    const c = userCoupons.value.find((x) => x.id === id);
    if (!c) return;
    out[i] = couponDiscountOf({
      type: c.type,
      discountBp: c.discountBp ?? null,
      amountCent: c.amountCent ?? null,
      maxDiscountCent: c.maxDiscountCent ?? null,
    }, unit);
  });
  return out;
});

const manualGross = computed(() => (manualUnitFee.value ?? 0) * manualForm.seats);
const manualDiscount = computed(() => {
  if (manualForm.settleMode === 'FREE') return manualGross.value;
  return manualCouponDiscounts.value.reduce((s, d) => s + d, 0);
});
const manualPayable = computed(() => Math.max(0, manualGross.value - manualDiscount.value));

/** 扣积分模式下余额是否够；余额未知（还没查到）时不误判，交给服务端兜底 */
const manualBalanceGap = computed(() => {
  if (manualForm.settleMode !== 'CREDIT') return 0;
  const available = lookup.value?.availableCent;
  if (available == null) return 0;
  return Math.max(0, manualPayable.value - available);
});
const canCredit = computed(() => {
  const lv = lookup.value?.level;
  return lv === 'VIP' || lv === 'SVIP';
});
/** 余额是否已知：未知时不要把「无积分账户」这种结论显示出来 */
const balanceKnown = computed(() => lookup.value?.availableCent != null);

/**
 * 重复报名提示。
 *
 * 列表已改服务端分页，不能再用 list.value 里找——当前页可能根本不含这条记录。
 * 改为按「微信号 + 时段」单独查一次（服务端已支持 keyword/sessionId 下推）。
 */
const manualDuplicate = ref<RegistrationDto | null>(null);

async function checkManualDuplicate(): Promise<void> {
  manualDuplicate.value = null;
  const wechatId = lookup.value?.wechatId;
  const sessionId = manualForm.sessionId;
  if (!wechatId || !sessionId) return;
  try {
    const res = await api.admin.registrations.list({ page: 1, pageSize: 20, sessionId, keyword: wechatId });
    manualDuplicate.value = res.list.find(
      (r) => r.userWechatId === wechatId
        && r.sessionId === sessionId
        // 历史 WAITLISTED/OFFERED 行仍可能占着名额，重复录入同样要拦住
        && ['WAITLISTED', 'OFFERED', 'CONFIRMED', 'CHECKED_IN'].includes(r.status),
    ) ?? null;
  } catch {
    // 查重失败不阻断录入，服务端仍有容量与状态校验
  }
}

/** 拉取该账号的可用券：线下收款也能用券，所以不按结算方式过滤 */
async function loadUserCoupons(): Promise<void> {
  userCoupons.value = [];
  const wechatId = lookup.value?.wechatId;
  if (!wechatId) return;
  try {
    const res = await api.admin.coupons.list({ page: 1, pageSize: 50, status: 'UNUSED', keyword: wechatId });
    userCoupons.value = res.list.filter((c) => c.userWechatId === wechatId);
  } catch {
    // 拉券失败只是少一个选项，不阻断录入
  }
}

function eventSelectable(e: EventDto): boolean {
  return e.status !== 'DRAFT' && e.status !== 'CANCELLED';
}

function sessionSelectable(s: EventDto['sessions'][number]): boolean {
  // 代拍不限人数：只看是否结束，不看余量
  if (s.kind === 'PROXY') return s.status === 'OPEN' && Date.parse(s.endAt) > Date.now();
  return s.status === 'OPEN'
    && Date.parse(s.endAt) > Date.now()
    && s.capacityUsed < s.capacity;
}

async function openManual(): Promise<void> {
  manualForm.eventId = eventId.value;
  manualForm.sessionId = '';
  manualForm.wechatId = '';
  manualForm.seats = 1;
  manualForm.settleMode = 'OFFLINE_UNPAID';
  manualForm.couponIds = [];
  manualForm.arriveStatus = 'CONFIRMED';
  manualForm.reason = '';
  lookup.value = null;
  lookupError.value = '';
  userCoupons.value = [];
  manualDuplicate.value = null;
  manualOpen.value = true;
  // 前台也可能刚产生报名，打开弹窗时重拉一次，保证时段「余 N」准确
  await ensureEvents(true);
}

/** 场次下拉与时段占用条共用的全量场次缓存；force 用于报名变动后刷新余量 */
async function ensureEvents(force = false): Promise<void> {
  if (!force && manualEvents.value.length) return;
  try {
    const res = await loadAllPages((page, pageSize) => api.admin.events.list({ page, pageSize }));
    manualEvents.value = res.list;
  } catch {
    // 列表接口失败时下拉为空，重开弹窗可重试
  }
}

watch(
  () => manualForm.eventId,
  () => { manualForm.sessionId = ''; manualDuplicate.value = null; },
);

/** 名额变少时把多出来的券丢掉，否则会一直带着不可见的券提交 */
watch(
  () => manualForm.seats,
  (n) => { if (manualForm.couponIds.length > n) manualForm.couponIds = manualForm.couponIds.slice(0, n); },
);

/** 切到「扣积分」时若账号不是会员，自动退回线下收款，避免提交后才报错 */
watch(
  () => manualForm.settleMode,
  (mode) => { if (mode === 'CREDIT' && lookup.value && !canCredit.value) manualForm.settleMode = 'OFFLINE_UNPAID'; },
);

/** 下拉选中即完成账号校验：选项自带等级与冻结状态 */
function onPickUser(options: AdminUserOptionDto[]): void {
  lookup.value = options[0] ?? null;
  lookupError.value = lookup.value && lookup.value.status !== 'ACTIVE' ? '该账号已冻结，不能录入报名' : '';
  manualForm.couponIds = [];
  void loadUserCoupons();
  void checkManualDuplicate();
  // 选人列表只是索引，余额以 lookup 接口为准（下拉字段可能滞后或缺省）
  void refreshLookup();
}

/** 拉一次权威的账号信息（等级 + 可用积分），失败时保留下拉里的数据 */
async function refreshLookup(): Promise<void> {
  const wechatId = manualForm.wechatId.trim();
  if (!wechatId) return;
  try {
    const fresh = await api.admin.registrations.lookup(wechatId);
    // 期间用户又换了账号，丢弃这次结果
    if (manualForm.wechatId.trim() !== fresh.wechatId) return;
    lookup.value = fresh;
    lookupError.value = fresh.status !== 'ACTIVE' ? '该账号已冻结，不能录入报名' : '';
  } catch {
    // 查不到就让服务端在提交时报错，不阻断弹窗
  }
}

// 选好时段后也要查一次重复，否则只有换人时才提示
watch(() => manualForm.sessionId, () => { void checkManualDuplicate(); });

async function submitManual(): Promise<void> {
  if (!lookup.value || lookup.value.wechatId !== manualForm.wechatId) {
    ui.notify('请先选择报名账号', 'warning');
    return;
  }
  if (lookup.value.status !== 'ACTIVE') {
    ui.notify('该账号已冻结，不能录入报名', 'warning');
    return;
  }
  if (manualForm.settleMode === 'CREDIT' && !canCredit.value) {
    ui.notify('该账号不是 VIP/SVIP，无法扣积分', 'warning');
    return;
  }
  if (manualBalanceGap.value > 0) {
    ui.notify(`可用积分不足，还差 ${points(manualBalanceGap.value)}`, 'warning');
    return;
  }
  const parsed = adminRegistrationCreateSchema.safeParse({
    wechatId: manualForm.wechatId.trim(),
    eventId: manualForm.eventId,
    sessionId: manualForm.sessionId,
    seats: manualForm.seats,
    settleMode: manualForm.settleMode,
    couponIds: manualForm.couponIds,
    arriveStatus: manualForm.arriveStatus,
    ...(manualForm.reason.trim() ? { reason: manualForm.reason.trim() } : {}),
  });
  if (!parsed.success) {
    ui.notify(parsed.error.issues[0]?.message ?? '请补全报名信息', 'warning');
    return;
  }
  if (manualDuplicate.value) {
    try {
      await ui.confirm(
        `「${lookup.value.wechatId}」在该时段已有报名 #${manualDuplicate.value.id}，确定再录入一条？`,
        '重复报名确认',
      );
    } catch { return; }
  }
  manualSaving.value = true;
  try {
    const res = await api.admin.registrations.create(parsed.data);
    const ids = res.registrations.map((r) => `#${r.id}`).join('、');
    ui.notify(`已录入 ${res.seats} 个名额（${ids}），共 ${points(manualPayable.value)}`, 'success');
    // 命中时段回避名单时服务端会回传警告：录入照做，但要让运营知道
    if (res.warnings?.length) {
      await ui.confirm(res.warnings.join('\n'), '请注意').catch(() => undefined);
    }
    manualOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    manualSaving.value = false;
  }
}

/* ---------------- 时段级回避名单（SVIP 择邻，仅运营可配） ----------------
 * 语义：某位会员（通常是已报名的 SVIP）不希望与某个具体的人**同处一个时段**。
 * 不是全局黑名单——被回避的人换一个时段照常可以报名。
 * 会员不直接操作（不向会员暴露会员目录），由运营代配。
 */
const avoidOpen = ref(false);
const avoidEventId = ref('');
const avoidSessionId = ref('');
const avoidRules = ref<SessionAvoidRuleDto[]>([]);
const avoidLoading = ref(false);
const avoidSaving = ref(false);
const avoidBlocked = ref<AdminUserOptionDto | null>(null);
const avoidOwner = ref<AdminUserOptionDto | null>(null);
const avoidBlockedWechat = ref('');
const avoidOwnerWechat = ref('');

const avoidEvent = computed(() => manualEvents.value.find((e) => e.id === avoidEventId.value) ?? null);

async function openAvoid(): Promise<void> {
  avoidEventId.value = eventId.value;
  avoidSessionId.value = '';
  avoidRules.value = [];
  avoidBlocked.value = null;
  avoidOwner.value = null;
  avoidBlockedWechat.value = '';
  avoidOwnerWechat.value = '';
  avoidOpen.value = true;
  await ensureEvents(true);
}

async function loadAvoidRules(): Promise<void> {
  avoidRules.value = [];
  if (!avoidSessionId.value) return;
  avoidLoading.value = true;
  try {
    avoidRules.value = await api.admin.registrations.avoidRules.list(avoidSessionId.value);
  } catch {
    // 失败就空列表，重开弹窗可重试
  } finally {
    avoidLoading.value = false;
  }
}

watch(() => avoidEventId.value, () => { avoidSessionId.value = ''; avoidRules.value = []; });
watch(() => avoidSessionId.value, () => { void loadAvoidRules(); });

function onPickAvoidBlocked(options: AdminUserOptionDto[]): void {
  avoidBlocked.value = options[0] ?? null;
}
function onPickAvoidOwner(options: AdminUserOptionDto[]): void {
  avoidOwner.value = options[0] ?? null;
}

async function addAvoidRule(): Promise<void> {
  if (!avoidSessionId.value) { ui.notify('请先选择时段', 'warning'); return; }
  if (!avoidBlocked.value) { ui.notify('请选择要回避的账号', 'warning'); return; }
  if (avoidOwner.value && avoidOwner.value.id === avoidBlocked.value.id) {
    ui.notify('发起人和回避对象不能是同一个人', 'warning');
    return;
  }
  // 已报名的人不会被自动取消，先讲清楚，避免运营以为加了名单就没事了
  try {
    const res = await api.admin.registrations.list({
      page: 1, pageSize: 20, sessionId: avoidSessionId.value, keyword: avoidBlocked.value.wechatId,
    });
    const live = res.list.find(
      (r) => r.userWechatId === avoidBlocked.value?.wechatId
        && r.sessionId === avoidSessionId.value
        && ['CONFIRMED', 'CHECKED_IN'].includes(r.status),
    );
    if (live) {
      await ui.confirm(
        `「${avoidBlocked.value.wechatId}」已在这个时段报名（#${live.id}）。加入回避名单不会取消他现有的报名，需要你手动处理。仍要继续吗？`,
        '该账号已报名',
      );
    }
  } catch {
    // 运营主动取消确认视为放弃
    return;
  }

  avoidSaving.value = true;
  try {
    await api.admin.registrations.avoidRules.create({
      sessionId: avoidSessionId.value,
      blockedUserId: avoidBlocked.value.id,
      ...(avoidOwner.value ? { ownerUserId: avoidOwner.value.id } : {}),
    });
    ui.notify('已加入回避名单', 'success');
    avoidBlocked.value = null;
    avoidBlockedWechat.value = '';
      await loadAvoidRules();
  } catch {
    // 统一错误提示
  } finally {
    avoidSaving.value = false;
  }
}

async function revokeAvoidRule(rule: SessionAvoidRuleDto): Promise<void> {
  try {
    await ui.confirm(`解除后「${rule.blockedNickname}」可以报名这个时段，确定吗？`, '解除回避');
  } catch { return; }
  try {
    await api.admin.registrations.avoidRules.revoke(rule.id);
    ui.notify('已解除', 'success');
    await loadAvoidRules();
  } catch {
    // 统一错误提示
  }
}

/* ---------------- 导出筛选结果 ----------------
 * 前端直接对当前筛选后的列表生成 CSV（含 BOM，Excel 中文不乱码），
 * 不新增服务端导出接口，也不放宽 admin:export 能力边界。
 * 列表已改服务端分页，导出必须按同一套筛选条件把全部页拉回来，否则只会导出当前页。
 */
async function exportCsv(): Promise<void> {
  if (!total.value) {
    ui.notify('当前筛选下没有可导出的报名', 'warning');
    return;
  }
  const fullTime = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
  };
  const money = (cent: number): string => (cent / 100).toFixed(2);
  const header = ['登记ID', '微信号', '来源', '场次', '时段', '时段开始', '状态', '到场', '消耗积分', '基准积分', '减免积分', '权益券', '登记时间'];
  const all = await loadAllPages((p, size) => api.admin.registrations.list({
    page: p,
    pageSize: size,
    ...(eventId.value ? { eventId: eventId.value } : {}),
    ...(sessionFilter.value ? { sessionId: sessionFilter.value } : {}),
    ...(statusFilter.value ? { status: statusFilter.value as RegistrationDto['status'] } : {}),
    ...(paymentFilter.value ? { paymentStatus: paymentFilter.value as RegistrationDto['paymentStatus'] } : {}),
    ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    ...(dateFrom.value ? { dateFrom: dateFrom.value } : {}),
    ...(dateTo.value ? { dateTo: dateTo.value } : {}),
  }));
  const rows = all.list.map((r) => [
    r.id,
    r.userWechatId ?? '',
    metaOf(REGISTRATION_SOURCE, r.source).label,
    r.eventTitle ?? r.event?.title ?? '',
    r.sessionLabel ?? r.session?.label ?? '',
    fullTime(r.sessionStartAt ?? r.session?.startAt),
    metaOf(REGISTRATION_STATUS, r.status).label,
    metaOf(PAYMENT_STATUS, r.paymentStatus).label,
    money(r.feeCent),
    money(r.originalFeeCent),
    money(r.discountCent),
    r.couponTitle ?? '',
    fullTime(r.createdAt),
  ]);
  const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [header, ...rows].map((row) => row.map(cell).join(',')).join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `报名导出_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ui.notify(`已导出 ${all.list.length} 条报名`, 'success');
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">
          {{ scoped ? `报名管理 · ${eventTitle || '当前场次'}` : '报名管理' }}
        </h1>
        <p class="mt-1 text-sm text-slate-500">
          普通用户登记后点「确认到场」补记到场状态；会员登记直接结算积分，无需确认。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button v-if="scoped" @click="clearScope">查看全部场次的报名</el-button>
        <el-button @click="openAvoid">回避名单</el-button>
        <el-button type="primary" @click="openManual">+ 手动录入报名</el-button>
      </div>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <el-input v-model="keyword" placeholder="搜索微信号或场次" clearable class="!w-56" />
      <el-select v-model="statusFilter" placeholder="全部状态" clearable class="!w-36">
        <el-option v-for="(m, k) in REGISTRATION_STATUS" :key="k" :label="m.label" :value="k" />
      </el-select>
      <el-select v-model="paymentFilter" placeholder="全部状态" clearable class="!w-36">
        <el-option v-for="(m, k) in PAYMENT_STATUS" :key="k" :label="m.label" :value="k" />
      </el-select>
      <el-button v-if="unpaidTotal" size="small" type="warning" plain @click="paymentFilter = 'UNPAID'">
        待确认 {{ unpaidTotal }}
      </el-button>
      <!-- 报名时间范围：按本地自然日筛（含首含尾），财务对账不必再导出 CSV -->
      <span class="flex items-center gap-1 text-xs text-slate-500">
        报名时间
        <el-date-picker v-model="dateRange" type="daterange" unlink-panels
          range-separator="至" start-placeholder="开始" end-placeholder="结束"
          format="YYYY-MM-DD" value-format="YYYY-MM-DD" size="small" class="!w-56" />
      </span>
      <el-button v-if="keyword || statusFilter || paymentFilter || sessionFilter || dateFrom || dateTo" size="small" text @click="resetFilters">清空筛选</el-button>
      <el-button size="small" @click="exportCsv">导出筛选结果</el-button>
      <span class="ml-auto text-xs text-slate-500">
        {{ scoped ? `本场次 ${total} 条` : `共 ${total} 条` }}
      </span>
    </div>

    <!-- 批量工具条：只在有勾选时出现，避免平时占地方 -->
    <div v-if="selected.length" class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3">
      <span class="text-xs font-medium text-blue-800">已选 {{ selected.length }} 条</span>
      <el-button size="small" type="primary" :loading="batchBusy" :disabled="!batchCheckInIds.length" @click="runBatch('CHECK_IN')">
        批量签到{{ batchCheckInIds.length ? ` (${batchCheckInIds.length})` : '' }}
      </el-button>
      <el-button size="small" type="success" :loading="batchBusy" :disabled="!batchPayIds.length" @click="runBatch('CONFIRM_PAYMENT')">
        批量确认到场{{ batchPayIds.length ? ` (${batchPayIds.length})` : '' }}
      </el-button>
      <el-button size="small" text @click="selected = []">取消选择</el-button>
      <span class="ml-auto text-[11px] text-blue-700">只会处理当前页中状态允许的记录，其余的自动跳过</span>
    </div>

    <!-- 时段占用条：一眼看出哪个时段已满 / 还差几人，点击只看该时段 -->
    <div v-if="scoped && scopedEvent" class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <span class="text-xs font-medium text-slate-600">时段名额：</span>
      <button
        v-for="s in scopedEvent.sessions"
        :key="s.id"
        class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition"
        :class="sessionFilter === s.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
        @click="sessionFilter = sessionFilter === s.id ? '' : s.id"
      >
        <span class="font-medium">{{ s.label }}</span>
        <!-- 代拍不限人数：不显示 x/y 与余量，只显示已约数量 -->
        <template v-if="s.kind === 'PROXY'">
          <span>{{ s.capacityUsed }} 单</span>
          <span class="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">不限</span>
        </template>
        <template v-else>
          <span>{{ s.capacityUsed }}/{{ s.capacity }}</span>
          <span
            class="rounded-full px-1.5 py-0.5 text-[11px]"
            :class="s.capacityUsed >= s.capacity ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'"
          >
            {{ s.capacityUsed >= s.capacity ? '已满' : `余 ${s.capacity - s.capacityUsed}` }}
          </span>
        </template>
      </button>
      <span class="text-xs text-slate-500">点击时段只看该时段报名，再点一次取消</span>
    </div>

    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table class="hidden w-full text-left text-sm md:table">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="w-10 px-3 py-2.5">
              <input type="checkbox" class="h-4 w-4 accent-blue-600" :checked="allChecked"
                aria-label="全选当前页" @change="toggleAll(($event.target as HTMLInputElement).checked)" />
            </th>
            <th class="px-3 py-2.5 font-medium">用户</th>
            <th class="px-3 py-2.5 font-medium">场次</th>
            <th class="px-3 py-2.5 font-medium">时段</th>
            <th class="px-3 py-2.5 font-medium">状态</th>
            <th class="px-3 py-2.5 font-medium">收款</th>
            <th class="px-3 py-2.5 font-medium">费用</th>
            <th class="px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id" class="border-t border-slate-100 hover:bg-slate-50/60">
            <td class="px-3 py-2.5">
              <input v-model="selected" type="checkbox" :value="r.id" class="h-4 w-4 accent-blue-600"
                :aria-label="`选择报名 ${r.id}`" />
            </td>
            <td class="px-3 py-2.5">
              <p class="font-medium text-slate-900">{{ r.userWechatId ?? `#${r.userId}` }}</p>
              <p class="text-xs text-slate-500">
                报名 #{{ r.id }}
                <span class="ml-1 rounded px-1.5 py-0.5 text-[11px]" :class="metaOf(REGISTRATION_SOURCE, r.source).cls">{{ metaOf(REGISTRATION_SOURCE, r.source).label }}</span>
              </p>
              <p class="text-xs text-slate-500">{{ shortTime(r.createdAt) }}</p>
            </td>
            <td class="px-3 py-2.5">
              <p class="clamp-1 text-slate-700"
                :title="r.eventTitle ?? r.event?.title ?? `场次 #${r.eventId}`">{{ r.eventTitle ?? r.event?.title ?? `场次 #${r.eventId}` }}</p>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 text-slate-600">
              {{ r.sessionLabel ?? r.session?.label ?? '—' }}
              <p class="text-xs text-slate-500">{{ shortTime(r.sessionStartAt ?? r.session?.startAt) }}</p>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(REGISTRATION_STATUS, r.status).cls">
                {{ metaOf(REGISTRATION_STATUS, r.status).label }}
              </span>
              <!-- 候补已下线（2026-11-13）：不再展示候补序号 -->
            </td>
            <td class="whitespace-nowrap px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(PAYMENT_STATUS, r.paymentStatus).cls">
                {{ metaOf(PAYMENT_STATUS, r.paymentStatus).label }}
              </span>
            </td>
            <td class="px-3 py-2.5">
              <p class="font-medium text-slate-900">{{ points(r.feeCent) }}</p>
              <p v-if="r.discountCent > 0" class="clamp-1 max-w-[168px] text-xs text-emerald-600"
                :title="`原 ${points(r.originalFeeCent)} · ${r.couponTitle ?? '优惠券'}`">
                原 {{ points(r.originalFeeCent) }} · {{ r.couponTitle ?? '优惠券' }}
              </p>
            </td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap">
              <el-button v-if="canConfirmPay(r)" size="small" type="primary" @click="confirmPay(r)">确认到场</el-button>
              <el-button v-if="canCheckIn(r)" size="small" @click="act(r, 'CHECK_IN')">签到</el-button>
              <el-button v-if="canCancel(r)" size="small" text type="danger" @click="act(r, 'CANCEL')">取消</el-button>
              <span v-if="!canConfirmPay(r) && !canCheckIn(r) && !canCancel(r)"
                class="text-xs text-slate-300">—</span>
            </td>
          </tr>
          <tr v-if="!loading && !filtered.length">
            <td colspan="8" class="px-3 py-14 text-center">
              <p class="text-sm text-slate-600">没有匹配的报名</p>
              <p class="mt-1 text-xs text-slate-500">可以清空筛选，或用「+ 手动录入报名」补录线下报名</p>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 移动端卡片 -->
      <div class="divide-y divide-slate-100 md:hidden">
        <div v-if="filtered.length" class="flex items-center gap-2 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <input type="checkbox" class="h-4 w-4 accent-blue-600" :checked="allChecked"
            aria-label="全选当前页" @change="toggleAll(($event.target as HTMLInputElement).checked)" />
          <span>全选本页</span>
        </div>
        <div v-for="r in filtered" :key="r.id" class="p-3">
          <div class="flex items-start justify-between gap-2">
            <input v-model="selected" type="checkbox" :value="r.id" class="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
              :aria-label="`选择报名 ${r.id}`" />
            <div class="min-w-0 flex-1">
              <p class="clamp-1 font-medium text-slate-900">{{ r.userWechatId ?? `#${r.userId}` }}</p>
              <p class="mt-0.5 clamp-1 text-xs text-slate-500">{{ r.eventTitle ?? r.event?.title ?? `场次 #${r.eventId}` }}</p>
              <p class="mt-0.5 text-xs text-slate-500">{{ r.sessionLabel ?? r.session?.label ?? '—' }} · {{ points(r.feeCent) }}</p>
              <p class="text-xs text-slate-500">报名 #{{ r.id }} · {{ shortTime(r.createdAt) }}</p>
              <p v-if="r.discountCent > 0" class="text-xs text-emerald-600">原 {{ points(r.originalFeeCent) }} · {{ r.couponTitle ?? '优惠券' }}</p>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1">
              <span class="rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(REGISTRATION_SOURCE, r.source).cls">{{ metaOf(REGISTRATION_SOURCE, r.source).label }}</span>
              <span class="rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(REGISTRATION_STATUS, r.status).cls">{{ metaOf(REGISTRATION_STATUS, r.status).label }}</span>
              <span class="rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(PAYMENT_STATUS, r.paymentStatus).cls">{{ metaOf(PAYMENT_STATUS, r.paymentStatus).label }}</span>
            </div>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <el-button v-if="canConfirmPay(r)" size="small" type="primary" @click="confirmPay(r)">确认到场</el-button>
            <el-button v-if="canCheckIn(r)" size="small" @click="act(r, 'CHECK_IN')">签到</el-button>
            <el-button v-if="canCancel(r)" size="small" text type="danger" @click="act(r, 'CANCEL')">取消</el-button>
          </div>
        </div>
        <div v-if="!loading && !filtered.length" class="px-3 py-12 text-center text-sm text-slate-500">没有匹配的报名</div>
      </div>
    </div>

    <!-- 服务端分页：报名表只增不减，全量拉取迟早撑不住 -->
    <AppPagination
      :page="page"
      :page-size="pageSize"
      :total="total"
      :hide-on-single-page="true"
      :summary="scoped ? `本场次 ${total} 条` : `共 ${total} 条`"
      @change="(p) => goPageTo(p)"
      @size-change="(s) => changePageSize(s)"
    />

    <!-- 回避名单弹窗：时段级，只有运营能配 -->
    <el-dialog v-model="avoidOpen" title="时段回避名单" width="min(640px, 94vw)" top="6vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <el-alert type="info" :closable="false"
          title="作用是「某个时段不接受某人报名」，不是全局封禁：被回避的人换一个时段仍可正常报名。会员看不到这份名单。" />

        <el-form label-width="96px" label-position="left">
          <el-form-item label="场次" required>
            <el-select v-model="avoidEventId" placeholder="请选择场次" filterable class="!w-full">
              <el-option v-for="e in manualEvents" :key="e.id"
                :label="`${e.title}（${metaOf(EVENT_STATUS, e.status).label}）`"
                :value="e.id" :disabled="!eventSelectable(e)" />
            </el-select>
          </el-form-item>
          <el-form-item label="时段" required>
            <el-select v-model="avoidSessionId" :disabled="!avoidEvent"
              :placeholder="avoidEvent ? '请选择时段' : '先选择场次'" class="!w-full">
              <el-option v-for="s in avoidEvent?.sessions ?? []" :key="s.id"
                :label="`${s.label} · ${shortTime(s.startAt)}`" :value="s.id" />
            </el-select>
          </el-form-item>
        </el-form>

        <div v-if="avoidSessionId" class="rounded-lg border border-slate-200 p-3">
          <p class="mb-2 text-xs font-medium text-slate-600">新增一条</p>
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-xs text-slate-500">回避对象</span>
              <UserPicker v-model="avoidBlockedWechat" placeholder="搜索微信号或昵称" @change="onPickAvoidBlocked" />
            </div>
            <div class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-xs text-slate-500">为谁设置</span>
              <UserPicker v-model="avoidOwnerWechat" placeholder="选填：该会员取消报名后此条规则自动失效" @change="onPickAvoidOwner" />
            </div>
            <div class="flex justify-end">
              <el-button type="primary" size="small" :loading="avoidSaving" @click="addAvoidRule">加入名单</el-button>
            </div>
          </div>
        </div>

        <div>
          <p class="mb-2 text-xs font-medium text-slate-600">
            当前生效 {{ avoidRules.length ? `（${avoidRules.length} 条）` : '' }}
          </p>
          <div v-if="avoidLoading" class="h-16 animate-pulse rounded-lg bg-slate-100" />
          <div v-else-if="!avoidSessionId" class="rounded-lg bg-slate-50 px-3 py-3 text-xs text-slate-500">
            先选择时段，再看该时段的名单。
          </div>
          <div v-else-if="!avoidRules.length" class="rounded-lg bg-slate-50 px-3 py-3 text-xs text-slate-500">
            这个时段没有设置任何回避规则。
          </div>
          <div v-else class="divide-y divide-slate-100 rounded-lg border border-slate-200">
            <div v-for="r in avoidRules" :key="r.id" class="flex items-center justify-between gap-3 p-2.5 text-xs">
              <p class="min-w-0 truncate text-slate-800">
                <b>{{ r.blockedNickname }}</b>
                <span class="text-slate-500">（{{ r.blockedWechatId }}）不可报名</span>
              </p>
              <el-button size="small" text type="danger" @click="revokeAvoidRule(r)">解除</el-button>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <el-button @click="avoidOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 手动录入弹窗 -->
    <el-dialog v-model="manualOpen" title="手动录入报名" width="min(620px, 94vw)" top="6vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <el-form label-width="96px" label-position="left">
          <el-form-item label="场次" required>
            <el-select v-model="manualForm.eventId" placeholder="请选择场次" filterable class="!w-full">
              <el-option v-for="e in manualEvents" :key="e.id"
                :label="`${e.title}（${metaOf(EVENT_STATUS, e.status).label}）`"
                :value="e.id" :disabled="!eventSelectable(e)" />
            </el-select>
          </el-form-item>

          <el-form-item label="时段" required>
            <el-select v-model="manualForm.sessionId" :disabled="!selectedEvent"
              :placeholder="selectedEvent ? '请选择时段' : '先选择场次'" class="!w-full">
              <el-option v-for="s in selectedEvent?.sessions ?? []" :key="s.id"
                :label="s.kind === 'PROXY'
                  ? '代拍 · 无需到场 · 不限人数'
                  : `${s.label} · ${shortTime(s.startAt)} · 余 ${Math.max(0, s.capacity - s.capacityUsed)}`"
                :value="s.id" :disabled="!sessionSelectable(s)" />
            </el-select>
          </el-form-item>

          <el-form-item label="报名账号" required>
            <div class="w-full">
              <UserPicker v-model="manualForm.wechatId" placeholder="搜索微信号或昵称" @change="onPickUser" />
              <span class="mt-1 block text-xs text-slate-500">仅可选已注册用户；未注册请先在「用户管理」新增。</span>
            </div>
          </el-form-item>

          <el-form-item label="名额数">
            <div class="w-full">
              <el-input-number v-model="manualForm.seats" :min="1" :max="10" controls-position="right" class="!w-28" />
              <span class="ml-2 text-xs text-slate-500">一次最多 10 个，与自助登记同口径</span>
            </div>
          </el-form-item>
        </el-form>

        <div v-if="lookup" class="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span class="font-medium text-slate-900">{{ lookup.nickname }}</span>
          · {{ metaOf(MEMBER_LEVEL, lookup.level).label }}
          <span v-if="manualUnitFee != null"> · 按该等级计价 {{ points(manualUnitFee) }}/名额</span>
          <span v-if="balanceKnown"> · 可用积分 {{ points(lookup.availableCent ?? 0) }}</span>
          <span v-else-if="canCredit" class="text-slate-400"> · 余额查询中</span>
          <span v-else class="text-slate-400"> · 无积分账户</span>
        </div>
        <el-alert v-if="lookupError" :title="lookupError" type="error" :closable="false" show-icon />
        <el-alert v-if="manualDuplicate"
          :title="`该账号在此时段已有报名 #${manualDuplicate.id}，继续提交会再新增记录。`"
          type="warning" :closable="false" show-icon />

        <!-- 结算方式 -->
        <div>
          <span class="mb-1.5 block text-xs font-medium text-slate-600">结算方式</span>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="m in (['CREDIT', 'OFFLINE_PAID', 'OFFLINE_UNPAID', 'FREE'] as AdminManualSettleMode[])"
              :key="m" type="button"
              class="rounded-lg border px-3 py-2 text-left text-xs transition"
              :class="manualForm.settleMode === m
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-700'
                : 'border-slate-300 text-slate-600 hover:border-slate-400'
                + (m === 'CREDIT' && lookup && !canCredit ? ' cursor-not-allowed opacity-40' : '')"
              :disabled="m === 'CREDIT' && !!lookup && !canCredit"
              @click="manualForm.settleMode = m">
              <span class="block">{{ ADMIN_MANUAL_SETTLE_META[m].label }}</span>
              <span class="mt-0.5 block font-normal text-[11px] text-slate-500">{{ ADMIN_MANUAL_SETTLE_META[m].hint }}</span>
            </button>
          </div>
          <p v-if="lookup && !canCredit" class="mt-1 text-xs text-amber-600">
            该账号不是 VIP/SVIP，没有积分账户，只能走线下收款或免费。
          </p>
        </div>

        <!-- 优惠券：线下收款也能用 -->
        <div>
          <span class="mb-1.5 block text-xs font-medium text-slate-600">
            优惠券
            <span class="ml-1 font-normal text-slate-500">
              {{ userCoupons.length ? `可用 ${userCoupons.length} 张 / 最多选 ${manualForm.seats} 张` : '该账号暂无可用券' }}
            </span>
          </span>
          <el-select v-if="userCoupons.length" v-model="manualForm.couponIds" multiple collapse-tags collapse-tags-tooltip
            :multiple-limit="manualForm.seats" placeholder="不使用优惠券" class="!w-full">
            <el-option v-for="c in userCoupons" :key="c.id"
              :label="`${c.title} · ${c.type === 'DISCOUNT' ? `${(Number(c.discountBp ?? 10000) / 1000).toFixed(1).replace(/\.0$/, '')} 折` : `减 ${points(Number(c.amountCent ?? 0))}`}`"
              :value="c.id" />
          </el-select>
          <p v-else class="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            选择报名账号后可挑选该账号的未使用券；券按名额逐个抵扣，不足的名额按原价。
          </p>
        </div>

        <!-- 结算预览：与自助登记确认弹窗同一口径 -->
        <div v-if="lookup && manualUnitFee != null" class="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs">
          <div class="flex justify-between py-0.5"><span class="text-slate-500">单价 × 名额</span>
            <span class="text-slate-700">{{ points(manualUnitFee) }} × {{ manualForm.seats }}</span></div>
          <div class="flex justify-between py-0.5"><span class="text-slate-500">基准合计</span>
            <span class="text-slate-700">{{ points(manualGross) }}</span></div>
          <div v-if="manualDiscount > 0" class="flex justify-between py-0.5"><span class="text-slate-500">
            {{ manualForm.settleMode === 'FREE' ? '免费额度' : '优惠券减免' }}</span>
            <span class="text-emerald-600">-{{ points(manualDiscount) }}</span></div>
          <div class="mt-1 flex justify-between border-t border-slate-100 pt-1.5">
            <span class="font-medium text-slate-600">
              {{ manualForm.settleMode === 'CREDIT' ? '本次扣积分' : manualForm.settleMode === 'FREE' ? '实收' : '应收金额' }}
            </span>
            <span class="font-semibold" :class="manualForm.settleMode === 'CREDIT' ? 'text-rose-600' : 'text-slate-900'">
              {{ points(manualPayable) }}
            </span>
          </div>
          <p v-if="manualBalanceGap > 0" class="mt-1 rounded bg-rose-50 px-2 py-1 text-rose-600">
            可用积分不足，还差 {{ points(manualBalanceGap) }}；请减少名额、改用线下收款，或先给该账号调账。
          </p>
        </div>

        <!-- 到场状态 -->
        <div>
          <span class="mb-1 block text-xs font-medium text-slate-600">到场状态</span>
          <el-radio-group v-model="manualForm.arriveStatus">
            <el-radio value="CONFIRMED">待到场</el-radio>
            <el-radio value="CHECKED_IN">已现场签到</el-radio>
          </el-radio-group>
        </div>

        <div>
          <span class="mb-1 block text-xs font-medium text-slate-600">备注（写入审计日志）</span>
          <el-input v-model="manualForm.reason" maxlength="200" show-word-limit
            placeholder="例：微信群报名，现场现金已收" />
        </div>

        <el-alert type="info" :closable="false"
          title="手动录入不校验线上报名截止时间与时段冲突，但仍校验场次状态、等级可见性、时段余量、名额上限与券的有效性；金额一律服务端重算。" />
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="manualOpen = false">取消</el-button>
          <el-button type="primary" :loading="manualSaving" :disabled="manualBalanceGap > 0" @click="submitManual">
            确认录入
          </el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
