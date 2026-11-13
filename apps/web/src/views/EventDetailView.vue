<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AppError, BIZ_CODES, couponDiscountOf, messageFor,
  type CouponDto, type EventAvailabilityDto, type EventDto, type EventSessionDto, type ScheduleConflictDto,
} from '@photo/shared';
import { formatPoints, labelOf } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { priceFor, publicPriceOf, timeRange, yuan } from '../composables/usePricing';
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

/* ---------- 报名门槛（点2）：人工分阶段放开，未轮到当前等级时给出明确提示 ---------- */
const gateBlocked = computed(() => availability.value?.reasonCode === BIZ_CODES.REGISTRATION_LEVEL_GATE);
const gateLevelLabel = computed(() => {
  const lv = event.value?.registerMinLevel ?? 'NONE';
  return lv === 'SVIP' ? 'SVIP' : lv === 'VIP' ? 'VIP 及以上' : '所有人';
});

const list = computed(() => event.value?.sessions ?? []);
const selected = computed<EventSessionDto | null>(
  () => list.value.find((s) => s.id === selectedId.value) ?? list.value[0] ?? null,
);
const price = computed(() => (event.value ? priceFor(event.value, session.level) : 0));
const fullPrice = computed(() => (event.value ? publicPriceOf(event.value) : 0));
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
const showcase = computed(() => {
  const e = event.value;
  if (!e) return [] as Array<{ key: string; title: string; images: string[] }>;
  const modelPhotos = e.model?.photoUrls?.length
    ? e.model.photoUrls
    : e.model?.portfolioUrl ? [e.model.portfolioUrl] : [];
  return [
    { key: 'model', title: '模特照片', images: modelPhotos },
    { key: 'wardrobe', title: '服装照片', images: e.wardrobeUrls ?? [] },
    { key: 'venue', title: '场地照片', images: e.venueUrls ?? [] },
  ].filter((g) => g.images.length);
});
/** 模特图：作品集图 + 海报里的服装图统一可放大 */
const modelImages = computed(() => {
  const m = event.value?.model;
  if (!m) return [];
  return m.photoUrls?.length ? m.photoUrls : (m.portfolioUrl ? [m.portfolioUrl] : []);
});
/** 历史数据可能存过非 http(s) 链接，渲染前再过一遍白名单，避免 javascript: 伪协议被点击 */
const socialLinks = computed(() =>
  (event.value?.model?.socialAccounts ?? []).map((s) => ({
    ...s,
    safeUrl: /^https?:\/\//i.test(s.url ?? '') ? s.url! : undefined,
  })),
);

function stateOf(s: EventSessionDto): { text: string; ok: boolean } {
  if (s.status !== 'OPEN') return { text: '已关闭', ok: false };
  if (new Date(s.startAt).getTime() <= Date.now()) return { text: '已开始', ok: false };
  if (s.capacityUsed >= s.capacity) return { text: '已满', ok: false };
  return { text: `余 ${s.capacity - s.capacityUsed} 席`, ok: true };
}

