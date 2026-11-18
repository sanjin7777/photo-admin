<script setup lang="ts">
/**
 * 场次管理：列表为主，新增/编辑一律走弹窗。
 * 表单按「基本信息 / 报名时间 / 可见性与价格 / 时段 / 图片 / 须知」分组，每个字段都是 label + 输入框。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { EventDto, EventStatus, EventVisibility, ModelProfileDto, PosterLayoutDto, RegistrationDto, SceneDto } from '@photo/shared';
import { eventCreateSchema, eventPatchSchema } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import ImageUploader from '../components/ImageUploader.vue';
import PosterDesigner from '../components/PosterDesigner.vue';
import { EVENT_STATUS, REGISTRATION_STATUS, VISIBILITY, metaOf, personLabel, shortTime, toLocalInput, points } from '../utils/labels';
import { emptyPage, loadAllPages } from '../utils/loadAll';
import { DEFAULT_BRAND_TITLE, POSTER_STYLE_META, POSTER_STYLES, exportEventPoster, type PosterStyle } from '../utils/poster';
import AppPagination from '../components/AppPagination.vue';

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
/**
 * 模特不再区分主副：每一位都能各自选照片与服装。
 * 「第一位」只额外承担列表封面的角色（见 buildBase 的 coverUrl / posterUrls）。
 */
