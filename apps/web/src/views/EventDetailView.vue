<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AppError, BIZ_CODES, couponDiscountOf, messageFor,
  type CouponDto, type EventAvailabilityDto, type EventDto, type EventParticipantsDto,
  type EventSessionDto, type ScheduleConflictDto,
} from '@photo/shared';
import { formatPoints, labelOf } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { pointsFor, publicPointsOf, timeRange, pts, ptsNum } from '../composables/usePricing';
import PosterCarousel from '../components/PosterCarousel.vue';
import ImageLightbox from '../components/ImageLightbox.vue';
import ModelInfoDialog from '../components/ModelInfoDialog.vue';

const route = useRoute();
const router = useRouter();
const id = String(route.params.id);
const ui = useUiStore();
const session = useSessionStore();

const event = ref<EventDto | null>(null);
const availability = ref<EventAvailabilityDto | null>(null);
/** 后台「海报二维码」里配置的客服码，同时用于报名页的「联系客服」 */
const serviceQrUrl = ref('');
const error = ref('');
const busy = ref(false);
const confirmOpen = ref(false);

/**
 * 报名失败的行动引导。
 *
 * 原来非冲突类错误只走全局 toast（2.6 秒后消失），用户看完不知道该做什么。
 * 例如「积分不足」只提示四个字，而用户真正需要的是「差多少、找谁充」。
 * 这里把高频错误码映射成「标题 + 说明 + 下一步」，用弹窗承接，不随 toast 消失。
 */
interface FailGuide {
  title: string;
  detail: string;
  /** 主行动按钮；null 表示只展示说明 */
  action: { label: string; run: () => void } | null;
}
const failGuide = ref<FailGuide | null>(null);

/**
 * 非会员登记成功后的「待支付」引导。
 * 登记成功 ≠ 报名确认：名额先保留，联系客服付款、运营确认收款后才生效。
 * 弹窗里直接给客服二维码（后台「海报二维码」配置），避免用户找不到付款入口。
 */
const pendingGuide = ref<{ seats: number; amountText: string | null } | null>(null);

function guideForFailure(e: AppError): FailGuide | null {
  const needQr = serviceQrUrl.value
    ? '可下滑到页面底部扫描客服二维码，或联系群内客服。'
    : '请联系客服处理。';

  switch (e.code) {
    case BIZ_CODES.BALANCE_INSUFFICIENT: {
      // 余额与应付积分由 availability 下发，直接算出差额
      const balance = availability.value?.balanceCent ?? null;
      const need = availability.value?.priceCent ?? price.value;
      const gap = balance != null ? Math.max(0, need - balance) : null;
      return {
        title: '积分不足，无法完成登记',
        detail: [
          balance != null ? `当前可用 ${pts(balance)}，本次需 ${pts(need)}。` : `本次需 ${pts(need)}。`,
          gap ? `还差 ${pts(gap)}。` : '',
          `积分由运营发放，可联系客服申请补充。${needQr}`,
        ].filter(Boolean).join(''),
        action: serviceQrUrl.value
          ? { label: '查看客服二维码', run: () => { failGuide.value = null; scrollToService(); } }
          : null,
      };
    }
    case BIZ_CODES.EVENT_FULL:
      return {
        title: '名额已满',
        detail: `本场次当前时段已被报满。可以看看其它时段，或${needQr}`,
        action: { label: '刷新余量', run: () => { failGuide.value = null; void loadAvailability(); } },
      };
    case BIZ_CODES.ALREADY_REGISTERED:
      return {
        title: '你已登记本场次',
        detail: '同一场次只能登记一次。可以到「我的登记」查看详情或取消。',
        action: { label: '去看我的登记', run: () => { failGuide.value = null; void router.push('/my'); } },
      };
    case BIZ_CODES.REFUND_WINDOW_CLOSED:
      return {
        title: '已超过可取消时间',
        detail: '本单已进入不可取消窗口，如需特殊处理请联系客服说明情况。',
        action: null,
      };
    case BIZ_CODES.LEVEL_INSUFFICIENT:
      return {
        title: '当前等级暂不可登记',
        detail: `本场次仅对更高等级会员开放。${needQr}`,
        action: null,
      };
    case BIZ_CODES.SEATS_EXCEEDED:
      return {
        title: '名额数量超出限制',
        detail: '本次选择的登记人数超过了剩余名额或单次上限，减少人数后再试。',
        action: { label: '调整人数', run: () => { failGuide.value = null; seats.value = 1; } },
      };
    case BIZ_CODES.COUPON_INVALID:
    case BIZ_CODES.COUPON_NOT_ALLOWED:
      return {
        title: '优惠券不可用',
        detail: '所选优惠券可能已过期、已被使用，或本场次不支持用券。取消勾选后再提交即可。',
        action: { label: '重新选券', run: () => { failGuide.value = null; couponSel.value = []; } },
      };
    default:
      return null;
  }
}