onMounted(async () => {
  try {
    event.value = await api.events.detail(id);
    selectedId.value = event.value.sessions?.[0]?.id ?? '';
    availability.value = await api.events.availability(id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  }
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
/** 券后应付；券数少于名额数时，剩余名额按原价 */
const payable = computed(() => Math.max(0, price.value * seats.value - selectedDiscount.value));

function couponText(c: CouponDto): string {
  if (c.type === 'AMOUNT') return `立减 ${yuan(Number(c.amountCent ?? 0))}`;
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
    // 前端展示的是按当前身份预估的价格；真实扣款以服务端逐条 feeCent 为准
    const charged = batch.registrations.reduce((sum, r) => sum + Number(r.feeCent), 0);
    ui.notify(
      `报名成功，共 ${batch.seats} 个名额${charged > 0 ? `，实扣 ${yuan(charged)}` : ''}`,
      'success',
    );
    // 直接去「我的报名」看结果。这里不再刷新本页的 detail/availability：
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
    // 其它错误由 http.onError 统一提示
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
            <p class="mt-0.5 clamp-1 text-sm font-medium text-slate-900">
              {{ event.model?.stageName ?? '待公布' }}<span v-if="event.ratioLabel" class="text-slate-500"> · {{ event.ratioLabel }}</span>
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
        <p class="text-sm font-medium text-amber-800">本场报名尚未开放到你的会员等级</p>
        <p class="mt-1 text-xs leading-relaxed text-amber-700">
          当前仅向「{{ gateLevelLabel }}」开放报名，运营会分阶段放开（SVIP → VIP → 所有人）。请稍后再来，或联系客服了解开放时间。
        </p>
      </div>

      <!-- 价格 + 时段：上提到图区之前。
           移动端原来要滚过整块海报和所有作品图才能看到价格和可选时段，
           而这两块恰好是报名决策的唯一依据，所以放在主信息之后。 -->
      <div v-if="event.prices?.length" class="mt-6">
        <div class="mb-2 flex items-end justify-between">
          <h2 class="text-sm font-semibold text-slate-900">价格</h2>
          <span v-if="session.isMember" class="text-xs text-slate-500">你当前为 {{ labelOf(session.level) }} 会员</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div v-for="p in event.prices" :key="p.level" class="rounded-xl border bg-white p-2 text-center transition sm:p-3"
            :class="p.level === myPriceLevel
              ? 'border-brand bg-brand-50 shadow-sm' : 'border-slate-200 opacity-75'">
            <p class="text-xs" :class="p.level === 'SVIP' ? 'text-gold' : p.level === 'VIP' ? 'text-brand-soft' : 'text-slate-500'">
              {{ p.level === 'PUBLIC' ? '活动价' : `${p.level} 专属` }}
            </p>
            <p class="mt-1 text-sm font-semibold text-slate-900 sm:text-base">{{ yuan(p.priceCent) }}</p>
            <p class="text-xs text-slate-500">/{{ p.unitLabel }}</p>
          </div>
        </div>
        <p v-if="session.isMember && price !== fullPrice" class="mt-2 text-xs text-gold">
          你当前享受会员价，比活动价省 {{ yuan(fullPrice - price) }}
        </p>
        <p v-else-if="!session.isMember" class="mt-2 text-xs text-slate-500">
          普通用户按活动价报名、线下支付（报名后联系客服付款）。
        </p>
      </div>

      <div class="mt-6">
        <div class="mb-2 flex items-end justify-between">
          <h2 class="text-sm font-semibold text-slate-900">选择时段</h2>
          <span class="text-xs text-slate-500">{{ list.length }} 场可选</span>
        </div>
        <div class="space-y-2">
          <button v-for="s in list" :key="s.id" :disabled="!stateOf(s).ok"
            class="flex w-full items-center justify-between rounded-xl border bg-white p-3 text-left transition disabled:opacity-60"
            :class="selectedId === s.id ? 'border-brand ring-2 ring-brand/15' : 'border-slate-200 hover:border-slate-300'"
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

      <!-- 模特 -->
      <div v-if="event.model" class="mt-6">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">模特</h2>
          <button class="shrink-0 text-xs font-medium text-brand hover:underline" @click="modelDialogOpen = true">查看模特资料</button>
        </div>
        <div class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
          <button v-if="event.model.portfolioUrl" class="h-16 w-16 shrink-0 overflow-hidden rounded-xl"
            @click="openLightbox(modelImages, 0)">
            <img :src="event.model.portfolioUrl" :alt="event.model.stageName" class="img-zoom h-full w-full object-cover" />
          </button>
          <div v-else class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-lg font-semibold text-slate-500">
            {{ event.model.stageName.slice(0, 1) }}
          </div>
          <div class="min-w-0">
            <p class="text-sm font-medium text-slate-900">{{ event.model.stageName }}</p>
            <p class="mt-0.5 text-xs text-slate-500">
              {{ event.ratioLabel ?? '模特' }}<span v-if="event.model.heightCm"> · {{ event.model.heightCm }}cm</span>
            </p>
            <!-- 模特社交账号：有主页地址就做成可点链接 -->
            <div v-if="socialLinks.length" class="mt-1.5 flex flex-wrap gap-1">
              <a v-for="s in socialLinks" :key="s.platform + s.handle"
                :href="s.safeUrl" :target="s.safeUrl ? '_blank' : undefined" rel="noopener noreferrer"
                class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                :class="s.safeUrl ? 'hover:bg-brand/10 hover:text-brand' : ''">
                {{ labelOf(s.platform) }} · {{ s.handle }}
              </a>
            </div>
            <p v-if="event.model.portfolioUrl" class="mt-1 text-xs text-brand">点击头像看作品</p>
          </div>
        </div>
      </div>

      <!-- 须知 -->
      <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 class="mb-2 text-sm font-semibold text-slate-900">报名须知</h2>
        <p v-if="event.notice" class="whitespace-pre-line text-xs leading-relaxed text-slate-600">{{ event.notice }}</p>
        <p v-else class="whitespace-pre-line text-xs leading-relaxed text-slate-600">
          开始前 {{ event.refundPolicy.freeCancelBeforeHours }} 小时可免费取消；逾期取消按 {{ Math.round(event.refundPolicy.feeRatio * 100) }}% 收取手续费。
        </p>
        <ul class="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
          <li>· 请按所选时段提前到场，迟到不延长拍摄时间。</li>
          <li>· 会员报名使用积分抵扣（1 积分抵 1 元）；普通用户报名后请联系客服线下付款，运营确认后生效。</li>
          <li v-if="event.allowProxyShoot">· 本场支持代拍，具体安排请联系客服。</li>
          <li v-if="event.privateBookingNote">· {{ event.privateBookingNote }}</li>
        </ul>
      </div>

      <!-- 联系客服：后台配置了客服二维码才展示；移动端长按识别、桌面端微信扫码 -->
      <div v-if="serviceQrUrl" class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
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

      <!-- 吸底报名条（移动端避开底部导航） -->
      <div class="safe-bottom fixed inset-x-0 bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-6px_20px_-12px_rgba(15,23,42,0.25)] backdrop-blur
        md:static md:mt-6 md:border-0 md:bg-transparent md:p-0 md:shadow-none">
        <div class="mx-auto flex max-w-3xl items-center gap-3">
          <div class="min-w-0">
            <p class="text-lg font-semibold text-brand-soft">
              {{ yuan(price) }}<span class="ml-1 text-xs font-normal text-slate-500">/{{ event.prices?.[0]?.unitLabel ?? '场' }}</span>
            </p>
            <p class="clamp-1 text-xs text-slate-500">
              {{ session.isMember ? '积分支付' : '线下支付 · 报名后联系客服' }}
              <span v-if="availability?.reasonCode" class="text-amber-600"> · {{ messageFor(availability.reasonCode) }}</span>
            </p>
          </div>
          <!-- 候补已下线（2026-11-13）：满员直接禁用报名 -->
          <button class="btn-primary ml-auto min-w-[8rem]" :disabled="!availability?.canRegister" @click="openConfirm">
            立即报名
          </button>
        </div>
      </div>
    </template>

    <!-- 二次确认 -->
    <div v-if="confirmOpen && event" class="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      @click.self="confirmOpen = false">
      <div class="fade-up w-full max-w-md rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
        <h3 class="text-lg font-semibold text-slate-900">确认报名</h3>
        <div class="mt-4 space-y-2.5 text-sm">
          <div class="flex justify-between gap-4"><span class="text-slate-500">场次</span><span class="text-right text-slate-900">{{ event.title }}</span></div>
          <div class="flex justify-between gap-4"><span class="text-slate-500">时段</span><span class="text-right text-slate-900">{{ selected?.label }} · {{ selected ? timeRange(selected.startAt, selected.endAt) : '' }}</span></div>
          <div class="flex items-start justify-between gap-4">
            <span class="shrink-0 text-slate-500">报名人数</span>
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
                      {{ couponText(c) }} · 本单可省 {{ yuan(couponDiscount(c)) }}
                      <span v-if="c.minSpendCent > 0"> · 满 {{ yuan(c.minSpendCent) }} 可用</span>
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
                当前只有 {{ usableCoupons.length }} 张可用券，其余 {{ seats - usableCoupons.length }} 个名额按原价。
              </p>
            </template>
          </div>
          <p v-else class="text-xs text-slate-500">本场次不可使用优惠券</p>

          <div class="flex justify-between gap-4"><span class="text-slate-500">原价</span><span class="text-slate-500">{{ yuan(price * seats) }}</span></div>
          <div v-if="selectedDiscount > 0" class="flex justify-between gap-4"><span class="text-slate-500">优惠券抵扣</span><span class="text-emerald-600">-{{ yuan(selectedDiscount) }}</span></div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">合计金额</span>
            <span class="font-semibold text-brand-soft">{{ yuan(payable) }}<span v-if="selectedDiscount === 0" class="ml-1 text-xs font-normal text-slate-500">（{{ yuan(price) }} × {{ seats }} 人）</span></span>
          </div>
          <div class="flex justify-between gap-4"><span class="text-slate-500">支付方式</span><span class="text-right text-slate-900">{{ session.isMember ? `积分支付（报名即扣 ${formatPoints(payable)} 积分）` : '线下支付（联系客服付款）' }}</span></div>
          <div class="flex justify-between gap-4"><span class="text-slate-500">取消规则</span><span class="text-right text-slate-900">开始前 {{ event.refundPolicy.freeCancelBeforeHours }} 小时可退</span></div>
        </div>
        <!-- 时段冲突提示 -->
        <div v-if="conflicts.length" class="mt-3 rounded-lg bg-rose-50 px-3 py-2.5 ring-1 ring-rose-200">
          <p class="text-[13px] font-medium text-rose-700">这段时间你已报名了其它场次</p>
          <ul class="mt-1 space-y-1 text-xs leading-relaxed text-rose-600">
            <li v-for="c in conflicts" :key="c.registrationId">
              {{ c.eventTitle }} · {{ c.sessionLabel }}（{{ timeRange(c.startAt, c.endAt) }}）
            </li>
          </ul>
          <p class="mt-1.5 text-xs text-rose-500">同一时间只能到场一处，请确认是否仍要继续报名。</p>
        </div>

        <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          {{ session.isMember ? '确认后将从积分账户扣除相应积分并占用名额，实际扣减以服务端结算为准。' : '确认后名额即为你保留，请在 1 小时内联系客服完成付款，逾期可能释放名额。' }}
          一次报 {{ seats }} 个名额会生成 {{ seats }} 条独立报名，每位都可单独取消或申请退款。
        </p>
        <div class="mt-5 flex gap-2">
          <button class="btn-ghost flex-1" @click="confirmOpen = false">再想想</button>
          <button class="btn-primary flex-1" :disabled="busy" @click="doSubmit">
            {{ busy ? '提交中…' : conflicts.length ? '仍要报名' : '确认报名' }}
          </button>
        </div>
      </div>
    </div>

    <ModelInfoDialog v-model:open="modelDialogOpen" :model="event?.model ?? null" :can-view-body="session.isMember" @zoom="(imgs, i) => openLightbox(imgs, i)" />
    <ImageLightbox :key="lightboxKey" v-model:open="lightboxOpen" :images="lightboxImages" :start="lightboxIndex" />
  </section>
</template>
