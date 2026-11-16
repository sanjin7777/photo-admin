<script setup lang="ts">
/**
 * 海报设计器：低代码拖拽排版。
 *
 * 左侧 = 画布（1080×1620 等比缩放到容器里，鼠标事件换算回画布像素）；
 * 右侧 = 区块列表 + 选中区块的属性面板。
 *
 * 交互约定：
 * · 拖区块本体 = 移动；拖四角 = 缩放；方向键微调，Shift 加速；
 * · 属性改动立即反映到画布，点「保存版式」才落库；
 * · 所有坐标以画布像素存储，与导出 PNG 完全一致，所见即所得。
 *
 * 预览用的是**真实渲染器**（同一个 renderPoster），不是 HTML 模拟，
 * 所以画布里看到的字体、断行、价格配色就是最终导出的样子。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  POSTER_BLOCK_META,
  POSTER_BLOCKS,
  POSTER_CANVAS,
  newTextBlock,
  nextBlockId,
  posterLayoutSchema,
  posterPresetOf,
  type PosterBlockDto,
  type PosterBlockType,
  type PosterLayoutDto,
  type PosterPresetKey,
  type EventDto,
} from '@photo/shared';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { renderPoster } from '../utils/poster';

const props = defineProps<{
  /** 用于预览的场次；设计器不区分场次，仅拿一张图看效果 */
  event: EventDto | null;
  brandTitle: string | null;
  qrUrl: string | null;
  siteQrUrl: string | null;
}>();

const emit = defineEmits<{ (e: 'saved', layout: PosterLayoutDto | null): void }>();

const CANVAS_W = POSTER_CANVAS.width;
const CANVAS_H = POSTER_CANVAS.height;

const layout = ref<PosterLayoutDto>(posterPresetOf('classic'));
const selectedId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const exporting = ref(false);
/** 画布容器实际宽度，用来算缩放比 */
const stageW = ref(520);
const stageEl = ref<HTMLDivElement | null>(null);

/** 画布缩放比：容器宽度 / 1080 */
const scale = computed(() => stageW.value / CANVAS_W);
const stageH = computed(() => Math.round(CANVAS_H * scale.value));
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const rendering = ref(false);
/** 重新渲染防抖句柄：拖动时不必每帧都跑一遍完整 Canvas 绘制 */
let renderTimer: number | null = null;

const selected = computed<PosterBlockDto | null>(
  () => layout.value.blocks.find((b) => b.id === selectedId.value) ?? null,
);

/** 按 z 再按数组顺序：与渲染器保持一致的叠放关系 */
const orderedBlocks = computed(() =>
  [...layout.value.blocks].sort((a, b) => a.z - b.z),
);

/**
 * 热区渲染（= 点击优先级）顺序：与 `orderedBlocks` 完全一致。
 *
 * 热区是 absolute 定位且没有 z-index，**后面的 DOM 节点优先接收点击**。
 * 用它而不是 `layout.blocks`，才能让「点到的」和「看到的」是一致的。
 */
const hitOrderBlocks = orderedBlocks;

/** 该场次有没有第二位模特（决定 stage2 / wardrobe2 是否真的会被画出来） */
const hasSecondModel = computed(() => {
  const e = props.event;
  if (!e) return false;
  const slot = e.modelSlots?.[1];
  return Boolean(slot?.photoUrls?.length || e.models?.[1]?.photoUrls?.length);
});

/** 上一次渲染实际跳过的区块 id（由渲染器回报，最权威） */
const renderSkipped = ref<string[]>([]);

/**
 * 本场不会绘制、但设计器里仍存在的区块。
 *
 * 以**渲染器实际回报的结果**为准（`renderSkipped`）：数据层面「有第二位模特」
 * 不代表渲染时一定有图（图片加载失败也会被跳过）。
 * 这些区块必须不接收点击，否则会变成一层看不见的拦截器
 * （典型场景：单模特场次里用户加了「第二模特图」，它盖住下面的服装卡，
 *  点服装卡实际点在它身上 —— 就是「点第二模特服装却选中第二模特图」）。
 *
 * 首帧渲染完成前用同口径的本地估算兜底，避免出现「刚打开时能点、一秒后不能点」的跳变。
 */
const skippedInRender = computed(() => {
  const out = new Set<string>();
  const e = props.event;
  const slots = e?.modelSlots ?? [];
  const w0 = slots[0]?.wardrobeUrls?.[0] ?? e?.wardrobeUrls?.[0] ?? '';
  const w1 = slots[1]?.wardrobeUrls?.[0] ?? w0;

  for (const b of layout.value.blocks) {
    if (!b.visible) { out.add(b.id); continue; }
    if ((b.type === 'stage2' || b.type === 'wardrobe2') && !hasSecondModel.value) {
      out.add(b.id);
      continue;
    }
    // 与渲染器同规则：两位模特共用同一套服装时，第二块服装不画
    if (b.type === 'wardrobe2' && (!w1 || w1 === w0)) out.add(b.id);
  }
  // 渲染器回报的跳过项最权威，覆盖上面的估算
  for (const id of renderSkipped.value) out.add(id);
  return out;
});