const loading = ref(true);
const keyword = ref('');
const filterVisibility = ref('');
const filterStatus = ref('');
/** 海报右下角两张二维码：网站码（可空，空则用内置默认图）与客服码；null 表示未配置 */
const qrUrl = ref<string | null>(null);
const siteQrUrl = ref<string | null>(null);
/** 海报左上角标题：null 表示使用内置默认文案 */
const brandTitle = ref<string | null>(null);
/** 设计器保存的自定义版式；null 表示未自定义，导出时按所选预设渲染 */
const savedLayout = ref<PosterLayoutDto | null>(null);
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
      savedLayout.value = poster.layout;
    } catch {
      qrUrl.value = null;
      siteQrUrl.value = null;
      brandTitle.value = null;
      savedLayout.value = null;
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
/** 分页组件回调（页码已由组件保证合法） */
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
  modelIds: [] as string[],
  sceneId: '',
  visibility: 'PUBLIC' as 'PUBLIC' | 'VIP' | 'SVIP',
  registerMinLevel: 'NONE' as 'NONE' | 'VIP' | 'SVIP',
  openAt: '',
  closeAt: '',
  publicYuan: 189,
  vipYuan: 169,
  svipYuan: 149,
  allowCoupon: true,
  allowProxyShoot: false,
  refundFreeHours: 48,
  refundFeeRatio: 0,
  notice: '',
  posters: [] as string[],
  /** 未指定模特时整场共用的一组服装图（有模特时按模特分开填，见 modelWardrobes） */
  wardrobeShared: [] as string[],
  /**
   * 每位模特各自的当日服装图，与 `modelIds` 按下标一一对应。
   */
  modelWardrobes: [] as string[][],
  /** 每位模特各自的本场照片，与 `modelIds` 按下标一一对应 */
  modelPhotos: [] as string[][],
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

/** 每场默认时长 */
const SESSION_MINUTES = 60;
/** 场间休息（上一场结束后隔多久开始下一场） */
const SESSION_BREAK_MINUTES = 10;

/**
 * 默认三条时段：第一场「最近周日 15:00–16:00」，
 * 之后每场在**上一场结束后休息 10 分钟**再开始（15:00 / 16:10 / 17:20），
 * 不是首尾各顺延 10 分钟——那样三场会互相重叠。
 */
function defaultSessions(): Array<{ label: string; startAt: string; endAt: string; capacity: number }> {
  const base = upcomingSundayAt(15, 0);
  const stepMs = (SESSION_MINUTES + SESSION_BREAK_MINUTES) * 60_000;
  return [0, 1, 2].map((i) => {
    const start = new Date(base.getTime() + i * stepMs);
    const end = new Date(start.getTime() + SESSION_MINUTES * 60_000);
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
    modelIds: [...(e.models?.length ? e.models.map((m) => m.id) : (e.modelId ? [e.modelId] : []))],
    sceneId: e.sceneId ?? '',
    visibility: e.visibility,
    registerMinLevel: e.registerMinLevel,
    openAt: toLocalInput(e.registrationOpenAt),
    closeAt: toLocalInput(e.registrationCloseAt),
    publicYuan: (e.prices.find((p) => p.level === 'PUBLIC')?.priceCent ?? e.feeCent) / 100,
    vipYuan: (e.prices.find((p) => p.level === 'VIP')?.priceCent ?? e.feeCent) / 100,
    svipYuan: (e.prices.find((p) => p.level === 'SVIP')?.priceCent ?? e.feeCent) / 100,
    allowCoupon: e.allowCoupon,
    allowProxyShoot: e.allowProxyShoot,
    refundFreeHours: e.refundPolicy.freeCancelBeforeHours,
    refundFeeRatio: e.refundPolicy.feeRatio,
    notice: e.notice ?? '',
    posters: [...(e.posterUrls?.length ? e.posterUrls : e.coverUrl ? [e.coverUrl] : [])].slice(0, 1),
    wardrobeShared: [...(e.wardrobeUrls ?? [])],
    /**
     * 照片与服装都按模特逐个回填。`modelSlots` 是服务端算好的权威值
     * （已内置「该模特自己的 → 整场共用 → 档案首图」的回退），直接用即可。
     */
    modelWardrobes: (e.models ?? []).map((m, i) => {
      const slot = e.modelSlots?.find((s) => s.modelId === m.id) ?? e.modelSlots?.[i];
      return [...(slot?.wardrobeUrls ?? e.wardrobeUrls ?? [])];
    }),
    modelPhotos: (e.models ?? []).map((m, i) => {
      const slot = e.modelSlots?.find((s) => s.modelId === m.id) ?? e.modelSlots?.[i];
      return [...(slot?.photoUrls ?? [])].slice(0, 1);
    }),
    venuePhotos: [...(e.venueUrls ?? [])],
  });
  // 代拍行由服务端维护（kind=PROXY），不参与常规时段的编辑与提交
  sessions.value = e.sessions
    .filter((s) => s.kind !== 'PROXY')
    .map((s) => ({
      id: s.id,
      label: s.label,
      startAt: toLocalInput(s.startAt),
      endAt: toLocalInput(s.endAt),
      capacity: s.capacity,
    }));
  pristine = {
    form: {
      ...form,
      posters: [...form.posters],
      wardrobeShared: [...form.wardrobeShared],
      // 二维数组要深拷贝一层，否则改表单会连带改到快照，差量比对失效
      modelWardrobes: form.modelWardrobes.map((w) => [...w]),
      modelPhotos: form.modelPhotos.map((p) => [...p]),
      modelIds: [...form.modelIds],
      venuePhotos: [...form.venuePhotos],
    },
    sessions: sessions.value.map((s) => ({ ...s })),
  };
  dialogOpen.value = true;
}

/**
 * 追加一条时段：从**上一场结束时间 + 10 分钟休息**开始，时长沿用上一场（拿不到按 60 分钟）。
 * 仍可手工修改。
 */
function addSession(): void {
  const last = sessions.value[sessions.value.length - 1];
  const lastStart = last?.startAt ? new Date(last.startAt) : null;
  const lastEnd = last?.endAt ? new Date(last.endAt) : null;
  const durationMs = lastStart && lastEnd && lastEnd.getTime() > lastStart.getTime()
    ? lastEnd.getTime() - lastStart.getTime()
    : SESSION_MINUTES * 60_000;
  const nextStart = lastEnd ? new Date(lastEnd.getTime() + SESSION_BREAK_MINUTES * 60_000) : null;
  const nextEnd = nextStart ? new Date(nextStart.getTime() + durationMs) : null;
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
 * 模特下拉变化：为新增的模特补齐照片/服装槽位，并给还没有照片的模特随机带出一张。
 *
 * 不再区分主副模特 —— 每一位的配置方式完全一致，第一位只额外承担「列表封面」的角色。
 */
function onModelsChange(): void {
  const ids = form.modelIds;

  // 槽位与 modelIds 同长：多出来的截掉，少了的补空数组
  const resize = (list: string[][]): string[][] =>
    ids.map((_, i) => list[i] ?? []);
  form.modelWardrobes = resize(form.modelWardrobes);
  form.modelPhotos = resize(form.modelPhotos);

  ids.forEach((mid, i) => {
    const photos = modelPhotoPool(mid);
    if (form.modelPhotos[i]?.[0]) {
      // 已选图仍在该模特库里就保留；换过模特则重新随机
      if (photos.includes(form.modelPhotos[i]![0]!)) return;
    }
    form.modelPhotos[i] = photos.length
      ? [photos[Math.floor(Math.random() * photos.length)]!]
      : [];
  });

  // 列表封面跟随第一位模特
  form.posters = form.modelPhotos[0]?.[0] ? [form.modelPhotos[0]![0]!] : [];
}

/** 某位模特的照片库（用于选图） */
function modelPhotoPool(modelId: string): string[] {
  return modelOptions.value.find((m) => m.id === modelId)?.photoUrls ?? [];
}

function modelNameOf(modelId: string): string {
  return modelOptions.value.find((m) => m.id === modelId)?.stageName ?? '未命名模特';
}

function pickModelPhotoAt(index: number, url: string): void {
  form.modelPhotos[index] = [url];
  // 第一位模特的照片同时作为列表封面
  if (index === 0) form.posters = [url];
}

/** 随机换一张：尽量避开当前图，只有一张时保持不变 */
function randomModelPhotoAt(index: number): void {
  const mid = form.modelIds[index];
  if (!mid) return;
  const photos = modelPhotoPool(mid);
  const current = form.modelPhotos[index]?.[0];
  const candidates = photos.length > 1 ? photos.filter((u) => u !== current) : photos;
  if (!candidates.length) return;
  form.modelPhotos[index] = [candidates[Math.floor(Math.random() * candidates.length)]!];
  if (index === 0) form.posters = [form.modelPhotos[index]![0]!];
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
    modelIds: f.modelIds,
    modelId: f.modelIds[0] ?? null,
    sceneId: f.sceneId.trim() || null,
    visibility: f.visibility,
    registerMinLevel: f.registerMinLevel,
    allowCoupon: f.allowCoupon,
    allowProxyShoot: f.allowProxyShoot,
    refundPolicy: { freeCancelBeforeHours: Number(f.refundFreeHours), feeRatio: Number(f.refundFeeRatio) },
    registrationOpenAt: iso(f.openAt),
    registrationCloseAt: iso(f.closeAt),
    coverUrl: f.posters[0] ?? null,
    // 模特图只保留 1 张：既是列表封面，也是导出海报底图
    posterUrls: f.posters.slice(0, 1),
    /**
     * 整场服装图（兼容字段）：前台详情、列表与海报在拿不到「按模特的服装」时回退用它。
     * 有模特时取第一位模特的那组；没有模特时用自由上传的那组。
     */
    wardrobeUrls: f.modelIds.length
      ? (f.modelWardrobes[0] ?? [])
      : f.wardrobeShared,
    /** 每位模特各自的照片与服装，与 modelIds 同序 */
    modelWardrobes: f.modelIds.map((_, i) => f.modelWardrobes[i] ?? []),
    modelPhotos: f.modelIds.map((_, i) => f.modelPhotos[i] ?? []),
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
async function exportPoster(e: EventDto, style: PosterStyle = 'classic'): Promise<void> {
  if (exportingId.value) return;
  exportingId.value = e.id;
  try {
    await exportEventPoster(e, qrUrl.value, brandTitle.value, {
      style,
      siteQrUrl: siteQrUrl.value,
      // 后台设计器保存过版式就优先用它，否则按所选预设渲染
      layout: savedLayout.value,
    });
    ui.notify(`海报已导出（${savedLayout.value ? '自定义版式' : POSTER_STYLE_META[style].label}）`, 'success');
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : '导出失败，请重试', 'error');
  } finally {
    exportingId.value = null;
  }
}

/* ---------------- 海报版式选择 ---------------- */
const posterDialogOpen = ref(false);
const posterTarget = ref<EventDto | null>(null);
const posterStyle = ref<PosterStyle>('classic');

/** 双模特场次默认选「双人」版式，单模特默认「经典」 */
function openPosterDialog(e: EventDto): void {
  posterTarget.value = e;
  posterStyle.value = (e.models?.length ?? 0) > 1 ? 'duo' : 'classic';
  posterDialogOpen.value = true;
}

async function confirmExportPoster(): Promise<void> {
  const target = posterTarget.value;
  if (!target) return;
  posterDialogOpen.value = false;
  await exportPoster(target, posterStyle.value);
}

/* ---------------- 海报设计器（低代码拖拽） ---------------- */
const designerOpen = ref(false);
/** 设计器预览用的场次：优先当前点开的那个，否则用列表第一条 */
const designerEvent = ref<EventDto | null>(null);

function openDesigner(): void {
  designerEvent.value = posterTarget.value ?? list.value[0] ?? null;
  posterDialogOpen.value = false;
  if (!designerEvent.value) {
    ui.notify('还没有场次可用于预览，请先创建场次', 'error');
    return;
  }
  designerOpen.value = true;
}

/** 设计器保存后把新版式同步到本地，导出时立刻生效 */
function onLayoutSaved(next: PosterLayoutDto | null): void {
  savedLayout.value = next;
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
            <th class="whitespace-nowrap px-3 py-2.5 font-medium">标准积分</th>
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
              {{ e.sessions.filter((s) => s.kind !== 'PROXY').length }} 场
              <span v-if="e.allowProxyShoot" class="ml-1 rounded bg-slate-100 px-1 text-[11px] text-slate-600">含代拍</span>
              <p class="text-xs text-slate-500">{{ shortTime(e.sessions.find((s) => s.kind !== 'PROXY')?.startAt) }}</p>
            </td>
            <td class="px-3 py-2.5 text-slate-600">{{ e.capacityUsed }}/{{ e.capacity }}</td>
            <td class="px-3 py-2.5 font-medium text-slate-900">{{ points(e.feeCent) }}</td>
            <td class="whitespace-nowrap px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(EVENT_STATUS, e.status).cls">
                {{ metaOf(EVENT_STATUS, e.status).label }}
              </span>
            </td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap">
              <el-button size="small" :type="seatsOpen && expandedId === e.id ? 'primary' : 'default'" @click="openSeats(e)">名额/名单</el-button>
              <el-button size="small" @click="goRegistrations(e)">报名名单</el-button>
              <el-button size="small" @click="openEdit(e)">编辑</el-button>
              <el-button size="small" :loading="exportingId === e.id" @click="openPosterDialog(e)">导出海报</el-button>
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
            <p class="mt-1 text-xs text-slate-500">
              {{ e.sessions.filter((s) => s.kind !== 'PROXY').length }} 场 · {{ e.capacityUsed }}/{{ e.capacity }} 人
            </p>
            <div class="mt-1.5 flex items-center gap-1.5">
              <span class="rounded-full px-1.5 py-0.5 text-[11px]" :class="metaOf(VISIBILITY, e.visibility).cls">{{ metaOf(VISIBILITY, e.visibility).label }}</span>
              <span class="rounded-full px-1.5 py-0.5 text-[11px]" :class="metaOf(EVENT_STATUS, e.status).cls">{{ metaOf(EVENT_STATUS, e.status).label }}</span>
              <span class="text-xs font-medium text-slate-900">{{ points(e.feeCent) }}</span>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <span class="shrink-0 text-xs text-slate-500">报名门槛</span>
              <!-- 刻意保留原生 select：按等级切换边框/底色（SVIP 金 / VIP 玫红 / NONE 中性），
                   el-select 无法在不深度覆盖样式的前提下保留这套着色语义。 -->
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
              <el-button size="small" :loading="exportingId === e.id" @click="openPosterDialog(e)">导出海报</el-button>
              <el-button v-if="e.status === 'DRAFT'" size="small" type="primary" @click="publishEvent(e)">发布</el-button>
              <el-button v-if="e.status === 'CANCELLED'" size="small" type="primary" @click="restoreEvent(e)">恢复</el-button>
              <el-button v-else-if="e.status !== 'DRAFT'" size="small" text type="danger" @click="cancelEvent(e)">取消</el-button>
            </div>
          </div>
        </div>
        <div v-if="!loading && !filtered.length" class="px-3 py-12 text-center text-sm text-slate-500">还没有场次</div>
      </div>

      <AppPagination
        :page="page"
        :page-size="pageSize"
        :total="total"
        :hide-on-single-page="true"
        :summary="`共 ${total} 条`"
        @change="(p) => goPageTo(p)"
        @size-change="(s) => changePageSize(s)"
      />
    </div>

    <!-- 海报版式选择：一次导出选定样式；双模特场次默认「双人」 -->
    <el-dialog v-model="posterDialogOpen" title="导出海报" width="min(560px, 94vw)" top="8vh">
      <p class="mb-3 text-xs text-slate-500">
        1080×1620 竖版 PNG。选择版式后立即下载，可重复导出多套对比。
      </p>
      <el-alert
        v-if="savedLayout"
        type="success"
        :closable="false"
        show-icon
        class="!mb-3"
        title="已保存自定义版式"
      >
        <template #default>
          <span class="text-xs">
            导出将使用你在设计器里排好的版式，下面的预设仅在取消自定义后生效。
          </span>
        </template>
      </el-alert>
      <div class="space-y-2">
        <button v-for="st in POSTER_STYLES" :key="st" type="button"
          class="w-full rounded-xl border px-3 py-3 text-left transition"
          :class="posterStyle === st
            ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/15'
            : 'border-slate-200 hover:border-slate-300'"
          @click="posterStyle = st">
          <span class="flex items-center justify-between">
            <span class="text-sm font-medium text-slate-900">{{ POSTER_STYLE_META[st].label }}</span>
            <span v-if="st === 'duo' && (posterTarget?.models?.length ?? 0) > 1"
              class="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">推荐</span>
          </span>
          <span class="mt-0.5 block text-xs text-slate-500">{{ POSTER_STYLE_META[st].hint }}</span>
        </button>
      </div>

      <!-- 低代码设计器入口：需要一张场次图来预览效果，故从具体场次进入 -->
      <div class="mt-4 rounded-xl border border-dashed border-slate-300 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium text-slate-800">自己排版</p>
            <p class="mt-0.5 text-xs leading-5 text-slate-500">
              打开设计器拖拽区块、改文案与图片，保存后所有场次都按这个版式导出。
            </p>
          </div>
          <el-button size="small" type="primary" plain @click="openDesigner">打开设计器</el-button>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="posterDialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="!!exportingId" @click="confirmExportPoster">导出</el-button>
        </div>
      </template>
    </el-dialog>

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
                  <!-- 代拍不限人数，也没有时间点，不显示余量与进度条 -->
                  <span v-if="s.kind !== 'PROXY'" class="ml-1 text-xs font-normal text-slate-500">{{ shortTime(s.startAt) }}</span>
                </p>
                <span
                  v-if="s.kind === 'PROXY'"
                  class="whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                >
                  不限人数
                </span>
                <span
                  v-else
                  class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs"
                  :class="s.capacityUsed >= s.capacity ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'"
                >
                  {{ s.capacityUsed >= s.capacity ? '已满' : `余 ${s.capacity - s.capacityUsed}` }}
                </span>
              </div>
              <template v-if="s.kind !== 'PROXY'">
                <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    class="h-full rounded-full"
                    :class="s.capacityUsed >= s.capacity ? 'bg-rose-500' : 'bg-blue-500'"
                    :style="{ width: `${sessionPct(s)}%` }"
                  ></div>
                </div>
                <p class="mt-1 text-xs text-slate-500">{{ s.capacityUsed }}/{{ s.capacity }} 人</p>
              </template>
              <p v-else class="mt-1 text-xs text-slate-500">已约 {{ s.capacityUsed }} 单</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="r in regsOf(expandedEvent, s)"
                  :key="r.id"
                  class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                  :title="`${metaOf(REGISTRATION_STATUS, r.status).label} · ${shortTime(r.createdAt)}`"
                >
                  {{ personLabel(r.userNickname, r.userWechatId, r.userId, { withWechat: false }) }}
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
          <el-form label-width="96px" label-position="left">
            <el-form-item label="从场景库">
              <div class="w-full">
                <el-select v-model="form.sceneId" placeholder="暂不选择 / 手动填写"
                  clearable filterable class="!w-full" @change="onSceneChange">
                  <el-option-group v-for="g in sceneGroups" :key="g.venue" :label="g.venue">
                    <el-option v-for="s in g.scenes" :key="s.id" :label="s.name" :value="s.id" />
                  </el-option-group>
                </el-select>
                <span class="mt-1 block text-xs text-slate-500">按场地分组，选择后自动填入场地名、场景名与场地照片，仍可手动修改；场景库在「场景管理」里维护。</span>
                <span v-if="selectedScene?.address" class="mt-1 block text-xs text-slate-500">场地地址：{{ selectedScene.address }}</span>
              </div>
            </el-form-item>
            <el-form-item label="场次标题" required>
              <el-input v-model="form.title" placeholder="例：猫爪社摄影会·犬了个牙" clearable />
            </el-form-item>
            <el-form-item label="副标题">
              <el-input v-model="form.subtitle" placeholder="例：仪玄OL" clearable />
            </el-form-item>
            <el-form-item label="场地" required>
              <el-input v-model="form.venue" placeholder="例：咕咕摄影棚" clearable />
            </el-form-item>
            <el-form-item label="场景">
              <el-input v-model="form.scene" placeholder="例：办公室景" clearable />
            </el-form-item>
            <el-form-item label="模特">
              <div class="w-full">
                <!-- 多模特：第一位即主模特，海报主图与模特照片库仍以它为准 -->
                <el-select v-model="form.modelIds" multiple collapse-tags collapse-tags-tooltip
                  placeholder="暂不指定（可多选，第一位为主模特）" clearable filterable
                  class="!w-full" @change="onModelsChange">
                  <el-option v-for="m in modelOptions" :key="m.id" :label="m.stageName" :value="m.id" />
                </el-select>
                <span class="mt-1 block text-xs text-slate-500">
                  双模特场次请选 2 位；第一位是主模特，下方「模特照片」默认取自 TA 的照片库。
                </span>
              </div>
            </el-form-item>
            <el-form-item label="人数比">
              <el-input v-model="form.ratioLabel" placeholder="例：4V1" clearable />
            </el-form-item>
          </el-form>
        </section>

        <!-- 报名时间 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">报名时间</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="报名开始" required>
              <el-date-picker v-model="form.openAt" type="datetime" placeholder="选择报名开始"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
            <el-form-item label="报名截止" required>
              <el-date-picker v-model="form.closeAt" type="datetime" placeholder="选择报名截止"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
          </el-form>
        </section>

        <!-- 可见性与价格 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">可见性与价格</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="可见性">
              <el-select v-model="form.visibility" class="!w-40">
                <el-option label="公开" value="PUBLIC" />
                <el-option label="仅 VIP" value="VIP" />
                <el-option label="仅 SVIP" value="SVIP" />
              </el-select>
            </el-form-item>
            <div class="grid gap-3 sm:grid-cols-3">
              <el-form-item label="标准积分">
                <el-input-number v-model="form.publicYuan" :min="0" :step="1"
                  controls-position="right" class="!w-32" />
                <span class="ml-1 text-xs text-slate-500">积分</span>
              </el-form-item>
              <el-form-item label="VIP 积分">
                <el-input-number v-model="form.vipYuan" :min="0" :step="1"
                  controls-position="right" class="!w-32" />
                <span class="ml-1 text-xs text-slate-500">积分</span>
              </el-form-item>
              <el-form-item label="SVIP 积分">
                <el-input-number v-model="form.svipYuan" :min="0" :step="1"
                  controls-position="right" class="!w-32" />
                <span class="ml-1 text-xs text-slate-500">积分</span>
              </el-form-item>
            </div>
            <el-form-item label="可报名等级">
              <div>
                <el-select v-model="form.registerMinLevel" class="!w-64">
                  <el-option label="所有人（含非会员）" value="NONE" />
                  <el-option label="VIP 及以上" value="VIP" />
                  <el-option label="仅 SVIP" value="SVIP" />
                </el-select>
                <span class="mt-1 block text-xs text-slate-500">人工分阶段放开：先「仅 SVIP」，SVIP 报满后改「VIP 及以上」，最后改「所有人」。与「可见性」独立——能看到不代表此刻能报名。</span>
              </div>
            </el-form-item>
            <el-form-item label="优惠券">
              <div>
                <el-checkbox v-model="form.allowCoupon">允许报名时使用优惠券</el-checkbox>
                <span class="mt-0.5 block text-xs text-slate-500">关闭后本场新报名不能带券；已产生的报名与退款不受影响。</span>
              </div>
            </el-form-item>
            <el-form-item label="代拍">
              <div>
                <el-checkbox v-model="form.allowProxyShoot">本场支持代拍</el-checkbox>
                <span class="mt-0.5 block text-xs text-slate-500">
                  勾选后自动生成一个独立的「代拍」报名项（不占用任何时段，会员无需到场），价格与正常报名一致。
                  取消勾选会删除该项目；若已有代拍报名则不允许取消。
                </span>
              </div>
            </el-form-item>
          </el-form>
          <el-alert v-if="hasRegistrations" type="warning" :closable="false" show-icon
            :title="`该场次已有 ${editing?.capacityUsed} 人报名：可以改时间、加场、改价；有报名的时段不能删除，容量也不能小于已报名人数。`" />
        </section>

        <!-- 候补已下线（2026-11-13）：满员即不可报名，故此处只有退款规则，没有候补开关 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">退款规则</h4>
          <el-form label-width="120px" label-position="left">
            <el-form-item label="免费取消提前量">
              <div>
                <el-input-number v-model="form.refundFreeHours" :min="0" :max="720" :step="1"
                  controls-position="right" class="!w-32" />
                <span class="ml-1 text-xs text-slate-500">小时</span>
                <span class="mt-1 block text-xs text-slate-500">开始前 N 小时内取消将收取手续费</span>
              </div>
            </el-form-item>
            <el-form-item label="退款手续费率">
              <div>
                <el-input-number v-model="form.refundFeeRatio" :min="0" :max="1" :step="0.01"
                  :precision="2" controls-position="right" class="!w-32" />
                <span class="mt-1 block text-xs text-slate-500">0.1 表示扣除 10%；0 表示全额退款</span>
              </div>
            </el-form-item>
          </el-form>
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
              <div class="col-span-2 sm:col-span-2">
                <span class="mb-1 block text-xs text-slate-500">名称</span>
                <el-input v-model="s.label" placeholder="第一场" />
              </div>
              <div class="col-span-2 sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">开始</span>
                <el-date-picker v-model="s.startAt" type="datetime" placeholder="开始"
                  format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" size="small" class="!w-full" />
              </div>
              <div class="col-span-2 sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">结束</span>
                <el-date-picker v-model="s.endAt" type="datetime" placeholder="结束"
                  format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" size="small" class="!w-full" />
              </div>
              <div class="col-span-2 sm:col-span-2">
                <span class="mb-1 block text-xs text-slate-500">容量</span>
                <el-input-number v-model="s.capacity" :min="1" :step="1"
                  controls-position="right" size="small" class="!w-full" />
              </div>
              <div class="col-span-2 flex justify-end sm:col-span-2">
                <el-button size="small" text type="danger" :disabled="sessions.length <= 1" @click="removeSession(i)">删除</el-button>
              </div>
            </div>
          </div>
        </section>

        <!-- 图片 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-1 text-sm font-semibold text-slate-900">图片</h4>
          <p class="mb-3 text-xs leading-5 text-slate-500">
            每位模特各自一张本场照片 + 一组当日服装；场地照片由整场共用，不需要按模特重复上传。
          </p>

          <!-- 每位模特一张卡片：不分主副，配置方式完全一致 -->
          <div v-if="form.modelIds.length" class="space-y-3">
            <div v-for="(mid, idx) in form.modelIds" :key="mid"
              class="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <span class="text-sm font-medium text-slate-800">
                  模特 {{ idx + 1 }} · {{ modelNameOf(mid) }}
                </span>
                <span class="text-[11px] text-slate-400">照片与服装各自独立</span>
              </div>

              <!-- 本场照片 -->
              <p class="mb-1.5 text-xs font-medium text-slate-600">本场照片</p>
              <div v-if="modelPhotoPool(mid).length" class="space-y-2">
                <div class="flex flex-wrap items-start gap-3">
                  <div class="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <img v-if="form.modelPhotos[idx]?.[0]" :src="form.modelPhotos[idx]![0]" alt=""
                      class="h-full w-full object-cover" />
                    <span v-else class="flex h-full items-center justify-center px-1 text-center text-[11px] text-slate-500">未选</span>
                  </div>
                  <div class="min-w-0 text-xs leading-relaxed text-slate-500">
                    <p>从 <span class="font-medium text-slate-700">{{ modelNameOf(mid) }}</span> 的照片库里选 1 张。</p>
                    <p v-if="idx === 0" class="text-slate-400">第一位模特的照片同时作为列表封面。</p>
                    <button type="button" class="mt-1 text-blue-600 hover:underline"
                      @click="randomModelPhotoAt(idx)">随机换一张</button>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button v-for="url in modelPhotoPool(mid)" :key="url" type="button"
                    class="relative h-14 w-14 overflow-hidden rounded-lg border-2 transition"
                    :class="form.modelPhotos[idx]?.[0] === url ? 'border-blue-500' : 'border-slate-200 hover:border-slate-400'"
                    @click="pickModelPhotoAt(idx, url)">
                    <img :src="url" alt="" class="h-full w-full object-cover" />
                    <span v-if="form.modelPhotos[idx]?.[0] === url"
                      class="absolute inset-x-0 bottom-0 bg-blue-500/85 py-0.5 text-center text-[10px] text-white">已选</span>
                  </button>
                </div>
              </div>
              <p v-else class="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-3 text-center text-xs text-slate-500">
                该模特还没有照片，请先到「模特管理」补充。
              </p>

              <!-- 当日服装 -->
              <p class="mb-1.5 mt-3 text-xs font-medium text-slate-600">当日服装</p>
              <ImageUploader v-model="form.modelWardrobes[idx]" :max="9" cover-hint="" />
            </div>
          </div>

          <!-- 未指定模特：整场自由上传 -->
          <div v-else>
            <p class="mb-1.5 text-xs font-medium text-slate-600">模特照片</p>
            <ImageUploader v-model="form.posters" :max="1" cover-hint="" />
            <p class="mb-1.5 mt-3 text-xs font-medium text-slate-600">当日服装</p>
            <ImageUploader v-model="form.wardrobeShared" :max="9" cover-hint="" />
            <p class="mt-1 text-xs text-slate-500">未指定模特时可自由上传；选定模特后会自动改用该模特照片库。</p>
          </div>

          <div class="mt-4 border-t border-slate-200 pt-3">
            <p class="mb-1.5 text-xs font-medium text-slate-600">场地照片</p>
            <ImageUploader v-model="form.venuePhotos" :max="9" cover-hint="" />
            <p class="mt-1 text-xs text-slate-400">整场共用一组，不分模特。</p>
          </div>
        </section>

        <!-- 须知 -->
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">报名须知</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="须知内容">
              <el-input v-model="form.notice" type="textarea" :rows="4"
                placeholder="例：&#10;1. 请提前 10 分钟到场签到&#10;2. 开始前 48 小时可免费取消" />
            </el-form-item>
          </el-form>
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
      <el-form label-width="96px" label-position="left">
        <el-form-item label="左上角标题">
          <div class="w-full">
            <el-input v-model="brandTitleDraft" maxlength="32" show-word-limit
              :placeholder="DEFAULT_BRAND_TITLE" clearable />
            <span class="mt-1 block text-xs text-slate-500">留空使用默认标题：{{ DEFAULT_BRAND_TITLE }}</span>
          </div>
        </el-form-item>
      </el-form>
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

    <!-- 海报设计器：低代码拖拽排版，保存后所有场次共用此版式 -->
    <el-dialog
      v-model="designerOpen"
      title="海报设计器"
      width="min(1560px, 98vw)"
      top="2.5vh"
      destroy-on-close
      class="poster-designer-dialog"
    >
      <PosterDesigner
        v-if="designerOpen && designerEvent"
        :event="designerEvent"
        :brand-title="brandTitle"
        :qr-url="qrUrl"
        :site-qr-url="siteQrUrl"
        @saved="onLayoutSaved"
      />
      <template #footer>
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-slate-500">
            版式对所有场次生效；二维码与标题仍在「海报配置」里改。
          </span>
          <el-button @click="designerOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