/** 滚动到底部客服区块（没有二维码时返回顶部说明） */
function scrollToService(): void {
  const el = document.getElementById('service-qr');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
const selectedId = ref('');

/* ---------- 图片灯箱 ---------- */
const lightboxOpen = ref(false);
const lightboxImages = ref<string[]>([]);
const lightboxIndex = ref(0);
const lightboxKey = ref(0);
function openLightbox(images: string[], i = 0): void {
  const list = images.filter(Boolean);
  if (!list.length) return;
  lightboxImages.value = list;
  lightboxIndex.value = i;
  lightboxKey.value += 1;
  lightboxOpen.value = true;
}

/* ---------- 模特资料弹窗 ---------- */
const modelDialogOpen = ref(false);
/** 弹窗当前展示哪位模特：双人场要能分别打开两人的资料 */
const dialogModelId = ref<string | null>(null);

/* ---------- 报名门槛（点2）：人工分阶段放开，未轮到当前等级时给出明确提示 ---------- */
const gateBlocked = computed(() => availability.value?.reasonCode === BIZ_CODES.REGISTRATION_LEVEL_GATE);
const gateLevelLabel = computed(() => {
  const lv = event.value?.registerMinLevel ?? 'NONE';
  return lv === 'SVIP' ? 'SVIP' : lv === 'VIP' ? 'VIP 及以上' : '所有人';
});

/**
 * 常规时段与代拍分开渲染。
 * 代拍独立于时间排期（会员不必到场），混在时段列表里会让人以为它是个时间段。
 */
const allSessions = computed(() => event.value?.sessions ?? []);
const proxySession = computed(() => allSessions.value.find((s) => s.kind === 'PROXY') ?? null);
const list = computed(() => allSessions.value.filter((s) => s.kind !== 'PROXY'));
const selected = computed<EventSessionDto | null>(
  () => allSessions.value.find((s) => s.id === selectedId.value) ?? list.value[0] ?? null,
);
/** 当前选中的是否是代拍（价格与正常报名一致，仅提示文案不同） */
const isProxySelected = computed(() => selected.value?.kind === 'PROXY');
const price = computed(() => (event.value ? pointsFor(event.value, session.level) : 0));
const fullPrice = computed(() => (event.value ? publicPointsOf(event.value) : 0));
/** 只高亮「当前身份实际结算的那一档」：普通用户=活动价，VIP=VIP 价，SVIP=SVIP 价 */
const myPriceLevel = computed<'PUBLIC' | 'VIP' | 'SVIP'>(() =>
  session.level === 'SVIP' ? 'SVIP' : session.level === 'VIP' ? 'VIP' : 'PUBLIC',
);
const posters = computed(() => {
  const e = event.value;
  if (!e) return [];
  const out = [...(e.posterUrls ?? [])];
  if (e.coverUrl && !out.includes(e.coverUrl)) out.unshift(e.coverUrl);
  return out;
});
/**
 * 详情页三块图区：模特 / 服装 / 场地。
 * 模特优先用档案里的多图，没有就退回作品集封面；空数组的整块不渲染。
 */
/** 本场次全部模特；旧响应没有 models 时回退成单个 model */
const eventModels = computed(() => {
  const e = event.value;
  if (!e) return [];
  return e.models?.length ? e.models : (e.model ? [e.model] : []);
});

/**
 * 双人场：每位模特各自一组照片，标题带名字（「模特照片 · 白電波」）。
 * 单人场保持原来的「模特照片」一块，避免多余的分组标题。
 *
 * 「本场照片」优先：后台为每位模特单独选过本场使用的图，
 * 把它排到图库第一位，用户第一眼看到的就是本场会拍的人。
 */
const modelGalleries = computed(() => eventModels.value
  .map((m, i) => {
    const slotPhoto = event.value?.modelSlots?.find((s) => s.modelId === m.id)?.photoUrls
      ?? event.value?.modelSlots?.[i]?.photoUrls
      ?? [];
    const profile = m.photoUrls?.length ? m.photoUrls : (m.portfolioUrl ? [m.portfolioUrl] : []);
    // 本场照片去重后排到最前
    const images = [...new Set([...slotPhoto, ...profile])];
    return { id: m.id, name: m.stageName, images };
  })
  .filter((g) => g.images.length));

/**
 * 双人场的服装要分人展示。
 *
 * 以前这里固定读整场的 `wardrobeUrls`，双模特场次只能看到一组衣服，
 * 用户分不清「谁穿这套」。现在按 modelSlots 拆开，每人一组、标题带名字；
 * 某位模特没有自己的服装时回退整场那组（单模特老数据就是这种情况）。
 */
/** 某位模特在本场次的照片（用于模特卡头像与点开看图） */
function modelPhotoOf(m: { id: string }, i: number): string | null {
  const slot = event.value?.modelSlots?.find((s) => s.modelId === m.id) ?? event.value?.modelSlots?.[i];
  return slot?.photoUrls?.[0] ?? null;
}

/** 某位模特可点开的图集（本场照片 + 档案图，去重） */
function galleryOf(m: any, i: number): string[] {
  const own = event.value?.modelSlots?.find((s) => s.modelId === m.id)?.photoUrls
    ?? event.value?.modelSlots?.[i]?.photoUrls
    ?? [];
  const profile = m.photoUrls?.length ? m.photoUrls : (m.portfolioUrl ? [m.portfolioUrl] : []);
  return [...new Set([...own, ...profile])];
}

/** 某位模特在本场次的服装；没有自己的就回退整场那组 */
function wardrobeOf(m: { id: string }, i: number): string[] {
  const own = event.value?.modelSlots?.find((s) => s.modelId === m.id)?.wardrobeUrls
    ?? event.value?.modelSlots?.[i]?.wardrobeUrls
    ?? [];
  return own.length ? own : (event.value?.wardrobeUrls ?? []);
}

/** 某位模特的社交账号（带安全链接过滤，避免 javascript: 伪协议可点） */
function socialLinksOf(m: any): Array<{ platform: string; handle: string; safeUrl?: string }> {
  return (m.socialAccounts ?? []).map((s: any) => ({
    ...s,
    safeUrl: /^https?:\/\//i.test(s.url ?? '') ? s.url : undefined,
  }));
}

/** 打开某位模特的资料弹窗 */
function openModelInfo(modelId: string): void {
  dialogModelId.value = modelId;
  modelDialogOpen.value = true;
}

/** 当前弹窗要展示的模特：优先按 id 取，取不到回退第一位 */
const dialogModel = computed(() => {
  const list = eventModels.value;
  return list.find((m) => m.id === dialogModelId.value) ?? list[0] ?? null;
});

const wardrobeGroups = computed(() => {
  const e = event.value;
  if (!e) return [] as Array<{ key: string; title: string; images: string[] }>;
  const multi = eventModels.value.length > 1;
  const shared = e.wardrobeUrls ?? [];

  const groups = eventModels.value
    .map((m, i) => {
      const own = e.modelSlots?.find((s) => s.modelId === m.id)?.wardrobeUrls
        ?? e.modelSlots?.[i]?.wardrobeUrls
        ?? [];
      const images = own.length ? own : shared;
      return {
        key: `wardrobe-${m.id}`,
        title: multi ? `服装照片 · ${m.stageName}` : '服装照片',
        images,
      };
    })
    .filter((g) => g.images.length);

  // 没有任何模特（或模特都没服装）时，退回整场那组
  if (!groups.length && shared.length) {
    return [{ key: 'wardrobe', title: '服装照片', images: shared }];
  }
  /**
   * 多位模特共用同一组服装时（例如只填了一份），标题不加名字会造成
   * 「服装照片 · A」「服装照片 · B」内容却完全一样。这种情况合并成一块。
   */
  const unique = new Set(groups.map((g) => g.images.join('|')));
  if (multi && unique.size === 1 && groups.length > 1) {
    return [{ key: 'wardrobe', title: '服装照片', images: groups[0]!.images }];
  }
  return groups;
});

const showcase = computed(() => {
  const e = event.value;
  if (!e) return [] as Array<{ key: string; title: string; images: string[] }>;
  const multi = modelGalleries.value.length > 1;
  const groups = modelGalleries.value.map((g) => ({
    key: `model-${g.id}`,
    // 双人场标注归属，方便用户对应到具体模特
    title: multi ? `模特照片 · ${g.name}` : '模特照片',
    images: g.images,
  }));
  return [
    ...groups,
    ...wardrobeGroups.value,
    { key: 'venue', title: '场地照片', images: e.venueUrls ?? [] },
  ].filter((g) => g.images.length);
});
/** 模特图：作品集图 + 海报里的服装图统一可放大（弹窗内使用，跟随当前选中的模特） */
const modelImages = computed(() => {
  const m = dialogModel.value;
  if (!m) return [];
  return galleryOf(m, eventModels.value.findIndex((x) => x.id === m.id));
});
/** 历史数据可能存过非 http(s) 链接，渲染前再过一遍白名单，避免 javascript: 伪协议被点击 */
const socialLinks = computed(() => socialLinksOf(dialogModel.value ?? {}));

/**
 * 时段的「状态」与「是否可点」是两件事。
 *
 * 已满/已开始的时段仍然要能被**选中**（否则用户看不到「同场的人」，
 * 也无法理解这一场为什么报不了），只是不能提交登记。
 * 因此这里只返回展示状态，是否禁止提交由 canSubmitSelected 判断。
 */
function stateOf(s: EventSessionDto): { text: string; ok: boolean } {
  if (s.status !== 'OPEN') return { text: '已关闭', ok: false };
  // 代拍以整场结束为界：首场已开始时代拍仍可约
  const deadline = s.kind === 'PROXY' ? s.endAt : s.startAt;
  if (new Date(deadline).getTime() <= Date.now()) return { text: s.kind === 'PROXY' ? '已结束' : '已开始', ok: false };
  // 该时段对你不可选（回避名单）：文案保持中性，换一个时段即可
  if (availability.value?.restrictedSessionIds?.includes(s.id)) {
    return { text: '暂不可选', ok: false };
  }
  // 代拍不占名额、不限人数，永远不显示「已满」也不显示余量
  if (s.kind === 'PROXY') return { text: '可预约', ok: true };
  if (s.capacityUsed >= s.capacity) return { text: '已满', ok: false };
  return { text: `余 ${s.capacity - s.capacityUsed} 席`, ok: true };
}

/**
 * 当前选中的时段能否提交登记。
 *
 * 以服务端逐时段判定为准（sessionChecks），叠加本地的时间/余量兜底；
 * 不依赖 availability.canRegister —— 那只代表「本场还有位」，不代表「你选的这场有位」。
 */
const selectedBlockReason = computed<number | null>(() => {
  const s = selected.value;
  if (!s) return BIZ_CODES.EVENT_NOT_OPEN;
  const check = availability.value?.sessionChecks?.find((c) => c.sessionId === s.id);
  if (check) return check.canRegister ? null : (check.reasonCode ?? BIZ_CODES.EVENT_NOT_OPEN);
  // 兼容：老响应没有 sessionChecks 时退回本地判断
  return stateOf(s).ok ? null : BIZ_CODES.EVENT_FULL;
});

const canSubmitSelected = computed(() => selectedBlockReason.value === null);

/** 选中时段的不可报名提示（吸底条用小字展示原因，而不是让按钮无声变灰） */
const selectedBlockText = computed(() => {
  const code = selectedBlockReason.value;
  if (code == null) return '';
  return messageFor(code);
});

/** 重新拉取余量/可报名状态：满员或刚改过时段后用它刷新，不整页重载 */
async function loadAvailability(): Promise<void> {
  try {
    availability.value = await api.events.availability(id);
  } catch {
    // 刷新失败不打断当前页面，用户可手动重试或刷新
  }
}

/**
 * SVIP 专属：同场登记名单。
 * 只有具备 event:participants:view 才请求，其他人连接口都不打（服务端同样会拦）。
 */
const participants = ref<EventParticipantsDto | null>(null);

async function loadParticipants(): Promise<void> {
  if (!session.can('event:participants:view')) return;
  try {
    participants.value = await api.events.participants(id);
  } catch {
    // 拉不到就整块不展示，不影响主流程
    participants.value = null;
  }
}

/** 只展示当前选中时段的名单：一次看全场会很长，也与「我要登记哪个时段」无关 */
const selectedNames = computed(() => {
  const list = participants.value?.sessions;
  if (!list?.length) return null;
  return list.find((s) => s.sessionId === selectedId.value) ?? null;
});

onMounted(async () => {
  try {
    event.value = await api.events.detail(id);
    availability.value = await api.events.availability(id);
    // 默认选中第一个「真的能报」的常规时段；常规都不行时退回代拍（它常常还能约）
    const normal = (event.value.sessions ?? []).filter((s) => s.kind !== 'PROXY');
    const firstOk = normal.find((s) => stateOf(s).ok);
    const proxy = (event.value.sessions ?? []).find((s) => s.kind === 'PROXY');
    selectedId.value = firstOk?.id
      ?? (proxy && stateOf(proxy).ok ? proxy.id : null)
      ?? normal[0]?.id ?? proxy?.id ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  }
  void loadParticipants();
  // 客服二维码是可选增强：接口失败或未配置时整块不展示，不影响报名主流程
  try {
    serviceQrUrl.value = (await api.settings.public()).serviceQrUrl ?? '';
  } catch {
    serviceQrUrl.value = '';
  }
});

/** 时段冲突：第一次提交由服务端回传，这里展示后让用户二次确认 */
const conflicts = ref<ScheduleConflictDto[]>([]);
/** 已提示过冲突、用户确认后置 true，下次提交带 ignoreConflict */
const forceSubmit = ref(false);
/** 一次同时报名的名额数（带朋友 / 包场 / 连场）；后端一次生成 N 条独立报名 */
const seats = ref(1);
/** 一次报名意图的稳定幂等键：连点/网络重试不会重复创建整批记录 */
const submitKey = ref('');
const newSubmitKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 人数上限：不超过剩余席位与单次上限 10（候补已停用，满员不可报名） */
const maxSeats = computed(() => {
  const s = selected.value;
  if (!s || s.status !== 'OPEN') return 10;
  // 代拍不占名额：不受剩余席位限制，只保留单次上限 10
  if (s.kind === 'PROXY') return 10;
  const left = Math.max(0, Number(s.capacity) - Number(s.capacityUsed));
  return left > 0 ? Math.max(1, Math.min(10, left)) : 10;
});

/* ---------- 优惠券 ---------- */
const myCoupons = ref<CouponDto[]>([]);
const couponSel = ref<string[]>([]);
const couponsLoading = ref(false);

/** 门槛按当前身份档位价判断：券在低档位上可能不满足最低消费 */
const usableCoupons = computed(() =>
  myCoupons.value.filter((c) => c.status === 'UNUSED' && Number(c.minSpendCent) <= price.value),
);
const couponDiscount = (c: CouponDto): number => couponDiscountOf(c, price.value);
const selectedDiscount = computed(() =>
  couponSel.value.reduce((sum, id) => {
    const c = myCoupons.value.find((x) => x.id === id);
    return sum + (c ? couponDiscount(c) : 0);
  }, 0),
);
/** 券后消耗；券数少于名额数时，剩余名额不享减免 */
const payable = computed(() => Math.max(0, price.value * seats.value - selectedDiscount.value));

function couponText(c: CouponDto): string {
  if (c.type === 'AMOUNT') return `减免 ${pts(Number(c.amountCent ?? 0))}`;
  const rate = (Number(c.discountBp ?? 10000) / 1000).toFixed(1).replace(/\.0$/, '');
  return `${rate} 折`;
}

function toggleCoupon(c: CouponDto): void {
  const i = couponSel.value.indexOf(c.id);
  if (i >= 0) {
    couponSel.value.splice(i, 1);
    return;
  }
  if (couponSel.value.length >= seats.value) {
    ui.notify(`每个名额只能用 1 张券，最多选 ${seats.value} 张`, 'fail');
    return;
  }
  couponSel.value.push(c.id);
}

async function loadCoupons(): Promise<void> {
  if (!event.value?.allowCoupon || !session.user) { myCoupons.value = []; return; }
  couponsLoading.value = true;
  try {
    myCoupons.value = await api.coupons.mine();
  } catch {
    myCoupons.value = [];
  } finally {
    couponsLoading.value = false;
  }
}

// 人数减少时裁掉多余券；改变券/人数会改变请求体，幂等键必须跟着换
watch([seats, couponSel], () => {
  if (couponSel.value.length > seats.value) couponSel.value = couponSel.value.slice(0, seats.value);
  submitKey.value = newSubmitKey();
}, { deep: true });

function openConfirm(): void {
  if (!session.user) { ui.notify('请先登录', 'fail'); return; }
  if (!selected.value) { ui.notify('请选择时段', 'fail'); return; }
  // 按钮被改状态也进不来：这里再判一次，提交前 doSubmit 还会判一次
  if (!canSubmitSelected.value) {
    ui.notify(selectedBlockText.value || '该时段当前不可报名', 'fail');
    return;
  }
  conflicts.value = [];
  forceSubmit.value = false;
  seats.value = 1;
  couponSel.value = [];
  submitKey.value = newSubmitKey();
  confirmOpen.value = true;
  void loadCoupons();
}

async function doSubmit(): Promise<void> {
  if (!selected.value) return;
  if (!canSubmitSelected.value) {
    ui.notify(selectedBlockText.value || '该时段当前不可报名', 'fail');
    return;
  }
  busy.value = true;
  try {
    const batch = await api.registrations.create({
      eventId: id,
      sessionId: selected.value.id,
      seats: seats.value,
      ignoreConflict: forceSubmit.value,
      couponIds: couponSel.value,
    }, submitKey.value);
    confirmOpen.value = false;
    // 前端展示的是按当前等级预估的积分；真实结算以服务端逐条 feeCent 为准
    const charged = batch.registrations.reduce((sum, r) => sum + Number(r.feeCent), 0);
    /**
     * 非会员：登记只是「待支付」，钱还没收。不能像会员那样 toast 一句就跳走——
     * 用户会以为登记完就能到场。这里用弹窗明确告知「联系客服付款后才算确认」，
     * 并把客服二维码直接放进弹窗，用户看完再决定去「我的登记」还是留下扫码。
     */
    if (!session.isMember) {
      pendingGuide.value = {
        seats: batch.seats,
        amountText: charged > 0 ? pts(charged) : null,
      };
      return;
    }
    ui.notify(
      `登记成功，共 ${batch.seats} 个名额${charged > 0 ? `，消耗 ${pts(charged)}` : ''}`,
      'success',
    );
    // 直接去「我的报名」看结果（那里可以打开票根）。这里不再刷新本页的 detail/availability：
    // 组件马上就要卸载，两个请求白跑一趟；用户若返回本页，onMounted 会重新拉最新余量。
    await router.push('/my');
  } catch (e) {
    // 时段冲突：留在弹窗里展示冲突详情，按钮变成「仍要报名」
    if (e instanceof AppError && e.code === BIZ_CODES.SCHEDULE_CONFLICT) {
      const detail = e.details as { conflicts?: ScheduleConflictDto[] } | undefined;
      conflicts.value = detail?.conflicts ?? [];
      forceSubmit.value = true;
      // ignoreConflict 变了，请求体不同，必须换幂等键，否则会被判为幂等冲突
      submitKey.value = newSubmitKey();
      return;
    }
    /**
     * 其余错误：能给出行动建议的用弹窗承接（不随 toast 消失），
     * 给不出建议的仍交给 http.onError 的统一 toast。
     */
    if (e instanceof AppError) {
      const guide = guideForFailure(e);
      if (guide) {
        confirmOpen.value = false;
        failGuide.value = guide;
      }
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-3xl pb-32 md:pb-6">
    <RouterLink to="/" class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900">← 返回场次</RouterLink>

    <p v-if="error" class="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-600">{{ error }}</p>

    <template v-if="event">
      <!-- 海报轮播（点击放大） -->
      <div class="mt-3">
        <PosterCarousel v-if="posters.length" :images="posters" :alt="event.title" @zoom="(i) => openLightbox(posters, i)" />
        <div v-else class="flex aspect-[16/9] items-center justify-center rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-100 via-white to-brand-50">
          <span class="text-lg font-semibold text-slate-700">{{ event.title }}</span>
        </div>
      </div>

      <!-- 主信息 -->
      <div class="mt-4">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-semibold tracking-tight text-slate-900">{{ event.title }}</h1>
          <span class="chip" :class="event.visibility === 'SVIP' ? 'badge-svip' : event.visibility === 'VIP' ? 'badge-vip' : 'badge-public'">
            {{ event.visibility === 'PUBLIC' ? '公开' : `${event.visibility} 专属` }}
          </span>
          <span v-if="event.allowProxyShoot" class="chip bg-slate-100 text-slate-600">可代拍</span>
        </div>
        <p v-if="event.subtitle" class="mt-1.5 text-sm text-slate-600">{{ event.subtitle }}</p>

        <!-- 关键信息网格 -->
        <div class="mt-4 grid grid-cols-2 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:grid-cols-4">
          <div>
            <p class="text-xs text-slate-500">日期</p>
            <p class="mt-0.5 text-sm font-medium text-slate-900">
              {{ selected ? new Date(selected.startAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : new Date(event.startAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-slate-500">场地 / 场景</p>
            <p class="mt-0.5 clamp-1 text-sm font-medium text-slate-900">{{ event.venue }}<span v-if="event.scene"> · {{ event.scene }}</span></p>
          </div>
          <div>
            <p class="text-xs text-slate-500">模特</p>
            <p class="mt-0.5 text-sm font-medium text-slate-900">
              <template v-if="eventModels.length">
                {{ eventModels.map((m) => m.stageName).join('、') }}
              </template>
              <span v-else class="font-normal text-slate-500">待公布</span>
              <span v-if="event.ratioLabel" class="font-normal text-slate-500"> · {{ event.ratioLabel }}</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-slate-500">时段</p>
            <p class="mt-0.5 text-sm font-medium text-slate-900">{{ list.length }} 场可选</p>
          </div>
        </div>

        <p v-if="event.description" class="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600">{{ event.description }}</p>
      </div>

      <!-- 报名门槛提示：当前等级尚未轮到报名时展示 -->
      <div v-if="gateBlocked" class="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p class="text-sm font-medium text-amber-800">本场登记尚未开放到你的会员等级</p>
        <p class="mt-1 text-xs leading-relaxed text-amber-700">
          当前仅向「{{ gateLevelLabel }}」开放登记，运营会分阶段放开（SVIP → VIP → 所有人）。请稍后再来，或联系客服了解开放时间。
        </p>
      </div>

      <!-- 场次定价 + 时段：上提到图区之前。
           移动端原来要滚过整块海报和所有作品图才能看到定价和可选时段，
           而这两块恰好是登记决策的唯一依据，所以放在主信息之后。
           各档价格对游客可见（公开信息）；但等级高亮与结算提示只对登录用户展示。 -->
      <div v-if="event.prices?.length" class="mt-6">
        <div v-if="session.isMember" class="mb-2 flex items-end justify-between">
          <span class="text-xs text-slate-500">你当前为 {{ labelOf(session.level) }} 会员</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div v-for="p in event.prices" :key="p.level" class="rounded-xl border bg-white p-2 text-center transition sm:p-3"
            :class="session.user && p.level === myPriceLevel
              ? 'border-brand bg-brand-50 shadow-sm' : 'border-slate-200 opacity-75'">
            <p class="text-xs" :class="p.level === 'SVIP' ? 'text-gold' : p.level === 'VIP' ? 'text-brand-soft' : 'text-slate-500'">
              {{ p.level === 'PUBLIC' ? '标准' : `${p.level} 专属` }}
            </p>
            <p class="mt-1 text-sm font-semibold text-slate-900 sm:text-base">{{ ptsNum(p.priceCent) }}</p>
            <p class="text-xs text-slate-500">/{{ p.unitLabel }}</p>
          </div>
        </div>
        <p v-if="session.isMember && price !== fullPrice" class="mt-2 text-xs text-gold">
          你当前按会员等级结算，比标准少用 {{ ptsNum(fullPrice - price) }}
        </p>
        <p v-else-if="session.user && !session.isMember" class="mt-2 text-xs text-slate-500">
          登记后按会员等级结算，无需在线支付。
        </p>
      </div>

      <div class="mt-6">
        <div class="mb-2 flex items-end justify-between">
          <h2 class="text-sm font-semibold text-slate-900">选择时段</h2>
          <span class="text-xs text-slate-500">{{ list.length }} 场可选</span>
        </div>
        <div class="space-y-2">
          <!--
            已满/已开始的时段仍可点击：选中后才能看到「同场的人」并知道为什么报不了。
            真正的提交拦截由 canSubmitSelected 负责（服务端同样会拦）。
          -->
          <button v-for="s in list" :key="s.id"
            class="flex w-full items-center justify-between rounded-xl border bg-white p-3 text-left transition"
            :class="[
              selectedId === s.id ? 'border-brand ring-2 ring-brand/15' : 'border-slate-200 hover:border-slate-300',
              stateOf(s).ok ? '' : 'opacity-60',
            ]"
            @click="selectedId = s.id">
            <div class="min-w-0">
              <p class="text-sm font-medium text-slate-900">{{ s.label }}</p>
              <p class="mt-0.5 text-xs text-slate-500">{{ timeRange(s.startAt, s.endAt) }}</p>
            </div>
            <span class="chip shrink-0" :class="stateOf(s).ok ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'">
              {{ stateOf(s).text }}
            </span>
          </button>
          <p v-if="!list.length" class="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">该场次暂无开放时段</p>
        </div>
      </div>

      <!-- 代拍：独立于时段，不必本人到场；价格与正常登记一致 -->
      <div v-if="proxySession" class="mt-6">
        <div class="mb-2 flex items-end justify-between">
          <h2 class="text-sm font-semibold text-slate-900">代拍</h2>
          <span class="text-xs text-slate-500">无需本人到场</span>
        </div>
        <button :disabled="!stateOf(proxySession).ok && selectedId !== proxySession.id"
          class="flex w-full items-center justify-between rounded-xl border bg-white p-3 text-left transition disabled:opacity-60"
          :class="selectedId === proxySession.id ? 'border-brand ring-2 ring-brand/15' : 'border-slate-200 hover:border-slate-300'"
          @click="selectedId = proxySession.id">
          <div class="min-w-0">
            <p class="text-sm font-medium text-slate-900">代拍服务</p>
            <p class="mt-0.5 text-xs text-slate-500">
              由摄影师代为拍摄，与正常登记同等权益，价格一致
            </p>
          </div>
          <span class="chip shrink-0" :class="stateOf(proxySession).ok ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'">
            {{ stateOf(proxySession).text }}
          </span>
        </button>
      </div>

      <!-- SVIP 专属：同场都有谁（只显示昵称，不显示微信号） -->
      <div v-if="participants?.available && selectedNames" class="mt-6">
        <div class="mb-2 flex items-end justify-between">
          <h2 class="text-sm font-semibold text-slate-900">同场的人</h2>
          <span class="chip bg-gold-soft text-gold">SVIP 专属</span>
        </div>
        <div class="rounded-xl border border-slate-200 bg-white p-4">
          <p class="text-xs text-slate-500">
            {{ selectedNames.label }} ·
            <b class="text-slate-700">{{ selectedNames.count }}</b> 人已登记
            <span class="text-slate-400">（仅显示昵称）</span>
          </p>
          <div v-if="selectedNames.count" class="mt-2.5 flex flex-wrap gap-1.5">
            <span v-for="(n, i) in selectedNames.nicknames" :key="i"
              class="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{{ n }}</span>
            <span v-if="selectedNames.moreCount"
              class="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
              还有 {{ selectedNames.moreCount }} 人
            </span>
          </div>
          <p v-else class="mt-2 text-xs text-slate-500">这个时段还没有人登记，你可以做第一个。</p>
        </div>
      </div>

      <!-- 三块图区：模特 / 服装 / 场地 -->
      <div v-if="showcase.length" class="mt-6 space-y-5">
        <div v-for="g in showcase" :key="g.key">
          <div class="mb-2 flex items-end justify-between">
            <h2 class="text-sm font-semibold text-slate-900">{{ g.title }}</h2>
            <span class="text-xs text-slate-500">{{ g.images.length }} 张 · 点击放大</span>
          </div>
          <div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <button v-for="(img, i) in g.images" :key="g.key + img + i"
              class="aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
              @click="openLightbox(g.images, i)">
              <img :src="img" :alt="g.title" class="img-zoom h-full w-full object-cover" loading="lazy"
                @error="($event.target as HTMLImageElement).style.opacity = '0.15'" />
            </button>
          </div>
        </div>
      </div>

      <!-- 模特：双人场每位各一张卡，可分别查看资料 -->
      <div v-if="eventModels.length" class="mt-6">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">
            模特
            <span v-if="eventModels.length > 1" class="ml-1 font-normal text-slate-400">共 {{ eventModels.length }} 位</span>
          </h2>
        </div>
        <div class="space-y-3">
          <div v-for="(m, i) in eventModels" :key="m.id"
            class="rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
            <div class="flex items-center gap-3">
              <button v-if="modelPhotoOf(m, i)" class="h-16 w-16 shrink-0 overflow-hidden rounded-xl"
                @click="openLightbox(galleryOf(m, i), 0)">
                <img :src="modelPhotoOf(m, i)!" :alt="m.stageName" class="img-zoom h-full w-full object-cover" />
              </button>
              <div v-else class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-lg font-semibold text-slate-500">
                {{ m.stageName.slice(0, 1) }}
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-slate-900">
                  {{ m.stageName }}
                  <span v-if="eventModels.length > 1" class="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">{{ i + 1 }}</span>
                </p>
                <p class="mt-0.5 text-xs text-slate-500">
                  {{ event.ratioLabel ?? '模特' }}<span v-if="m.heightCm"> · {{ m.heightCm }}cm</span>
                </p>
                <!-- 模特社交账号：有主页地址就做成可点链接 -->
                <div v-if="socialLinksOf(m).length" class="mt-1.5 flex flex-wrap gap-1">
                  <a v-for="s in socialLinksOf(m)" :key="s.platform + s.handle"
                    :href="s.safeUrl" :target="s.safeUrl ? '_blank' : undefined" rel="noopener noreferrer"
                    class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                    :class="s.safeUrl ? 'hover:bg-brand/10 hover:text-brand' : ''">
                    {{ labelOf(s.platform) }} · {{ s.handle }}
                  </a>
                </div>
              </div>
              <button class="shrink-0 text-xs font-medium text-brand hover:underline"
                @click="openModelInfo(m.id)">查看资料</button>
            </div>
            <!-- 本场服装：报名看的就是「这套衣服」，放在这里比翻图区更直接 -->
            <div v-if="wardrobeOf(m, i).length" class="mt-2.5 border-t border-slate-100 pt-2">
              <p class="mb-1.5 text-[11px] text-slate-500">本场服装</p>
              <div class="flex flex-wrap gap-1.5">
                <button v-for="(u, wi) in wardrobeOf(m, i)" :key="u"
                  class="h-14 w-14 overflow-hidden rounded-lg border border-slate-200"
                  @click="openLightbox(wardrobeOf(m, i), wi)">
                  <img :src="u" alt="" class="img-zoom h-full w-full object-cover" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 须知：仅登录用户可见（游客不展示登记规则与结算说明） -->
      <div v-if="session.user" class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 class="mb-2 text-sm font-semibold text-slate-900">登记须知</h2>
        <p v-if="event.notice" class="whitespace-pre-line text-xs leading-relaxed text-slate-600">{{ event.notice }}</p>
        <p v-else class="whitespace-pre-line text-xs leading-relaxed text-slate-600">
          开始前 {{ event.refundPolicy.freeCancelBeforeHours }} 小时可免费取消；逾期取消按 {{ Math.round(event.refundPolicy.feeRatio * 100) }}% 收取手续费。
        </p>
        <ul class="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
          <li>· 请按所选时段提前到场，迟到不延长拍摄时间。</li>
          <li>· 会员登记按所属等级结算积分；积分由运营发放，不可购买、不可转让、不可兑现。普通用户登记后为「待支付」，联系客服付款、运营确认收款后才算登记成功。</li>
          <li v-if="event.allowProxyShoot">· 本场支持代拍，具体安排请联系客服。</li>
          <li v-if="event.privateBookingNote">· {{ event.privateBookingNote }}</li>
        </ul>
      </div>

      <!-- 联系客服：后台配置了客服二维码才展示；移动端长按识别、桌面端微信扫码 -->
      <div v-if="serviceQrUrl" id="service-qr" class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div class="flex items-end justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">联系客服</h2>
          <span class="text-xs text-slate-500">长按识别二维码</span>
        </div>
        <div class="mt-3 flex items-center gap-3 sm:gap-4">
          <img :src="serviceQrUrl" alt="客服二维码" loading="lazy"
            class="h-24 w-24 shrink-0 rounded-xl border border-slate-200 bg-white object-contain sm:h-28 sm:w-28" />
          <div class="min-w-0 text-xs leading-relaxed text-slate-500">
            <p class="text-[13px] font-medium text-slate-900">扫码添加客服微信</p>
            <p class="mt-1">线下付款、改期与退款都可以找客服处理。</p>
            <p class="mt-1 text-xs text-slate-500">手机端长按二维码即可识别，电脑端请用微信扫码。</p>
          </div>
        </div>
      </div>

      <!-- 吸底登记条（移动端避开底部导航）：仅登录用户展示；游客整条不显示（2026-11-17 用户要求） -->
      <div v-if="session.user" class="safe-bottom fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-6px_20px_-12px_rgba(15,23,42,0.25)] backdrop-blur
        md:static md:mt-6 md:border-0 md:bg-transparent md:p-0 md:shadow-none">
        <div class="mx-auto flex max-w-3xl items-center gap-3">
          <div class="min-w-0">
            <p class="text-lg font-semibold text-brand-soft">
              {{ ptsNum(price) }}<span class="ml-1 text-xs font-normal text-slate-500">/{{ event.prices?.[0]?.unitLabel ?? '场' }}</span>
            </p>
            <p class="clamp-1 text-xs text-slate-500">
              {{ session.isMember ? '登记后按会员等级结算' : '登记后联系客服付款确认' }}
              <!-- 展示「当前选中时段」不可报的原因，而不是整场的原因 -->
              <span v-if="selectedBlockText" class="text-amber-600"> · {{ selectedBlockText }}</span>
            </p>
          </div>
          <button class="btn-primary ml-auto min-w-[8rem]" :disabled="!canSubmitSelected" @click="openConfirm">
            立即登记
          </button>
        </div>
      </div>
    </template>

    <!-- 二次确认 -->
    <div v-if="confirmOpen && event" class="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      @click.self="confirmOpen = false">
      <div class="fade-up w-full max-w-md rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
        <h3 class="text-lg font-semibold text-slate-900">确认登记</h3>
        <div class="mt-4 space-y-2.5 text-sm">
          <div class="flex justify-between gap-4"><span class="text-slate-500">场次</span><span class="text-right text-slate-900">{{ event.title }}</span></div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">时段</span>
            <span class="text-right text-slate-900">
              <template v-if="isProxySelected">代拍服务 · 无需本人到场</template>
              <template v-else>{{ selected?.label }} · {{ selected ? timeRange(selected.startAt, selected.endAt) : '' }}</template>
            </span>
          </div>
          <div class="flex items-start justify-between gap-4">
            <span class="shrink-0 text-slate-500">登记人数</span>
            <div class="flex flex-wrap justify-end gap-1">
              <button v-for="n in maxSeats" :key="n" type="button"
                class="h-10 w-10 rounded-xl border text-sm transition"
                :class="seats === n ? 'border-brand bg-brand text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-brand/40'"
                :aria-pressed="seats === n" @click="seats = n">{{ n }}</button>
            </div>
          </div>

          <!-- 优惠券：每名额最多一张，选中顺序不影响金额 -->
          <div v-if="event.allowCoupon" class="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div class="flex items-center justify-between">
              <span class="text-[13px] font-medium text-slate-700">优惠券</span>
              <span class="text-xs text-slate-500">已选 {{ couponSel.length }} / 最多 {{ Math.min(seats, usableCoupons.length) }} 张</span>
            </div>
            <p v-if="couponsLoading" class="mt-1 text-xs text-slate-500">加载中…</p>
            <template v-else>
              <div v-if="usableCoupons.length" class="mt-1.5 space-y-1">
                <button v-for="c in usableCoupons" :key="c.id" type="button"
                  class="flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left transition"
                  :class="couponSel.includes(c.id) ? 'border-brand bg-white ring-1 ring-brand/20' : 'border-slate-200 bg-white hover:border-slate-300'"
                  @click="toggleCoupon(c)">
                  <span class="min-w-0">
                    <span class="block truncate text-[12px] font-medium text-slate-900">{{ c.title }}</span>
                    <span class="block text-[11px] text-slate-500">
                      {{ couponText(c) }} · 本单可减 {{ pts(couponDiscount(c)) }}
                      <span v-if="c.minSpendCent > 0"> · 满 {{ pts(c.minSpendCent) }} 可用</span>
                      <span v-if="c.expiresAt"> · {{ new Date(c.expiresAt).toLocaleDateString('zh-CN') }} 到期</span>
                    </span>
                  </span>
                  <span class="ml-2 shrink-0 text-xs" :class="couponSel.includes(c.id) ? 'text-brand' : 'text-slate-500'">
                    {{ couponSel.includes(c.id) ? '已选' : '选择' }}
                  </span>
                </button>
              </div>
              <p v-else class="mt-1 text-xs text-slate-500">暂无可用优惠券</p>
              <p v-if="usableCoupons.length && usableCoupons.length < seats" class="mt-1 text-[11px] text-amber-600">
                当前只有 {{ usableCoupons.length }} 张可用券，其余 {{ seats - usableCoupons.length }} 个名额不享减免。
              </p>
            </template>
          </div>
          <p v-else class="text-xs text-slate-500">本场次不可使用优惠券</p>

          <div class="flex justify-between gap-4"><span class="text-slate-500">基准积分</span><span class="text-slate-500">{{ ptsNum(price * seats) }}</span></div>
          <div v-if="selectedDiscount > 0" class="flex justify-between gap-4"><span class="text-slate-500">优惠券减免</span><span class="text-emerald-600">-{{ ptsNum(selectedDiscount) }}</span></div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">{{ session.isMember ? '本次消耗' : '应付金额' }}</span>
            <span class="font-semibold text-brand-soft">{{ ptsNum(payable) }}<span v-if="selectedDiscount === 0" class="ml-1 text-xs font-normal text-slate-500">（{{ ptsNum(price) }} × {{ seats }} 人）</span></span>
          </div>
          <div class="flex justify-between gap-4"><span class="text-slate-500">结算方式</span><span class="text-right text-slate-900">{{ session.isMember ? '按会员等级自动结算积分，无需在线支付' : '联系客服线下付款，确认收款后登记生效' }}</span></div>
          <div class="flex justify-between gap-4"><span class="text-slate-500">取消规则</span><span class="text-right text-slate-900">{{ session.isMember ? `开始前 ${event.refundPolicy.freeCancelBeforeHours} 小时可取消，积分全额退回` : '付款前可随时取消；付款后按场次取消规则处理' }}</span></div>
        </div>
        <!-- 时段冲突提示 -->
        <div v-if="conflicts.length" class="mt-3 rounded-lg bg-rose-50 px-3 py-2.5 ring-1 ring-rose-200">
          <p class="text-[13px] font-medium text-rose-700">这段时间你已登记了其它场次</p>
          <ul class="mt-1 space-y-1 text-xs leading-relaxed text-rose-600">
            <li v-for="c in conflicts" :key="c.registrationId">
              {{ c.eventTitle }} · {{ c.sessionLabel }}（{{ timeRange(c.startAt, c.endAt) }}）
            </li>
          </ul>
          <p class="mt-1.5 text-xs text-rose-500">同一时间只能到场一处，请确认是否仍要继续登记。</p>
        </div>

        <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          {{ session.isMember ? '确认后将从积分账户扣除相应积分并占用名额，实际结算以服务端为准。' : '确认后名额先为你保留（待支付），请联系客服完成付款，运营确认收款后登记才正式生效。' }}
          一次登记 {{ seats }} 个名额会生成 {{ seats }} 条独立记录，每位都可单独取消{{ session.isMember ? '，取消后积分按规则退回' : '，付款前取消不产生费用' }}。
        </p>
        <div class="mt-5 flex gap-2">
          <button class="btn-ghost flex-1" @click="confirmOpen = false">再想想</button>
          <button class="btn-primary flex-1" :disabled="busy" @click="doSubmit">
            {{ busy ? '提交中…' : conflicts.length ? '仍要登记' : '确认登记' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 报名失败的行动引导：比 2.6 秒的 toast 更能让用户知道下一步做什么 -->
    <div v-if="failGuide" class="fixed inset-0 z-[160] flex items-center justify-center bg-slate-900/50 p-5"
      @click.self="failGuide = null">
      <div class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-float ring-1 ring-slate-200">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-50 text-base text-rose-500">!</span>
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-slate-900">{{ failGuide.title }}</h3>
            <p class="mt-1.5 text-xs leading-relaxed text-slate-600">{{ failGuide.detail }}</p>
          </div>
        </div>
        <div class="mt-5 flex gap-2">
          <button class="btn-ghost flex-1 py-2 text-sm" @click="failGuide = null">知道了</button>
          <button v-if="failGuide.action" class="btn-primary flex-1 py-2 text-sm" @click="failGuide.action.run()">
            {{ failGuide.action.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- 非会员登记成功：待支付引导（名额已保留，付款确认后才生效） -->
    <div v-if="pendingGuide" class="fixed inset-0 z-[160] flex items-center justify-center bg-slate-900/50 p-5"
      @click.self="pendingGuide = null">
      <div class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-float ring-1 ring-slate-200">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-50 text-base text-amber-500">¥</span>
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-slate-900">登记成功，待支付</h3>
            <p class="mt-1.5 text-xs leading-relaxed text-slate-600">
              已为你保留 {{ pendingGuide.seats }} 个名额{{ pendingGuide.amountText ? `（应付 ${pendingGuide.amountText}）` : '' }}。
              请联系客服完成付款，运营确认收款后登记才正式生效；付款前可随时在「我的登记」中取消。
            </p>
          </div>
        </div>
        <div v-if="serviceQrUrl" class="mt-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <img :src="serviceQrUrl" alt="客服二维码" class="h-20 w-20 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" />
          <p class="text-xs leading-relaxed text-slate-500">扫码添加客服微信付款。<br />手机端长按识别二维码，电脑端请用微信扫码。</p>
        </div>
        <p v-else class="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">请在群内联系客服完成付款。</p>
        <div class="mt-5 flex gap-2">
          <button class="btn-ghost flex-1 py-2 text-sm" @click="pendingGuide = null">留在本页</button>
          <button class="btn-primary flex-1 py-2 text-sm" @click="pendingGuide = null; void router.push('/my')">去看我的登记</button>
        </div>
      </div>
    </div>

    <ModelInfoDialog v-model:open="modelDialogOpen" :model="dialogModel" :can-view-body="session.isMember" @zoom="(imgs, i) => openLightbox(imgs, i)" />
    <ImageLightbox :key="lightboxKey" v-model:open="lightboxOpen" :images="lightboxImages" :start="lightboxIndex" />
  </section>
</template>