/** 还没加到版式里的区块类型（同类区块允许多份，但常用块只给一个入口） */
const addableTypes = computed(() => {
  const used = new Set(layout.value.blocks.map((b) => b.type));
  return POSTER_BLOCKS.filter((t) => t === 'text' || t === 'divider' || !used.has(t));
});

const PRESETS: Array<{ key: PosterPresetKey; label: string }> = [
  { key: 'classic', label: '经典' },
  { key: 'duo', label: '双人' },
  { key: 'compact', label: '通栏' },
];

/* ---------------- 渲染预览 ---------------- */

/**
 * 把当前版式画到**模板里那个固定的 <canvas>** 上。
 *
 * 这里刻意**不替换 DOM 节点**：早期的写法是每次渲染新建一个 canvas 再把旧的换掉，
 * 结果新节点拿不到 Vue 的 scopeId（`data-v-xxx`），`.poster-preview` 的 scoped 样式失效，
 * 图片既不跟手也不跟框一起动。「拖动框内容不动」就是这么来的。
 * 现在只重绘画布内容，节点始终是模板渲染出来的那一个。
 */
async function paint(): Promise<void> {
  const event = props.event;
  const target = previewCanvas.value;
  if (!event || !target) return;
  rendering.value = true;
  try {
    const rendered = await renderPoster({
      event,
      layout: layout.value,
      qrUrl: props.qrUrl,
      siteQrUrl: props.siteQrUrl,
      brandTitle: props.brandTitle,
      // 让点击层跟随「实际画了什么」：跳过的区块不再拦截点击
      onDiagnostics: (info) => {
        renderSkipped.value = [...info.skippedIds];
      },
    });
    // 尺寸固定为设计尺寸，由 CSS 负责等比缩放到容器里
    if (target.width !== rendered.width) target.width = rendered.width;
    if (target.height !== rendered.height) target.height = rendered.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(rendered, 0, 0);
  } catch {
    // 预览失败不阻断编辑：区块位置仍然可调
  } finally {
    rendering.value = false;
  }
}

function schedulePaint(delay = 90): void {
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    void paint();
  }, delay);
}

// 版式变化时重画。拖动过程中的更短防抖在下方 beginDrag 里设置（那时 drag 才已初始化）
watch(layout, () => schedulePaint(drag.value ? 16 : 90), { deep: true });
// 外部配置（二维码 / 标题 / 场次）变化时整幅重画
watch(
  () => [props.event, props.qrUrl, props.siteQrUrl, props.brandTitle],
  () => schedulePaint(0),
);

/* ---------------- 拖拽 / 缩放 ---------------- */

type DragMode = 'move' | 'resize-se' | 'resize-sw' | 'resize-ne' | 'resize-nw';

const drag = ref<{
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  origin: { x: number; y: number; w: number; h: number };
} | null>(null);

/** 当前显示的对齐辅助线（画布坐标） */
const guides = ref<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });

/** 吸附阈值（画布像素）：屏幕上的手感差不多是 4~6px */
const SNAP = 8;

/**
 * 收集吸附参考线：其它区块的左/中/右、上/中/下，再加上画布边缘与中线。
 * 跳过当前拖动的区块本身，以及本场根本不绘制的区块（避免往看不见的框上吸）。
 */
function collectSnapTargets(excludeId: string): { xs: number[]; ys: number[] } {
  const xs = [0, CANVAS_W / 2, CANVAS_W];
  const ys = [0, CANVAS_H / 2, CANVAS_H];
  for (const b of layout.value.blocks) {
    if (b.id === excludeId || !b.visible || skippedInRender.value.has(b.id)) continue;
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

/**
 * 把一组锚点吸附到最近的参考线。
 *
 * @returns 需要施加的位移（未吸附为 0）与命中的参考线坐标
 */
function snapAnchors(
  anchors: number[],
  targets: number[],
  threshold = SNAP,
): { delta: number; guide: number | null } {
  let best: { delta: number; guide: number } | null = null;
  for (const a of anchors) {
    for (const t of targets) {
      const delta = t - a;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, guide: t };
    }
  }
  return best ? { delta: best.delta, guide: best.guide } : { delta: 0, guide: null };
}

/** 鼠标位移换算成画布像素 */
function toCanvasDelta(ev: PointerEvent, startX: number, startY: number): { dx: number; dy: number } {
  const s = scale.value || 1;
  return { dx: (ev.clientX - startX) / s, dy: (ev.clientY - startY) / s };
}

function beginDrag(ev: PointerEvent, block: PosterBlockDto, mode: DragMode): void {
  ev.preventDefault();
  ev.stopPropagation();
  selectedId.value = block.id;
  drag.value = {
    id: block.id,
    mode,
    startX: ev.clientX,
    startY: ev.clientY,
    origin: { x: block.x, y: block.y, w: block.w, h: block.h },
  };
  guides.value = { vertical: [], horizontal: [] };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag, { once: true });
}

