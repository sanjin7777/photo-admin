<script setup lang="ts">
/**
 * 场次管理：列表为主，新增/编辑一律走弹窗。
 * 表单按「基本信息 / 报名时间 / 可见性与价格 / 时段 / 图片 / 须知」分组，每个字段都是 label + 输入框。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { EventDto, EventStatus, EventVisibility, ModelProfileDto, RegistrationDto, SceneDto } from '@photo/shared';
import { eventCreateSchema, eventPatchSchema } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import ImageUploader from '../components/ImageUploader.vue';
import { EVENT_STATUS, REGISTRATION_STATUS, VISIBILITY, metaOf, shortTime, toLocalInput, yuan } from '../utils/labels';
import { emptyPage, loadAllPages } from '../utils/loadAll';
import { DEFAULT_BRAND_TITLE, exportEventPoster } from '../utils/poster';

const ui = useUiStore();
const router = useRouter();
const route = useRoute();

const list = ref<EventDto[]>([]);
const modelOptions = ref<ModelProfileDto[]>([]);
const sceneOptions = ref<SceneDto[]>([]);
/** 场景下拉按场地分组（optgroup），一个场地多个场景 */
const sceneGroups = computed(() => {
  const map = new Map<string, SceneDto[]>();
  for (const s of sceneOptions.value) {
    const key = s.venue || '默认场地';
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  return [...map.entries()].map(([venue, scenes]) => ({ venue, scenes }));
});
/** 当前选中的场景，用于在表单上提示其场地地址 */
const selectedScene = computed(() => sceneOptions.value.find((x) => x.id === form.sceneId) ?? null);
/** 当前选中的模特：指定后「模特照片」只能取该模特照片库中的图 */
const selectedModel = computed(() => modelOptions.value.find((m) => m.id === form.modelId) ?? null);
const loading = ref(true);
const keyword = ref('');
const filterVisibility = ref('');
const filterStatus = ref('');
/** 海报右下角两张二维码：网站码（可空，空则用内置默认图）与客服码；null 表示未配置 */
const qrUrl = ref<string | null>(null);
const siteQrUrl = ref<string | null>(null);
/** 海报左上角标题：null 表示使用内置默认文案 */
const brandTitle = ref<string | null>(null);
const qrDialogOpen = ref(false);
const qrSaving = ref(false);
const qrDraft = ref<string[]>([]);
const siteQrDraft = ref<string[]>([]);
const brandTitleDraft = ref('');
const exportingId = ref<string | null>(null);

/**
 * 场次列表改为服务端分页：场次只增不减，按页拉全量（最多 50×100）迟早会把旧场次挤出可见范围。
 * 筛选条件全部下推 SQL，前端不再对当前页做二次过滤。
 */
const filtered = computed(() => list.value);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

async function load(): Promise<void> {
  loading.value = true;
  try {
    // 模特与场景是下拉选项，数量有限，仍需一次拿全
    const [res, models, scenes] = await Promise.all([
      api.admin.events.list({
        page: page.value,
        pageSize: pageSize.value,
        status: (filterStatus.value || undefined) as EventStatus | undefined,
        visibility: (filterVisibility.value || undefined) as EventVisibility | undefined,
        keyword: keyword.value.trim() || undefined,
      }),
      loadAllPages((p, size) => api.admin.models.list({ page: p, pageSize: size }))
        .catch(() => emptyPage<ModelProfileDto>()),
      api.admin.scenes.options().catch(() => [] as SceneDto[]),
    ]);
    // 页码越界（筛选后总数变少）时回到最后一页重查，避免停在空白页
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (page.value > lastPage) {
      page.value = lastPage;
      return load();
    }
    list.value = res.list;
    total.value = res.total;
    modelOptions.value = models.list ?? [];
    sceneOptions.value = scenes;
    // 列表刷新后展开面板的报名缓存失效，下次展开重新拉取
    regsByEvent.value = {};
    // 海报配置读取失败不阻塞列表：按「未配置」处理，导出时给出占位提示
    try {
      const poster = await api.admin.posterSettings.get();
      qrUrl.value = poster.qrUrl;
      siteQrUrl.value = poster.siteQrUrl;
      brandTitle.value = poster.brandTitle;
    } catch {
      qrUrl.value = null;
      siteQrUrl.value = null;
      brandTitle.value = null;
    }
  } catch {    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
/** 筛选条件变化必须回第 1 页，否则会停在上一次的页码上看到空列表 */
function search(): void {
  page.value = 1;
  void load();
}
function goPage(next: number): void {
  page.value = Math.min(Math.max(1, next), pageCount.value);
  void load();
}
onMounted(async () => {
  await load();
  // 概览的「新建场次」直接带 ?new=1 打开弹窗；打开后清掉参数，避免刷新反复弹出
  if (route.query.new === '1') {
    openCreate();
    void router.replace({ path: route.path });
  }
});

/* ---------------- 弹窗表单 ---------------- */
const dialogOpen = ref(false);
const saving = ref(false);
const editing = ref<EventDto | null>(null);
/** 弹窗顶部的行内错误：比 toast 更容易和表单一起看到，也便于截图反馈 */
const formError = ref('');

function invalid(message: string): void {
  formError.value = message;
  ui.notify(message, 'warning');
}

const emptyForm = () => ({
  title: '',
  subtitle: '',
  venue: '咕咕摄影棚',
  scene: '',
  ratioLabel: '4V1',
  modelId: '',
  sceneId: '',
  visibility: 'PUBLIC' as 'PUBLIC' | 'VIP' | 'SVIP',
  registerMinLevel: 'NONE' as 'NONE' | 'VIP' | 'SVIP',
  openAt: '',
  closeAt: '',
  publicYuan: 189,
  vipYuan: 169,
  svipYuan: 149,
  allowCoupon: true,
  refundFreeHours: 48,
  refundFeeRatio: 0,
  notice: '',
  posters: [] as string[],
  wardrobe: [] as string[],
  venuePhotos: [] as string[],
});

type SessionRow = { id?: string; label: string; startAt: string; endAt: string; capacity: number };
type FormState = ReturnType<typeof emptyForm>;

const form = reactive(emptyForm());
const sessions = ref<SessionRow[]>([]);
/** 编辑态打开弹窗时的表单快照：保存时据此只提交真正变更的字段，未改字段保持库中原值 */
let pristine: { form: FormState; sessions: SessionRow[] } | null = null;

const hasRegistrations = computed(() => (editing.value?.capacityUsed ?? 0) > 0);
const dialogTitle = computed(() => (editing.value ? '编辑场次' : '新建场次'));

/**
 * 最近的一个周日（含今天）的指定时刻。
 * 若算出来的时刻已经过去（只可能是今天且已过该点），自动顺延一周。
 */
function upcomingSundayAt(hour: number, minute: number): Date {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  // getDay(): 0=周日；(7 - day) % 7 得到距最近周日的天数
  d.setDate(d.getDate() + (7 - d.getDay()) % 7);
  if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 7);
  return d;
}

/**
 * 默认三条时段：第一条是「当前周日 15:00–16:00」，
 * 之后每条开始与结束各顺延 10 分钟（减少人工录入）。
 */
function defaultSessions(): Array<{ label: string; startAt: string; endAt: string; capacity: number }> {
  const base = upcomingSundayAt(15, 0);
  return [0, 10, 20].map((offsetMin, i) => {
    const start = new Date(base.getTime() + offsetMin * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    return {
      label: `第${i + 1}场`,
      startAt: toLocalInput(start.toISOString()),
      endAt: toLocalInput(end.toISOString()),
      capacity: 4,
    };
  });
}

function resetForm(): void {
  Object.assign(form, emptyForm());
  sessions.value = defaultSessions();
  // 报名窗口给出可用的默认值：现在开始、首场前 24 小时截止，避免空白必填项卡住新建
  const now = new Date();
  const firstStart = new Date(sessions.value[0]!.startAt);
  const close = new Date(firstStart.getTime() - 24 * 3600_000);
  form.openAt = toLocalInput(now.toISOString());
  form.closeAt = toLocalInput((close.getTime() > now.getTime() ? close : firstStart).toISOString());
}

function openCreate(): void {
  editing.value = null;
  pristine = null;
  formError.value = '';
  resetForm();
  dialogOpen.value = true;
}

function openEdit(e: EventDto): void {
  editing.value = e;
  formError.value = '';
  Object.assign(form, {
    title: e.title,
    subtitle: e.subtitle ?? '',
    venue: e.venue,
    scene: e.scene ?? '',
    ratioLabel: e.ratioLabel ?? '',
    modelId: e.modelId ?? '',
    sceneId: e.sceneId ?? '',
    visibility: e.visibility,
    registerMinLevel: e.registerMinLevel,
    openAt: toLocalInput(e.registrationOpenAt),
    closeAt: toLocalInput(e.registrationCloseAt),
    publicYuan: (e.prices.find((p) => p.level === 'PUBLIC')?.priceCent ?? e.feeCent) / 100,
    vipYuan: (e.prices.find((p) => p.level === 'VIP')?.priceCent ?? e.feeCent) / 100,
    svipYuan: (e.prices.find((p) => p.level === 'SVIP')?.priceCent ?? e.feeCent) / 100,
    allowCoupon: e.allowCoupon,
    refundFreeHours: e.refundPolicy.freeCancelBeforeHours,
    refundFeeRatio: e.refundPolicy.feeRatio,
    notice: e.notice ?? '',
    posters: [...(e.posterUrls?.length ? e.posterUrls : e.coverUrl ? [e.coverUrl] : [])].slice(0, 1),
    wardrobe: [...(e.wardrobeUrls ?? [])],
    venuePhotos: [...(e.venueUrls ?? [])],
  });
  sessions.value = e.sessions.map((s) => ({
    id: s.id,
    label: s.label,
    startAt: toLocalInput(s.startAt),
    endAt: toLocalInput(s.endAt),
    capacity: s.capacity,
  }));
  pristine = {
    form: { ...form, posters: [...form.posters], wardrobe: [...form.wardrobe], venuePhotos: [...form.venuePhotos] },
    sessions: sessions.value.map((s) => ({ ...s })),
  };
  dialogOpen.value = true;
}

/** 追加一条时段：沿用上一条的节奏顺延 10 分钟，仍可手工修改 */
function addSession(): void {
  const last = sessions.value[sessions.value.length - 1];
  const start = last?.startAt ? new Date(last.startAt) : null;
  const end = last?.endAt ? new Date(last.endAt) : null;
  const nextStart = start ? new Date(start.getTime() + 10 * 60_000) : null;
  const nextEnd = end ? new Date(end.getTime() + 10 * 60_000) : null;
  sessions.value.push({
    label: `第${sessions.value.length + 1}场`,
    startAt: nextStart ? toLocalInput(nextStart.toISOString()) : '',
    endAt: nextEnd ? toLocalInput(nextEnd.toISOString()) : '',
    capacity: last?.capacity ?? 4,
  });
}
function removeSession(i: number): void {
  if (sessions.value.length > 1) sessions.value.splice(i, 1);
}

/**
 * 选中场景库条目：自动带入场地名与场地照片，其余字段保持自由文本可改。
 * 选「暂不选择」时不清空已填内容，避免误删运营手工录入的资料。
 */
function onSceneChange(): void {
  const s = sceneOptions.value.find((x) => x.id === form.sceneId);
  if (!s) return;
  form.venue = s.venue || s.name;
  form.scene = s.name;
  form.venuePhotos = [...s.photoUrls];
}

/**
 * 切换模特（仅用户手动改下拉时触发）：
 * 模特照片只能取自该模特照片库，并随机带出一张作为本场模特图（同时是列表封面）。
 * 清空模特不动已选图片，回到自由上传；模特无照片时清空并给出提示。
 */
function onModelChange(): void {
  const m = selectedModel.value;
  if (!m) return;
  const photos = m.photoUrls ?? [];
  form.posters = photos.length ? [photos[Math.floor(Math.random() * photos.length)]] : [];
}

function pickModelPhoto(url: string): void {
  form.posters = [url];
}

/** 随机换一张：尽量避开当前图，只有一张时保持不变 */
function randomModelPhoto(): void {
  const photos = selectedModel.value?.photoUrls ?? [];
  const candidates = photos.length > 1 ? photos.filter((u) => u !== form.posters[0]) : photos;
  if (!candidates.length) return;
  form.posters = [candidates[Math.floor(Math.random() * candidates.length)]];
}

const cent = (y: number) => Math.round(Number(y) * 100);
const iso = (v: string) => new Date(v).toISOString();

/** 由表单状态构造提交载荷。编辑差量比对时对「当前 / 快照」各调用一次，未改字段序列化结果一致即被排除。 */
function buildBase(f: FormState, sess: SessionRow[]) {
  const prices = [
    { level: 'PUBLIC' as const, priceCent: cent(f.publicYuan), unitLabel: '场' },
    { level: 'VIP' as const, priceCent: cent(f.vipYuan), unitLabel: '场' },
    { level: 'SVIP' as const, priceCent: cent(f.svipYuan), unitLabel: '场' },
  ];
  return {
    title: f.title.trim(),
    subtitle: f.subtitle.trim() || null,
    venue: f.venue.trim(),
    scene: f.scene.trim() || null,
    notice: f.notice.trim() || null,
    ratioLabel: f.ratioLabel.trim() || null,
    modelId: f.modelId.trim() || null,
    sceneId: f.sceneId.trim() || null,
    visibility: f.visibility,
    registerMinLevel: f.registerMinLevel,
    allowCoupon: f.allowCoupon,
    refundPolicy: { freeCancelBeforeHours: Number(f.refundFreeHours), feeRatio: Number(f.refundFeeRatio) },
    registrationOpenAt: iso(f.openAt),
    registrationCloseAt: iso(f.closeAt),
    coverUrl: f.posters[0] ?? null,
    // 模特图只保留 1 张：既是列表封面，也是导出海报底图
    posterUrls: f.posters.slice(0, 1),
    wardrobeUrls: f.wardrobe,
    venueUrls: f.venuePhotos,
    sessions: sess.map((s) => ({
      // 带 id = 更新已有排期；不带 = 新增。缺失的已有时段由服务端删除（有报名会被拒绝）
      ...(s.id ? { id: s.id } : {}),
      label: s.label.trim() || '场次',
      startAt: iso(s.startAt),
      endAt: iso(s.endAt),
      capacity: Number(s.capacity) || 1,
    })),
    prices,
  };
}

async function save(): Promise<void> {
  formError.value = '';
  if (!form.title.trim()) { invalid('请填写场次标题'); return; }
  if (!form.venue.trim()) { invalid('请填写场地'); return; }
  if (!form.openAt || !form.closeAt) { invalid('请选择报名开始与截止时间'); return; }
  if (!sessions.value.length) { invalid('至少需要一个时段'); return; }
  if (sessions.value.some((s) => !s.startAt || !s.endAt)) { invalid('每个时段都要填开始与结束时间'); return; }

  const base = buildBase(form, sessions.value);

  saving.value = true;
  try {
    if (editing.value) {
      // 只提交真正变更的字段：退款规则、优惠券开关等未改字段保持库中原值，杜绝「打开即覆盖」
      const original = pristine ? buildBase(pristine.form, pristine.sessions) : base;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(base)) {
        if (JSON.stringify(value) !== JSON.stringify((original as Record<string, unknown>)[key])) patch[key] = value;
      }
      // 已有报名也可以调整排期：服务端会拒绝删除有报名的时段、拒绝把容量压到已报名人数以下
      if (!Object.keys(patch).length) { ui.notify('未检测到修改', 'info'); return; }
      const parsed = eventPatchSchema.safeParse(patch);
      if (!parsed.success) { invalid(parsed.error.issues[0]?.message ?? '表单校验未通过'); return; }
      await api.admin.events.update(editing.value.id, parsed.data);
      ui.notify('场次已更新', 'success');
    } else {
      const parsed = eventCreateSchema.safeParse(base);
      if (!parsed.success) { invalid(parsed.error.issues[0]?.message ?? '表单校验未通过'); return; }
      await api.admin.events.create(parsed.data);
      ui.notify('场次已保存为草稿，确认后在列表里点「发布」开放报名', 'success');
    }
    dialogOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

async function cancelEvent(e: EventDto): Promise<void> {
  try {
    await ui.confirm(`确认取消「${e.title}」？已确认的报名将全额退款（会员回充积分、非会员走线下退款），历史遗留的候补记录会置为已失效。`);
  } catch { return; }
  try {
    await api.admin.events.cancel(e.id, { reason: '运营在后台取消' });
    ui.notify('场次已取消', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/** 恢复已取消的场次：服务端按报名窗口决定回到「报名中」还是「已发布」 */
async function restoreEvent(e: EventDto): Promise<void> {
  try {
    await ui.confirm(`恢复「${e.title}」？恢复后按当前报名时间判断回到「报名中」或「已发布」；已被取消退款的报名不会自动恢复。`);
  } catch { return; }
  try {
    await api.admin.events.restore(e.id);
    ui.notify('场次已恢复', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/** 草稿发布：发布后进入「报名中」，前台立即可见，报名窗口内可报名 */
async function publishEvent(e: EventDto): Promise<void> {
  try {
    await ui.confirm(`发布「${e.title}」？发布后前台立即可见，报名窗口内用户可以报名。`);
  } catch { return; }
  try {
    await api.admin.events.publish(e.id);
    ui.notify('场次已发布', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/* ---------------- 行内报名门槛：列表直接改，无需打开编辑弹窗 ---------------- */
const gateSavingId = ref<string | null>(null);
const GATE_LABEL: Record<'NONE' | 'VIP' | 'SVIP', string> = {
  NONE: '所有人（含非会员）', VIP: 'VIP 及以上', SVIP: '仅 SVIP',
};
/** 乐观更新：先改行内显示，失败再回滚到原值，避免原生 select 异步回填错位 */
async function setGate(e: EventDto, level: 'NONE' | 'VIP' | 'SVIP'): Promise<void> {
  const prev = e.registerMinLevel;
  if (prev === level) return;
  e.registerMinLevel = level;
  gateSavingId.value = e.id;
  try {
    await api.admin.events.update(e.id, { registerMinLevel: level });
    ui.notify(`「${e.title}」报名门槛已改为 ${GATE_LABEL[level]}`, 'success');
  } catch {
    e.registerMinLevel = prev;
  } finally {
    gateSavingId.value = null;
  }
}

/** 从场次行进入报名管理：只加载该场次的报名 */
function goRegistrations(e: EventDto): void {
  void router.push({ path: '/registrations', query: { eventId: e.id, title: e.title } });
}

/* ---------------- 时段名额 / 名单弹窗 ---------------- */
const expandedId = ref<string | null>(null);
const seatsOpen = ref(false);
const regsLoadingId = ref<string | null>(null);
const regsByEvent = ref<Record<string, RegistrationDto[]>>({});
const ACTIVE_REG_STATUSES = ['WAITLISTED', 'OFFERED', 'CONFIRMED', 'CHECKED_IN'];

/** 点F：名额 / 名单改为弹窗展示，不再在列表下方内嵌展开挤占版面 */
async function openSeats(e: EventDto): Promise<void> {
  expandedId.value = e.id;
  seatsOpen.value = true;
  if (regsByEvent.value[e.id]) return;
  regsLoadingId.value = e.id;
  try {
    const res = await loadAllPages((page, pageSize) =>
      api.admin.registrations.list({ page, pageSize, eventId: e.id }),
    );
    regsByEvent.value = { ...regsByEvent.value, [e.id]: res.list };
  } catch {
    // 统一错误提示
  } finally {
    regsLoadingId.value = null;
  }
}

/** 该时段的有效报名（不含已取消/已退款），用于名单 chips */
function regsOf(e: EventDto, s: EventDto['sessions'][number]): RegistrationDto[] {
  return (regsByEvent.value[e.id] ?? []).filter(
    (r) => r.sessionId === s.id && ACTIVE_REG_STATUSES.includes(r.status),
  );
}

function sessionPct(s: EventDto['sessions'][number]): number {
  return s.capacity > 0 ? Math.min(100, Math.round((s.capacityUsed / s.capacity) * 100)) : 0;
}

const expandedEvent = computed(() => list.value.find((e) => e.id === expandedId.value) ?? null);
const seatsTitle = computed(() => (expandedEvent.value ? `「${expandedEvent.value.title}」时段名额与名单` : '时段名额与名单'));

function goSessionRegistrations(e: EventDto, s: EventDto['sessions'][number]): void {
  void router.push({ path: '/registrations', query: { eventId: e.id, sessionId: s.id, title: e.title } });
}

function coverOf(e: EventDto): string {
  return e.coverUrl ?? e.posterUrls?.[0] ?? '';
}

/** 封面地址失效时隐藏图片，露出底下的「无图」占位，避免破图图标 */
function hideBroken(img: Event): void {
  (img.target as HTMLImageElement).style.display = 'none';
}

/** 导出该场次海报：底图 + 信息叠加，直接下载 PNG（1080×1620） */
async function exportPoster(e: EventDto): Promise<void> {
  if (exportingId.value) return;
  exportingId.value = e.id;
  try {
    await exportEventPoster(e, qrUrl.value, siteQrUrl.value, brandTitle.value);
    ui.notify('海报已导出', 'success');
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : '导出失败，请重试', 'error');
  } finally {
    exportingId.value = null;
  }
}

function openQrDialog(): void {
  qrDraft.value = qrUrl.value ? [qrUrl.value] : [];
  siteQrDraft.value = siteQrUrl.value ? [siteQrUrl.value] : [];
  brandTitleDraft.value = brandTitle.value ?? '';
  qrDialogOpen.value = true;
}

async function saveQr(): Promise<void> {
  qrSaving.value = true;
  try {
    const res = await api.admin.posterSettings.update({
      qrUrl: qrDraft.value[0] ?? null,
      siteQrUrl: siteQrDraft.value[0] ?? null,
      brandTitle: brandTitleDraft.value.trim() || null,
    });
    qrUrl.value = res.qrUrl;
    siteQrUrl.value = res.siteQrUrl;
    brandTitle.value = res.brandTitle;
    qrDialogOpen.value = false;
    ui.notify(res.qrUrl || res.siteQrUrl || res.brandTitle ? '海报配置已保存' : '已清除海报配置', 'success');
  } catch {
    // 统一错误提示
  } finally {
    qrSaving.value = false;
  }
}
</script>

<template>
  <section>
    <!-- 页头 -->
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">场次管理</h1>
        <p class="mt-1 text-sm text-slate-500">一场活动可包含多个时段，容量与价格以时段为准；新建先存为草稿，点「发布」后前台可见。</p>
      </div>
      <div class="flex items-center gap-2">
        <el-button @click="openQrDialog">海报二维码</el-button>
        <el-button type="primary" @click="openCreate">+ 新建场次</el-button>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <el-input v-model="keyword" placeholder="搜索标题或场地" clearable class="!w-56" @keyup.enter="search" />
      <el-select v-model="filterVisibility" placeholder="全部可见性" clearable class="!w-36" @change="search">
        <el-option label="公开" value="PUBLIC" />
        <el-option label="VIP" value="VIP" />
        <el-option label="SVIP" value="SVIP" />
      </el-select>
      <el-select v-model="filterStatus" placeholder="全部状态" clearable class="!w-36" @change="search">
        <el-option v-for="(m, key) in EVENT_STATUS" :key="key" :label="m.label" :value="key" />
      </el-select>
      <el-button size="small" @click="search">查询</el-button>
      <span class="ml-auto text-xs text-slate-500">共 {{ total }} 条 · 第 {{ page }} / {{ pageCount }} 页</span>
    </div>

    <!-- 列表 -->
    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table class="hidden w-full text-left text-sm md:table">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">场次</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">可见性</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium" title="此刻允许报名的最低等级，可在列表直接改；与可见性独立">报名门槛</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">时段</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">容量</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">公开价</th>
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">状态</th>
            <th class="whitespace-nowrap px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in filtered" :key="e.id" class="border-t border-slate-100 hover:bg-slate-50/60">
            <td class="px-3 py-2.5">
              <div class="flex items-center gap-2.5">
                <div class="relative h-11 w-16 shrink-0 overflow-hidden rounded-md bg-slate-100">
                  <span class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">无图</span>
                  <img v-if="coverOf(e)" :src="coverOf(e)" alt="" class="absolute inset-0 h-full w-full object-cover" @error="hideBroken" />
                </div>
                <div class="min-w-0">
                  <p class="clamp-1 font-medium text-slate-900" :title="e.title">{{ e.title }}</p>
                  <p class="clamp-1 mt-0.5 text-xs text-slate-500">{{ e.venue }}<span v-if="e.scene"> · {{ e.scene }}</span></p>
                </div>
              </div>
            </td>
            <td class="px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(VISIBILITY, e.visibility).cls">
                {{ metaOf(VISIBILITY, e.visibility).label }}
              </span>
            </td>
            <td class="px-3 py-2.5">
              <select :value="e.registerMinLevel" :disabled="gateSavingId === e.id"
                class="rounded-lg border px-2 py-1 text-xs outline-none focus:border-blue-500 disabled:opacity-50"
                :class="e.registerMinLevel === 'SVIP' ? 'border-amber-300 bg-amber-50 text-amber-700' : e.registerMinLevel === 'VIP' ? 'border-rose-200 bg-rose-50 text-rose-600' : 'border-slate-300 bg-white text-slate-600'"
                @change="setGate(e, ($event.target as HTMLSelectElement).value as 'NONE' | 'VIP' | 'SVIP')">
                <option value="NONE">所有人</option>
                <option value="VIP">VIP 及以上</option>
                <option value="SVIP">仅 SVIP</option>
              </select>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 text-slate-600">
              {{ e.sessions.length }} 场
              <p class="text-xs text-slate-500">{{ shortTime(e.sessions[0]?.startAt) }}</p>
            </td>
            <td class="px-3 py-2.5 text-slate-600">{{ e.capacityUsed }}/{{ e.capacity }}</td>
            <td class="px-3 py-2.5 font-medium text-slate-900">{{ yuan(e.feeCent) }}</td>
            <td class="whitespace-nowrap px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(EVENT_STATUS, e.status).cls">
                {{ metaOf(EVENT_STATUS, e.status).label }}
              </span>
            </td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap">
              <el-button size="small" :type="seatsOpen && expandedId === e.id ? 'primary' : 'default'" @click="openSeats(e)">名额/名单</el-button>
              <el-button size="small" @click="goRegistrations(e)">报名名单</el-button>
              <el-button size="small" @click="openEdit(e)">编辑</el-button>
              <el-button size="small" :loading="exportingId === e.id" @click="exportPoster(e)">导出海报</el-button>
              <el-button v-if="e.status === 'DRAFT'" size="small" type="primary" @click="publishEvent(e)">发布</el-button>
              <el-button v-if="e.status === 'CANCELLED'" size="small" type="primary" @click="restoreEvent(e)">恢复</el-button>
              <el-button v-else-if="e.status !== 'DRAFT'" size="small" text type="danger" @click="cancelEvent(e)">取消</el-button>
            </td>
          </tr>
          <tr v-if="!loading && !filtered.length">
            <td colspan="8" class="px-3 py-14 text-center">
              <p class="text-sm text-slate-600">还没有场次</p>
              <p class="mt-1 text-xs text-slate-500">点右上角「+ 新建场次」开始</p>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 移动端卡片 -->
      <div class="divide-y divide-slate-100 md:hidden">
        <div v-for="e in filtered" :key="e.id" class="flex gap-3 p-3">
          <div class="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100">
            <span class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">无图</span>
            <img v-if="coverOf(e)" :src="coverOf(e)" alt="" class="absolute inset-0 h-full w-full object-cover" @error="hideBroken" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="clamp-1 font-medium text-slate-900">{{ e.title }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ e.sessions.length }} 场 · {{ e.capacityUsed }}/{{ e.capacity }} 人</p>
            <div class="mt-1.5 flex items-center gap-1.5">
              <span class="rounded-full px-1.5 py-0.5 text-[11px]" :class="metaOf(VISIBILITY, e.visibility).cls">{{ metaOf(VISIBILITY, e.visibility).label }}</span>
              <span class="rounded-full px-1.5 py-0.5 text-[11px]" :class="metaOf(EVENT_STATUS, e.status).cls">{{ metaOf(EVENT_STATUS, e.status).label }}</span>
              <span class="text-xs font-medium text-slate-900">{{ yuan(e.feeCent) }}</span>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <span class="shrink-0 text-xs text-slate-500">报名门槛</span>
              <select :value="e.registerMinLevel" :disabled="gateSavingId === e.id"
                class="min-w-0 flex-1 rounded-lg border px-2 py-1 text-xs outline-none focus:border-blue-500 disabled:opacity-50"
                :class="e.registerMinLevel === 'SVIP' ? 'border-amber-300 bg-amber-50 text-amber-700' : e.registerMinLevel === 'VIP' ? 'border-rose-200 bg-rose-50 text-rose-600' : 'border-slate-300 bg-white text-slate-600'"
                @change="setGate(e, ($event.target as HTMLSelectElement).value as 'NONE' | 'VIP' | 'SVIP')">
                <option value="NONE">所有人（含非会员）</option>
                <option value="VIP">VIP 及以上</option>
                <option value="SVIP">仅 SVIP</option>
              </select>
            </div>
            <div class="mt-2 flex flex-wrap gap-2">
              <el-button size="small" :type="seatsOpen && expandedId === e.id ? 'primary' : 'default'" @click="openSeats(e)">名额/名单</el-button>
              <el-button size="small" @click="goRegistrations(e)">报名名单</el-button>
              <el-button size="small" @click="openEdit(e)">编辑</el-button>
              <el-button size="small" :loading="exportingId === e.id" @click="exportPoster(e)">导出海报</el-button>
              <el-button v-if="e.status === 'DRAFT'" size="small" type="primary" @click="publishEvent(e)">发布</el-button>
              <el-button v-if="e.status === 'CANCELLED'" size="small" type="primary" @click="restoreEvent(e)">恢复</el-button>
              <el-button v-else-if="e.status !== 'DRAFT'" size="small" text type="danger" @click="cancelEvent(e)">取消</el-button>
            </div>
          </div>
        </div>
        <div v-if="!loading && !filtered.length" class="px-3 py-12 text-center text-sm text-slate-500">还没有场次</div>
      </div>

      <div v-if="pageCount > 1" class="flex items-center justify-end gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
        <el-button size="small" :disabled="page <= 1" @click="goPage(page - 1)">上一页</el-button>
        <span>第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 条</span>
        <el-button size="small" :disabled="page >= pageCount" @click="goPage(page + 1)">下一页</el-button>
      </div>
    </div>

    <!-- 时段名额 / 名单弹窗（点F）：哪个时段已满、还差几人、报了谁，一眼可见，且不挤占列表版面 -->
    <el-dialog v-model="seatsOpen" :title="seatsTitle" width="min(820px, 94vw)" top="6vh" @closed="expandedId = null">
      <div class="max-h-[70vh] overflow-y-auto pr-1">
        <template v-if="expandedEvent">
          <div v-if="regsLoadingId === expandedEvent.id" class="py-6 text-center text-xs text-slate-500">加载报名中…</div>
          <div v-else class="grid gap-3 lg:grid-cols-2">
            <div v-for="s in expandedEvent.sessions" :key="s.id" class="rounded-lg border border-slate-200 p-3">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm font-medium text-slate-800">
                  {{ s.label }}
                  <span class="ml-1 text-xs font-normal text-slate-500">{{ shortTime(s.startAt) }}</span>
                </p>
                <span
                  class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs"
                  :class="s.capacityUsed >= s.capacity ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'"
                >
                  {{ s.capacityUsed >= s.capacity ? '已满' : `余 ${s.capacity - s.capacityUsed}` }}
                </span>
              </div>
              <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  class="h-full rounded-full"
                  :class="s.capacityUsed >= s.capacity ? 'bg-rose-500' : 'bg-blue-500'"
                  :style="{ width: `${sessionPct(s)}%` }"
                ></div>
              </div>
              <p class="mt-1 text-xs text-slate-500">{{ s.capacityUsed }}/{{ s.capacity }} 人</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="r in regsOf(expandedEvent, s)"
                  :key="r.id"
                  class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                  :title="`${metaOf(REGISTRATION_STATUS, r.status).label} · ${shortTime(r.createdAt)}`"
                >
                  {{ r.userWechatId ?? `#${r.userId}` }}
                </span>
                <span v-if="!regsOf(expandedEvent, s).length" class="text-xs text-slate-500">暂无报名</span>
              </div>
              <div class="mt-2 text-right">
                <el-button size="small" @click="goSessionRegistrations(expandedEvent, s)">查看名单</el-button>
              </div>
            </div>
          </div>
        </template>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <el-button @click="seatsOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog v-model="dialogOpen" :title="dialogTitle" width="min(800px, 94vw)" top="6vh" destroy-on-close>
      <div class="max-h-[68vh] space-y-4 overflow-y-auto pr-1">
        <p v-if="formError" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {{ formError }}
        </p>
        <!-- 基本信息 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">基本信息</h4>
          <label class="mb-3 block">
            <span class="mb-1 block text-xs font-medium text-slate-600">从场景库选择（可选）</span>
            <select v-model="form.sceneId" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" @change="onSceneChange">
              <option value="">暂不选择 / 手动填写</option>
              <optgroup v-for="g in sceneGroups" :key="g.venue" :label="g.venue">
                <option v-for="s in g.scenes" :key="s.id" :value="s.id">{{ s.name }}</option>
              </optgroup>
            </select>
            <span class="mt-1 block text-xs text-slate-500">按场地分组，选择后自动填入场地名、场景名与场地照片，仍可手动修改；场景库在「场景管理」里维护。</span>
            <span v-if="selectedScene?.address" class="mt-1 block text-xs text-slate-500">场地地址：{{ selectedScene.address }}</span>
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">场次标题 <i class="text-rose-500">*</i></span>
              <input v-model="form.title" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：猫爪社摄影会·犬了个牙" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">副标题</span>
              <input v-model="form.subtitle" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：仪玄OL" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">场地 <i class="text-rose-500">*</i></span>
              <input v-model="form.venue" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：咕咕摄影棚" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">场景</span>
              <input v-model="form.scene" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：办公室景" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">模特</span>
              <select v-model="form.modelId" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" @change="onModelChange">
                <option value="">暂不指定</option>
                <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.stageName }}</option>
              </select>
              <span class="mt-1 block text-xs text-slate-500">在「模特管理」里建档后可从下拉直接选；选定后下方模特照片只能取自该模特照片库</span>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">人数比</span>
              <input v-model="form.ratioLabel" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：4V1" />
            </label>
          </div>
        </section>

        <!-- 报名时间 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">报名时间</h4>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">报名开始 <i class="text-rose-500">*</i></span>
              <input v-model="form.openAt" type="datetime-local" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">报名截止 <i class="text-rose-500">*</i></span>
              <input v-model="form.closeAt" type="datetime-local" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
          </div>
        </section>

        <!-- 可见性与价格 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">可见性与价格</h4>
          <div class="grid gap-3 sm:grid-cols-4">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">可见性</span>
              <select v-model="form.visibility" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                <option value="PUBLIC">公开</option>
                <option value="VIP">仅 VIP</option>
                <option value="SVIP">仅 SVIP</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">公开价（元）</span>
              <input v-model.number="form.publicYuan" type="number" min="0" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">VIP 价（元）</span>
              <input v-model.number="form.vipYuan" type="number" min="0" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">SVIP 价（元）</span>
              <input v-model.number="form.svipYuan" type="number" min="0" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
          </div>
          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium text-slate-600">当前可报名等级</span>
            <select v-model="form.registerMinLevel" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 sm:w-64">
              <option value="NONE">所有人（含非会员）</option>
              <option value="VIP">VIP 及以上</option>
              <option value="SVIP">仅 SVIP</option>
            </select>
            <span class="mt-1 block text-xs text-slate-500">人工分阶段放开：先「仅 SVIP」，SVIP 报满后改「VIP 及以上」，最后改「所有人」。与「可见性」独立——能看到不代表此刻能报名。</span>
          </label>
          <p v-if="hasRegistrations" class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            该场次已有 {{ editing?.capacityUsed }} 人报名：可以改时间、加场、改价；有报名的时段不能删除，容量也不能小于已报名人数。
          </p>
          <label class="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input v-model="form.allowCoupon" type="checkbox" class="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand/30" />
            <span>
              允许报名时使用优惠券
              <span class="mt-0.5 block text-xs text-slate-500">关闭后本场新报名不能带券；已产生的报名与退款不受影响。</span>
            </span>
          </label>
        </section>

        <!-- 候补已下线（2026-11-13）：满员即不可报名，故此处只有退款规则，没有候补开关 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">退款规则</h4>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">免费取消提前量（小时）</span>
              <input v-model.number="form.refundFreeHours" type="number" min="0" max="720" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              <span class="mt-1 block text-xs text-slate-500">开始前 N 小时内取消将收取手续费</span>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">退款手续费率（0–1）</span>
              <input v-model.number="form.refundFeeRatio" type="number" min="0" max="1" step="0.01" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              <span class="mt-1 block text-xs text-slate-500">0.1 表示扣除 10%；0 表示全额退款</span>
            </label>
          </div>
        </section>

        <!-- 时段 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <div class="mb-3 flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">时段</h4>
            <el-button size="small" @click="addSession">+ 添加时段</el-button>
          </div>
          <div class="space-y-2">
            <div v-for="(s, i) in sessions" :key="i"
              class="grid grid-cols-2 items-end gap-2 rounded-lg bg-slate-50 p-2.5 sm:grid-cols-12">
              <label class="col-span-2 block sm:col-span-2">
                <span class="mb-1 block text-xs text-slate-500">名称</span>
                <input v-model="s.label" class="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" placeholder="第一场" />
              </label>
              <label class="col-span-2 block sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">开始</span>
                <input v-model="s.startAt" type="datetime-local" class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs" />
              </label>
              <label class="col-span-2 block sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">结束</span>
                <input v-model="s.endAt" type="datetime-local" class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs" />
              </label>
              <label class="col-span-2 block sm:col-span-2">
                <span class="mb-1 block text-xs text-slate-500">容量</span>
                <input v-model.number="s.capacity" type="number" min="1" class="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <div class="col-span-2 flex justify-end sm:col-span-2">
                <el-button size="small" text type="danger" :disabled="sessions.length <= 1" @click="removeSession(i)">删除</el-button>
              </div>
            </div>
          </div>
        </section>

        <!-- 图片 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">图片</h4>
          <div class="space-y-4">
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-600">模特照片</p>

              <!-- 已指定模特：来源锁定为该模特照片库，切换模特时自动随机带出一张 -->
              <template v-if="selectedModel">
                <div v-if="selectedModel.photoUrls.length" class="space-y-2">
                  <div class="flex flex-wrap items-start gap-3">
                    <div class="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                      <img v-if="form.posters[0]" :src="form.posters[0]" alt="" class="h-full w-full object-cover" />
                      <span v-else class="flex h-full items-center justify-center px-2 text-center text-xs text-slate-500">未选择</span>
                    </div>
                    <div class="min-w-0 text-xs leading-relaxed text-slate-500">
                      <p>已指定模特 <span class="font-medium text-slate-700">{{ selectedModel.stageName }}</span>，只能从 TA 的照片库里选 1 张。</p>
                      <p v-if="form.posters[0]" class="text-slate-500">当前这张就是列表封面与导出海报主图。</p>
                      <button type="button" class="mt-1 text-blue-600 hover:underline" @click="randomModelPhoto">随机换一张</button>
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-for="url in selectedModel.photoUrls" :key="url" type="button"
                      class="relative h-16 w-16 overflow-hidden rounded-lg border-2 transition"
                      :class="form.posters[0] === url ? 'border-blue-500' : 'border-slate-200 hover:border-slate-400'"
                      @click="pickModelPhoto(url)">
                      <img :src="url" alt="" class="h-full w-full object-cover" />
                      <span v-if="form.posters[0] === url"
                        class="absolute inset-x-0 bottom-0 bg-blue-500/85 py-0.5 text-center text-[11px] text-white">已选</span>
                    </button>
                  </div>
                </div>
                <p v-else class="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                  该模特还没有上传照片。请先到「模特管理」补充，或把模特改为「暂不指定」后自由上传。
                </p>
                <p class="mt-1.5 text-xs text-slate-500">照片来自「模特管理」的模特照片库；换模特会重新随机一张。</p>
              </template>

              <!-- 未指定模特：自由上传 1 张 -->
              <template v-else>
                <ImageUploader v-model="form.posters" :max="1" cover-hint="" />
                <p class="mt-1 text-xs text-slate-500">未指定模特时可自由上传 1 张；在上方「模特」里选定模特后，会自动改用该模特照片库并随机带出一张。</p>
              </template>
            </div>
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-600">当日服装</p>
              <ImageUploader v-model="form.wardrobe" :max="9" cover-hint="" />
            </div>
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-600">场地照片</p>
              <ImageUploader v-model="form.venuePhotos" :max="9" cover-hint="" />
            </div>
          </div>
        </section>

        <!-- 须知 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">报名须知</h4>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-slate-600">须知内容（每行一条）</span>
            <textarea v-model="form.notice" rows="4" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              placeholder="例：&#10;1. 请提前 10 分钟到场签到&#10;2. 开始前 48 小时可免费取消" />
          </label>
        </section>
      </div>

      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">{{ editing ? '保存修改' : '创建场次' }}</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 海报配置：标题与两张二维码对所有场次统一生效 -->
    <el-dialog v-model="qrDialogOpen" title="海报配置" width="min(520px, 94vw)" destroy-on-close>
      <p class="mb-3 text-sm text-slate-500">
        标题与两张码统一用于导出的场次海报；客服码同时展示在前台报名页。留空保存即恢复默认 / 清除。
      </p>
      <label class="mb-4 block">
        <span class="mb-1.5 block text-xs font-medium text-slate-600">左上角标题</span>
        <input
          v-model="brandTitleDraft"
          maxlength="32"
          class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          :placeholder="DEFAULT_BRAND_TITLE"
        />
        <span class="mt-1 block text-xs text-slate-500">留空使用默认标题：{{ DEFAULT_BRAND_TITLE }}</span>
      </label>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <p class="mb-1.5 text-xs font-medium text-slate-600">网站二维码（上方）</p>
          <ImageUploader v-model="siteQrDraft" :max="1" cover-hint="" />
          <p class="mt-1 text-xs text-slate-500">未上传时使用内置默认图</p>
        </div>
        <div>
          <p class="mb-1.5 text-xs font-medium text-slate-600">客服二维码（下方）</p>
          <ImageUploader v-model="qrDraft" :max="1" cover-hint="" />
          <p class="mt-1 text-xs text-slate-500">未上传时海报画占位框</p>
        </div>
      </div>
      <p class="mt-2 text-xs text-slate-500">建议使用正方形、四周留白的二维码图片，扫码识别率更稳。</p>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <el-button @click="qrDialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="qrSaving" @click="saveQr">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