function onDragMove(ev: PointerEvent): void {
  const d = drag.value;
  if (!d) return;
  const block = layout.value.blocks.find((b) => b.id === d.id);
  if (!block) return;

  const { dx, dy } = toCanvasDelta(ev, d.startX, d.startY);
  const r = (n: number): number => Math.round(n);
  const targets = collectSnapTargets(d.id);

  if (d.mode === 'move') {
    let nx = r(d.origin.x + dx);
    let ny = r(d.origin.y + dy);

    // 左/中/右、上/中/下 六条锚点都参与吸附，命中最近的一条
    const sx = snapAnchors([nx, nx + d.origin.w / 2, nx + d.origin.w], targets.xs);
    const sy = snapAnchors([ny, ny + d.origin.h / 2, ny + d.origin.h], targets.ys);
    if (sx.guide !== null) nx = r(nx + sx.delta);
    if (sy.guide !== null) ny = r(ny + sy.delta);

    block.x = nx;
    block.y = ny;
    guides.value = {
      vertical: sx.guide !== null ? [sx.guide] : [],
      horizontal: sy.guide !== null ? [sy.guide] : [],
    };
    return;
  }

  // 缩放：保持对角固定，最小尺寸 24×8
  const minW = 24;
  const minH = 8;

  /**
   * 缩放时的吸附：只对**正在被拖的那条边**做吸附，
   * 否则会对角固定失效、区块跟着跳。
   */
  const snapEdge = (value: number, axis: 'x' | 'y'): { value: number; guide: number | null } => {
    const t = axis === 'x' ? targets.xs : targets.ys;
    const hit = snapAnchors([value], t);
    return hit.guide !== null ? { value: Math.round(value + hit.delta), guide: hit.guide } : { value, guide: null };
  };
  let gv: number | null = null;
  let gh: number | null = null;

  if (d.mode === 'resize-se') {
    const rx = snapEdge(r(d.origin.x + d.origin.w + dx), 'x');
    const by = snapEdge(r(d.origin.y + d.origin.h + dy), 'y');
    block.w = Math.max(minW, rx.value - d.origin.x);
    block.h = Math.max(minH, by.value - d.origin.y);
    block.x = d.origin.x;
    block.y = d.origin.y;
    gv = rx.guide; gh = by.guide;
  } else if (d.mode === 'resize-sw') {
    const lx = snapEdge(r(d.origin.x + dx), 'x');
    const by = snapEdge(r(d.origin.y + d.origin.h + dy), 'y');
    const w = Math.max(minW, d.origin.x + d.origin.w - lx.value);
    block.w = w;
    block.x = d.origin.x + (d.origin.w - w);
    block.h = Math.max(minH, by.value - d.origin.y);
    block.y = d.origin.y;
    gv = lx.guide; gh = by.guide;
  } else if (d.mode === 'resize-ne') {
    const rx = snapEdge(r(d.origin.x + d.origin.w + dx), 'x');
    const ty = snapEdge(r(d.origin.y + dy), 'y');
    block.w = Math.max(minW, rx.value - d.origin.x);
    block.x = d.origin.x;
    const h = Math.max(minH, d.origin.y + d.origin.h - ty.value);
    block.h = h;
    block.y = d.origin.y + (d.origin.h - h);
    gv = rx.guide; gh = ty.guide;
  } else {
    const lx = snapEdge(r(d.origin.x + dx), 'x');
    const ty = snapEdge(r(d.origin.y + dy), 'y');
    const w = Math.max(minW, d.origin.x + d.origin.w - lx.value);
    block.w = w;
    block.x = d.origin.x + (d.origin.w - w);
    const h = Math.max(minH, d.origin.y + d.origin.h - ty.value);
    block.h = h;
    block.y = d.origin.y + (d.origin.h - h);
    gv = lx.guide; gh = ty.guide;
  }

  guides.value = {
    vertical: gv !== null ? [gv] : [],
    horizontal: gh !== null ? [gh] : [],
  };
}

function endDrag(): void {
  drag.value = null;
  guides.value = { vertical: [], horizontal: [] };
  window.removeEventListener('pointermove', onDragMove);
}

/**
 * 点击热区选中区块。
 *
 * 默认选中的是「点到的那个」（也就是画面上最上层的那个）。
 * 但大图区块盖住小卡时（例如把「第二模特图」拉大到覆盖服装卡），
 * 上层区块会一直抢走点击，下层就永远点不到。
 * 因此支持 **Alt / Option + 点击**：在当前位置重叠的区块里循环下移一层，
 * 这样即使被完全盖住也能选中。
 */
function onHotspotClick(ev: MouseEvent, block: PosterBlockDto): void {
  if (!ev.altKey) {
    selectedId.value = block.id;
    return;
  }

  // 把鼠标位置换算成画布坐标，才能判断「这一点上还压着哪些区块」
  const canvasEl = previewCanvas.value;
  if (!canvasEl) { selectedId.value = block.id; return; }
  const rect = canvasEl.getBoundingClientRect();
  const s = scale.value || 1;
  const px = (ev.clientX - rect.left) / s;
  const py = (ev.clientY - rect.top) / s;

  // 找出所有包含该点、且在画面上真正可见的区块，按 z 从高到低
  const stack = hitOrderBlocks.value
    .filter((b) => !skippedInRender.value.has(b.id))
    .filter((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
  if (!stack.length) {
    selectedId.value = block.id;
    return;
  }
  const ordered = [...stack].reverse(); // 画面上最高的在前
  const cur = ordered.findIndex((b) => b.id === selectedId.value);
  // 每按一次 Alt+点击，往下移一层；到底后回到最上层
  selectedId.value = ordered[(cur + 1) % ordered.length]!.id;
}

/** 方向键微调选中区块；Shift 一次 10px */
function onKeydown(ev: KeyboardEvent): void {
  const block = selected.value;
  if (!block) return;
  // 焦点在输入框里时不抢按键
  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const step = ev.shiftKey ? 10 : 1;
  let handled = true;
  switch (ev.key) {
    case 'ArrowLeft': block.x -= step; break;
    case 'ArrowRight': block.x += step; break;
    case 'ArrowUp': block.y -= step; break;
    case 'ArrowDown': block.y += step; break;
    case 'Delete':
    case 'Backspace': removeBlock(block.id); break;
    default: handled = false;
  }
  if (handled) ev.preventDefault();
}

/* ---------------- 区块增删 ---------------- */

/** 各区块的默认落点：优先沿用预设里同类型的尺寸，没有就按类别给个合理值 */
const FALLBACK_BOX: Record<PosterBlockType, { x: number; y: number; w: number; h: number }> = {
  stage: { x: 0, y: 0, w: 672, h: 860 },
  stage2: { x: 540, y: 0, w: 540, h: 820 },
  brand: { x: 72, y: 72, w: 560, h: 60 },
  title: { x: 72, y: 900, w: 528, h: 180 },
  intro: { x: 72, y: 1092, w: 528, h: 60 },
  sessions: { x: 72, y: 1200, w: 528, h: 160 },
  prices: { x: 72, y: 1400, w: 528, h: 96 },
  wardrobe: { x: 672, y: 72, w: 336, h: 420 },
  wardrobe2: { x: 672, y: 508, w: 336, h: 356 },
  venue: { x: 672, y: 520, w: 336, h: 300 },
  qr: { x: 744, y: 1270, w: 264, h: 318 },
  qrSite: { x: 744, y: 924, w: 264, h: 318 },
  footer: { x: 72, y: 1548, w: 700, h: 44 },
  divider: { x: 72, y: 1176, w: 528, h: 8 },
  text: { x: 72, y: 1330, w: 528, h: 48 },
};

function addBlock(type: PosterBlockType): void {
  const id = nextBlockId(layout.value, type);
  const maxZ = layout.value.blocks.length
    ? Math.max(...layout.value.blocks.map((b) => b.z))
    : 0;

  /**
   * 只从「预设里真有这个类型」的版式取样。
   * 之前用的是非空断言 `find(...)!`：找不到时展开 undefined 会得到缺字段的对象，
   * 保存时被 schema 打回（例如经典版式里没有 stage2）。
   */
  const found =
    posterPresetOf('classic').blocks.find((b) => b.type === type) ??
    posterPresetOf('duo').blocks.find((b) => b.type === type);
  const box = found ?? FALLBACK_BOX[type];

  const block: PosterBlockDto = type === 'text'
    ? { ...newTextBlock(id) }
    : {
        id,
        type,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        visible: true,
        z: maxZ + 1,
        text: null,
        fontSize: null,
        align: null,
        color: found?.color ?? null,
        imageUrl: null,
        fit: found?.fit
          ?? (['stage', 'venue', 'wardrobe', 'wardrobe2'].includes(type) ? 'contain' : null),
        /**
         * 新增「第二模特」相关区块时默认绑第 2 位模特；
         * 其余区块沿用预设里的取值（一般为 0）。
         */
        modelIndex: found?.modelIndex ?? (type === 'wardrobe2' || type === 'stage2' ? 1 : 0),
      };

  // 自定义文字块自带文案，但要让它落在现有内容之下，避免盖住标题
  if (type === 'text') block.z = maxZ + 1;

  layout.value.blocks.push(block);
  selectedId.value = id;
}

function removeBlock(id: string): void {
  const i = layout.value.blocks.findIndex((b) => b.id === id);
  if (i < 0) return;
  layout.value.blocks.splice(i, 1);
  if (selectedId.value === id) selectedId.value = layout.value.blocks[0]?.id ?? null;
}

function duplicateBlock(id: string): void {
  const src = layout.value.blocks.find((b) => b.id === id);
  if (!src) return;
  const copy: PosterBlockDto = {
    ...src,
    id: nextBlockId(layout.value, src.type),
    x: src.x + 24,
    y: src.y + 24,
    z: src.z + 1,
  };
  layout.value.blocks.push(copy);
  selectedId.value = copy.id;
}

/** 置顶 / 置底：把 z 拉到全组最大 / 最小之外 */
function toFront(id: string): void {
  const b = layout.value.blocks.find((x) => x.id === id);
  if (!b) return;
  b.z = Math.max(0, ...layout.value.blocks.map((x) => x.z)) + 1;
}

function toBack(id: string): void {
  const b = layout.value.blocks.find((x) => x.id === id);
  if (!b) return;
  b.z = Math.min(...layout.value.blocks.map((x) => x.z)) - 1;
  if (b.z < 0) {
    // z 有下界 0，整体上移一层再把它压到 0
    for (const x of layout.value.blocks) x.z += 1;
    b.z = 0;
  }
}

/* ---------------- 版式操作 ---------------- */

function applyPreset(key: PosterPresetKey): void {
  layout.value = posterPresetOf(key);
  selectedId.value = layout.value.blocks[0]?.id ?? null;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const saved = await api.admin.posterSettings.get();
    layout.value = saved.layout ?? posterPresetOf('classic');
    selectedId.value = layout.value.blocks[0]?.id ?? null;
  } catch {
    layout.value = posterPresetOf('classic');
    selectedId.value = layout.value.blocks[0]?.id ?? null;
  } finally {
    loading.value = false;
    await paint();
  }
}

async function save(): Promise<void> {
  // 前端先按同一份 schema 自检，避免把服务端拒绝的脏数据发出去
  const parsed = posterLayoutSchema.safeParse(layout.value);
  if (!parsed.success) {
    ElMessage.error(`版式数据不合法：${parsed.error.issues[0]?.message ?? '请检查区块参数'}`);
    return;
  }
  saving.value = true;
  try {
    const res = await api.admin.posterLayout.save({ layout: parsed.data });
    layout.value = res;
    emit('saved', res);
    ElMessage.success('版式已保存，导出海报将使用此版式');
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

async function resetToDefault(): Promise<void> {
  saving.value = true;
  try {
    // 只清版式，不碰二维码与标题
    await api.admin.posterLayout.save({ layout: null });
    emit('saved', null);
    layout.value = posterPresetOf('classic');
    selectedId.value = layout.value.blocks[0]?.id ?? null;
    ElMessage.success('已恢复为预设版式，导出将按所选预设渲染');
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

/** 导出当前设计的预览图，用于快速确认最终效果 */
async function exportPreview(): Promise<void> {
  const event = props.event;
  if (!event) return;
  exporting.value = true;
  try {
    const canvas = await renderPoster({
      event,
      layout: layout.value,
      qrUrl: props.qrUrl,
      siteQrUrl: props.siteQrUrl,
      brandTitle: props.brandTitle,
    });
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('导出失败');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${event.title.replace(/[\\/:*?"<>|]/g, '_')}-海报预览.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    ElMessage.error('预览导出失败，请重试');
  } finally {
    exporting.value = false;
  }
}

/* ---------------- 尺寸自适应 ---------------- */

let ro: ResizeObserver | null = null;

/**
 * 量画布容器宽度。
 *
 * 只认 `clientWidth`，并且必须用 `Math.max(1, ...)` 兜底：
 * 量到 0 时 scale 会变成 0，热区全部塌到左上角，看起来就是「框和内容错位」。
 */
function measure(): void {
  const el = stageEl.value;
  if (!el) return;
  const w = el.clientWidth;
  if (w > 0) stageW.value = w;
}

/**
 * stageEl 只有在 `loading` 结束后才会被渲染出来（模板里是 v-if/v-else），
 * 所以不能只在 onMounted 里量一次——那时元素还不存在，量不到就等于一直用默认 520，
 * 热区与画布就会按不同比例缩放，出现「框和图片对不上、图被拉宽」。
 * 这里监听元素本身，一旦出现就立刻测量并挂上 ResizeObserver。
 */
watch(stageEl, (el) => {
  ro?.disconnect();
  ro = null;
  if (!el) return;
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
  }
}, { flush: 'post', immediate: true });

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await load();
  // 数据到位、模板切到 v-else 之后，再补量一次
  await nextTick();
  measure();
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pointermove', onDragMove);
  if (renderTimer !== null) window.clearTimeout(renderTimer);
});

/** 区块在画布上的 left/top/宽/高（已乘缩放比） */
function boxStyle(b: PosterBlockDto): Record<string, string> {
  const s = scale.value;
  return {
    left: `${b.x * s}px`,
    top: `${b.y * s}px`,
    width: `${b.w * s}px`,
    height: `${b.h * s}px`,
  };
}

function labelOf(type: PosterBlockType): string {
  return POSTER_BLOCK_META[type].label;
}
</script>

<template>
  <div class="poster-designer">
    <!-- 顶部工具条：预设 / 保存 / 导出 -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-xs text-slate-500">起始版式</span>
      <el-button v-for="p in PRESETS" :key="p.key" size="small" @click="applyPreset(p.key)">
        {{ p.label }}
      </el-button>
      <div class="flex-1" />
      <el-button size="small" :loading="exporting" @click="exportPreview">导出预览</el-button>
      <el-button size="small" @click="resetToDefault">恢复预设</el-button>
      <el-button size="small" type="primary" :loading="saving" @click="save">保存版式</el-button>
    </div>

    <div v-if="loading" class="py-16 text-center text-sm text-slate-500">加载版式中…</div>

    <div v-else class="flex flex-col gap-4 lg:flex-row">
      <!-- 画布 -->
      <div class="min-w-0 flex-1">
        <div ref="stageEl" class="poster-stage">
          <div class="poster-canvas-wrap">
            <canvas ref="previewCanvas" class="poster-preview" />
            <!-- 交互层：只画框，不承载像素，避免拖拽时反复重绘 Canvas -->
            <div class="poster-hotspots">
              <!--
                **必须按 z 排序渲染**：热区没有 z-index，谁在后面谁的点击优先级高。
                原先是按 layout.blocks 的数组顺序渲染，而画布是按 z 绘制 → 两者不一致：
                新增区块会被 push 到数组末尾拿到最高 z，于是它既盖住别人、
                又因为「单模特场次不绘制」而变成一层透明的点击拦截器。
              -->
              <div
                v-for="b in hitOrderBlocks"
                :key="b.id"
                class="poster-hotspot"
                :class="{
                  'is-selected': b.id === selectedId,
                  'is-hidden': !b.visible,
                  'is-skipped': skippedInRender.has(b.id),
                }"
                :style="boxStyle(b)"
                @pointerdown="beginDrag($event, b, 'move')"
                @click.stop="onHotspotClick($event, b)"
              >
                <span class="poster-hotspot-label">
                  {{ labelOf(b.type) }}<template v-if="skippedInRender.has(b.id)">（本场不显示）</template>
                </span>
                <template v-if="b.id === selectedId">
                  <span class="poster-handle nw" @pointerdown="beginDrag($event, b, 'resize-nw')" />
                  <span class="poster-handle ne" @pointerdown="beginDrag($event, b, 'resize-ne')" />
                  <span class="poster-handle sw" @pointerdown="beginDrag($event, b, 'resize-sw')" />
                  <span class="poster-handle se" @pointerdown="beginDrag($event, b, 'resize-se')" />
                </template>
              </div>
            </div>
            <!-- 对齐辅助线：拖动/缩放时吸附到其它区块的边缘与中线、画布中线 -->
            <div class="poster-guides">
              <span v-for="x in guides.vertical" :key="`v${x}`" class="poster-guide v" :style="{ left: `${x * scale}px` }" />
              <span v-for="y in guides.horizontal" :key="`h${y}`" class="poster-guide h" :style="{ top: `${y * scale}px` }" />
            </div>
            <div v-if="rendering" class="poster-rendering">渲染中…</div>
          </div>
        </div>
        <p class="mt-2 text-[11px] leading-5 text-slate-500">
          拖动区块本体移动，拖四角缩放，方向键微调（Shift 加速），Delete 删除；
          拖动时会自动吸附到其它区块的边缘与中线。
          区块被大图盖住时，按住 <kbd class="rounded border border-slate-300 px-1">Alt</kbd>
          再点击可在重叠的区块之间循环选中。
        </p>
      </div>

      <!-- 右侧面板 -->
      <div class="w-full shrink-0 lg:w-[320px]">
        <el-card shadow="never" class="mb-3">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-800">区块图层</span>
              <span class="text-[11px] text-slate-400">{{ layout.blocks.length }} 个</span>
            </div>
          </template>
          <div class="max-h-[220px] space-y-1 overflow-y-auto pr-1">
            <div
              v-for="b in orderedBlocks"
              :key="b.id"
              class="flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
              :class="b.id === selectedId
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 hover:border-slate-300'"
              @click="selectedId = b.id"
            >
              <el-checkbox
                :model-value="b.visible"
                size="small"
                @click.stop
                @change="(v: any) => { b.visible = Boolean(v); }"
              />
              <span class="min-w-0 flex-1 truncate text-slate-700">{{ labelOf(b.type) }}</span>
              <span class="shrink-0 text-[10px] text-slate-400">z{{ b.z }}</span>
            </div>
          </div>
        </el-card>

        <el-card v-if="selected" shadow="never" class="mb-3">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-800">{{ labelOf(selected.type) }}</span>
              <div class="flex gap-1">
                <el-button size="small" text @click="duplicateBlock(selected.id)">复制</el-button>
                <el-button size="small" text type="danger" @click="removeBlock(selected.id)">删除</el-button>
              </div>
            </div>
          </template>

          <p class="mb-3 text-[11px] leading-5 text-slate-500">
            {{ POSTER_BLOCK_META[selected.type].hint }}
          </p>

          <div class="grid grid-cols-2 gap-2">
            <el-form-item label="X" label-width="52px" class="!mb-2">
              <el-input-number v-model="selected.x" :step="1" size="small" controls-position="right" class="w-full" />
            </el-form-item>
            <el-form-item label="Y" label-width="52px" class="!mb-2">
              <el-input-number v-model="selected.y" :step="1" size="small" controls-position="right" class="w-full" />
            </el-form-item>
            <el-form-item label="宽" label-width="52px" class="!mb-2">
              <el-input-number v-model="selected.w" :min="24" :step="1" size="small" controls-position="right" class="w-full" />
            </el-form-item>
            <el-form-item label="高" label-width="52px" class="!mb-2">
              <el-input-number v-model="selected.h" :min="8" :step="1" size="small" controls-position="right" class="w-full" />
            </el-form-item>
          </div>

          <div class="mt-1 flex gap-1">
            <el-button size="small" @click="toFront(selected.id)">置顶</el-button>
            <el-button size="small" @click="toBack(selected.id)">置底</el-button>
          </div>

          <!-- 文字类区块 -->
          <template v-if="['title', 'intro', 'footer', 'text', 'qr', 'brand'].includes(selected.type)">
            <el-divider class="!my-3" />
            <el-form-item label="文案" label-width="52px" class="!mb-2">
              <el-input
                v-model="selected.text"
                type="textarea"
                :rows="2"
                maxlength="120"
                show-word-limit
                size="small"
                :placeholder="selected.type === 'title' ? '留空则用场次标题' : '留空使用默认文案'"
              />
            </el-form-item>
            <div class="grid grid-cols-2 gap-2">
              <el-form-item label="字号" label-width="52px" class="!mb-2">
                <el-input-number
                  v-model="selected.fontSize"
                  :min="10"
                  :max="160"
                  size="small"
                  controls-position="right"
                  placeholder="自动"
                  class="w-full"
                />
              </el-form-item>
              <el-form-item label="对齐" label-width="52px" class="!mb-2">
                <el-select v-model="selected.align" size="small" clearable placeholder="默认">
                  <el-option label="左对齐" value="left" />
                  <el-option label="居中" value="center" />
                  <el-option label="右对齐" value="right" />
                </el-select>
              </el-form-item>
            </div>
            <el-form-item v-if="selected.type === 'text'" label="颜色" label-width="52px" class="!mb-2">
              <el-color-picker v-model="selected.color" size="small" />
              <span class="ml-2 text-[11px] text-slate-400">{{ selected.color || '默认白色' }}</span>
            </el-form-item>
          </template>

          <!-- 图片类区块 -->
          <template v-if="['stage', 'stage2', 'wardrobe', 'wardrobe2', 'venue'].includes(selected.type)">
            <el-divider class="!my-3" />
            <el-form-item label="填充方式" label-width="76px" class="!mb-2">
              <el-radio-group v-model="selected.fit" size="small">
                <el-radio-button value="contain">完整</el-radio-button>
                <el-radio-button value="cover">裁切</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <p class="text-[11px] leading-5 text-slate-500">
              完整 = 不裁切，服装与场地推荐；
              裁切 = 铺满区块，主视觉大图更饱满。
            </p>
            <!--
              绑定模特：双模特场次两位穿的衣服不同，服装/照片必须指明取谁的。
              标签宽度给足 76px，否则「对应模特」这种四字标签会被挤成两行。
            -->
            <el-form-item
              v-if="['stage', 'stage2', 'wardrobe', 'wardrobe2'].includes(selected.type)"
              label="对应模特"
              label-width="76px"
              class="!mb-2 mt-2"
            >
              <el-select v-model="selected.modelIndex" size="small" class="w-full">
                <el-option
                  v-for="(m, i) in (props.event?.models ?? [])"
                  :key="m.id"
                  :label="`模特 ${i + 1} · ${m.stageName}`"
                  :value="i"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="自定义图" label-width="76px" class="!mb-0 mt-2">
              <el-input
                v-model="selected.imageUrl"
                size="small"
                clearable
                placeholder="留空用场次自带图片"
              />
            </el-form-item>
          </template>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <span class="text-sm font-medium text-slate-800">添加区块</span>
          </template>
          <div class="flex flex-wrap gap-1.5">
            <el-button
              v-for="t in addableTypes"
              :key="t"
              size="small"
              @click="addBlock(t)"
            >
              + {{ labelOf(t) }}
            </el-button>
          </div>
          <p v-if="!addableTypes.length" class="text-[11px] text-slate-400">
            所有区块都在画布上了；可以调出隐藏区块或添加自定义文字。
          </p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.poster-stage {
  width: 100%;
  /**
   * 让整张海报一屏放得下：按视口高度反推最大宽度，再居中。
   *
   * 预览是 1080:1620 的竖图，按容器宽度铺满时整幅图会高过弹窗，
   * 底部文案区（价格、页脚）始终要滚动才能看到，排版时看不到全貌。
   * 这里用 (视口高 - 上下留白) × (1080/1620) 作为宽度上限。
   */
  max-width: calc((100vh - 300px) * 0.6667);
  margin-left: auto;
  margin-right: auto;
}

/**
 * 画布容器：**用 aspect-ratio 定比例**，高度不再由 JS 算出来的 px 决定。
 *
 * 原来高度绑的是 `stageH = 1620 * scale`，而宽度是 100%；
 * 一旦 scale 没量准（元素还没渲染 / 量到 0），宽高比就错，
 * `.poster-preview` 又是 width/height 都 100%，图片于是被横向拉宽。
 * 交给 aspect-ratio 之后，宽高比恒为 1080:1620，与 scale 是否准确无关。
 */
.poster-canvas-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1080 / 1620;
  overflow: hidden;
  border-radius: 12px;
  background: #0b0d12;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
}

/** 预览画布必须严格铺满容器且不改变宽高比 */
.poster-preview {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.poster-hotspots {
  position: absolute;
  inset: 0;
}

.poster-hotspot {
  position: absolute;
  border: 1px dashed rgba(148, 163, 184, 0.55);
  cursor: move;
  user-select: none;
  box-sizing: border-box;
}

.poster-hotspot.is-hidden {
  border-style: dotted;
  opacity: 0.35;
  /* 隐藏的区块不参与命中，否则会挡住下面的区块 */
  pointer-events: none;
}

/**
 * 本场不会绘制的区块（如单模特场次里的「第二模特图」）：
 * 保留在设计器里方便配置，但**绝不能接收点击**——
 * 它在画面上是透明的，一旦吃掉点击就变成「点这个却选中了那个」。
 */
.poster-hotspot.is-skipped {
  border-color: rgba(148, 163, 184, 0.35);
  opacity: 0.45;
  pointer-events: none;
}

.poster-hotspot.is-skipped .poster-hotspot-label {
  background: #94a3b8;
}

/* 对齐辅助线 */
.poster-guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.poster-guide {
  position: absolute;
  background: #f43f5e;
  opacity: 0.9;
}

.poster-guide.v {
  top: 0;
  bottom: 0;
  width: 1px;
}

.poster-guide.h {
  left: 0;
  right: 0;
  height: 1px;
}

.poster-hotspot.is-selected {
  border: 2px solid #2563eb;
  background: rgba(37, 99, 235, 0.08);
}

.poster-hotspot-label {
  position: absolute;
  top: -19px;
  left: -1px;
  padding: 0 4px;
  border-radius: 3px;
  background: #2563eb;
  color: #fff;
  font-size: 10px;
  line-height: 17px;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.12s;
}

.poster-hotspot:hover .poster-hotspot-label,
.poster-hotspot.is-selected .poster-hotspot-label {
  opacity: 1;
}

.poster-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid #fff;
  border-radius: 2px;
  background: #2563eb;
}

.poster-handle.nw { top: -5px; left: -5px; cursor: nwse-resize; }
.poster-handle.ne { top: -5px; right: -5px; cursor: nesw-resize; }
.poster-handle.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
.poster-handle.se { bottom: -5px; right: -5px; cursor: nwse-resize; }

.poster-rendering {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.7);
  color: #fff;
  font-size: 10px;
}
</style>
