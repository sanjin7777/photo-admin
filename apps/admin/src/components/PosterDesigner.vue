<script setup lang="ts">
/**
 * 海报设计器：低代码拖拽排版 + 配色主题。
 *
 * 左侧 = 画布（1080×1620 等比缩放到容器里，鼠标事件换算回画布像素）；
 * 左栏 = 配色 / 区块图层，中栏 = 画布，右栏 = 选中区块属性 / 添加区块。
 *
 * 交互约定：
 * · 拖区块本体 = 移动；拖四角 = 缩放；方向键微调，Shift 加速；
 * · Shift + 点击 = 多选；多选后可对齐 / 分布 / 批量移动删除；
 * · Ctrl+Z / Ctrl+Shift+Z 撤销重做，Ctrl+C/V/D 复制粘贴副本，Ctrl+A 全选；
 * · 属性与配色改动立即反映到画布，点「保存版式」才落库；
 * · 所有坐标以画布像素存储，与导出 PNG 完全一致，所见即所得。
 *
 * 预览用的是**真实渲染器**（同一个 renderPoster），不是 HTML 模拟，
 * 所以画布里看到的字体、断行、价格配色就是最终导出的样子。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_POSTER_THEME,
  POSTER_BLOCK_META,
  POSTER_BLOCKS,
  POSTER_CANVAS,
  POSTER_THEMES,
  POSTER_THEME_PRESETS,
  newTextBlock,
  nextBlockId,
  posterLayoutSchema,
  posterPresetOf,
  posterThemeOf,
  type PosterBlockDto,
  type PosterBlockType,
  type PosterLayoutDto,
  type PosterPresetKey,
  type PosterThemeDto,
  type PosterThemeKey,
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
/**
 * 多选集合（Shift+点击 / 图层勾选 / Ctrl+A）。
 *
 * `selectedId` 始终是「主选中」——属性面板显示它；`multiSelected` 是完整集合，
 * 对齐 / 分布 / 批量移动都作用于它。单选时集合里就一个元素，逻辑统一不用分叉。
 */
const multiSelected = ref<Set<string>>(new Set());
const loading = ref(true);
const saving = ref(false);
const exporting = ref(false);
/**
 * 外层视口宽度（不随 zoom 变化）与内层实际画布宽度。
 *
 * 缩放必须作用在内层：若直接把 zoom 乘进 stageW，measure() 量到的又是放大后的宽度，
 * 会形成「越量越大」的正反馈，画布无限膨胀。分成两个量就彻底断开这个回路。
 */
const baseW = ref(520);
/** 视口可用高度：100% 时按它反推宽度，保证整张竖图一屏放得下 */
const viewportH = ref(720);
const stageViewportEl = ref<HTMLDivElement | null>(null);
const stageEl = ref<HTMLDivElement | null>(null);

/**
 * 「100%」的基准宽 = min(容器宽, 按视口可高反推的宽)。
 *
 * 竖图 1080:1620，只按容器宽铺满会高过弹窗，底部价格与页脚永远要滚动才看得到。
 * 与 CSS 里 `--pd-pane-h` 那条是同一条算式，这里显式算出来，缩放才有稳定基准。
 *
 * 260 是画布栏里画布以外的开销（顶部工具条 + 画布控制条 + 快捷键说明 + 弹窗上下留白）。
 * 改成三栏后左右栏各自限高，画布若还按整屏高换算就会比左右栏高出一截，
 * 弹窗又冒出滚动条——所以这里必须跟 CSS 的 `--pd-pane-h` 对齐口径。
 */
const PANE_CHROME = 348;

const fitW = computed(() => {
  const byHeight = Math.max(200, (viewportH.value - PANE_CHROME) * (CANVAS_W / CANVAS_H));
  return Math.max(160, Math.min(baseW.value, byHeight));
});

/** 画布缩放比：内层实际宽度 / 1080 */
const stageW = computed(() => fitW.value * zoom.value);
const scale = computed(() => stageW.value / CANVAS_W);
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const rendering = ref(false);
/** 重新渲染防抖句柄：拖动时不必每帧都跑一遍完整 Canvas 绘制 */
let renderTimer: number | null = null;

/* ---------------- 配色主题 ---------------- */

/** 当前生效的配色（null → 曜黑，与主题上线前一致） */
const theme = computed<PosterThemeDto>(() => layout.value.theme ?? DEFAULT_POSTER_THEME);

/** 命中的预设 key；三个色都被手改过则为 null（显示「自定义」） */
const activeThemeKey = computed<PosterThemeKey | null>(() => {
  const t = theme.value;
  return POSTER_THEMES.find((k) => {
    const p = POSTER_THEME_PRESETS[k];
    return p.bg === t.bg && p.accent === t.accent && p.text === t.text;
  }) ?? null;
});

/**
 * 底色是否偏亮：浅色主题下画布上的虚线框、标签需要换深色，
 * 否则白底上的浅灰框几乎看不见。与渲染器同一条判据（亮度 > 0.45）。
 */
const lightCanvas = computed(() => {
  const hex = theme.value.bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) > 0.45;
});

const THEME_LIST = POSTER_THEMES.map((k) => ({
  key: k,
  ...POSTER_THEME_PRESETS[k],
}));

function applyTheme(key: PosterThemeKey): void {
  pushHistory();
  layout.value.theme = posterThemeOf(key);
}

/** 取色器直接改三色之一；el-color-picker 清空时给回预设值，避免 null 触发 schema 报错 */
function setThemeColor(field: keyof PosterThemeDto, value: string | null): void {
  pushHistory();
  const fallback = DEFAULT_POSTER_THEME[field];
  layout.value.theme = { ...theme.value, [field]: value || fallback };
}

/* ---------------- 撤销 / 重做 ---------------- */

/**
 * 历史快照：存**整份版式的深拷贝**。
 *
 * 版式最多 40 个区块、每个十几个字段，整份快照的成本可以忽略，
 * 换来的是「任何改动都能回退」——比按操作类型写反向补丁可靠得多。
 * 拖动这类连续操作只在按下时记一次快照（见 beginDrag），
 * 否则一次拖动会塞进上百条历史，撤销要点半天。
 */
const HISTORY_LIMIT = 60;
const past = ref<string[]>([]);
const future = ref<string[]>([]);
const canUndo = computed(() => past.value.length > 0);
const canRedo = computed(() => future.value.length > 0);

const snapshot = (): string => JSON.stringify(layout.value);

function pushHistory(): void {
  past.value.push(snapshot());
  if (past.value.length > HISTORY_LIMIT) past.value.shift();
  future.value = [];
}

function undo(): void {
  const prev = past.value.pop();
  if (prev === undefined) return;
  future.value.push(snapshot());
  layout.value = JSON.parse(prev) as PosterLayoutDto;
  pruneSelection();
}

function redo(): void {
  const next = future.value.pop();
  if (next === undefined) return;
  past.value.push(snapshot());
  layout.value = JSON.parse(next) as PosterLayoutDto;
  pruneSelection();
}

/** 撤销后可能选中了已被删掉的区块，清理掉 */
function pruneSelection(): void {
  const ids = new Set(layout.value.blocks.map((b) => b.id));
  multiSelected.value = new Set([...multiSelected.value].filter((id) => ids.has(id)));
  if (selectedId.value && !ids.has(selectedId.value)) {
    selectedId.value = [...multiSelected.value][0] ?? layout.value.blocks[0]?.id ?? null;
  }
}

const selected = computed<PosterBlockDto | null>(
  () => layout.value.blocks.find((b) => b.id === selectedId.value) ?? null,
);

/** 多选时参与批量操作的区块（按 z 排序，保证对齐结果稳定） */
const selectedBlocks = computed(() =>
  orderedBlocks.value.filter((b) => multiSelected.value.has(b.id)),
);

const multiCount = computed(() => multiSelected.value.size);

function selectOnly(id: string | null): void {
  selectedId.value = id;
  multiSelected.value = id ? new Set([id]) : new Set();
}

/** Shift+点击：在集合里加/减，主选中切到刚点的那个 */
function toggleSelect(id: string): void {
  const next = new Set(multiSelected.value);
  if (next.has(id)) {
    next.delete(id);
    multiSelected.value = next;
    selectedId.value = [...next][next.size - 1] ?? null;
  } else {
    next.add(id);
    multiSelected.value = next;
    selectedId.value = id;
  }
}

function selectAll(): void {
  multiSelected.value = new Set(layout.value.blocks.map((b) => b.id));
  selectedId.value = layout.value.blocks[0]?.id ?? null;
}

function clearSelection(): void {
  selectOnly(null);
}

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
 * 上一次渲染中「画出来了但内容放不下」的区块。
 *
 * 典型场景：双人版场次安排只有 160px 高，三个时段排不下 → 第三场被省略。
 * 旧版只在海报标题里写「共 N 场」，运营看不出少了哪一场、也不知道该拉多高。
 * 现在渲染器回报 hidden / neededH，设计器直接给一条可点的修复提示。
 */
const renderOverflow = ref<Array<{ id: string; hidden: number; neededH: number }>>([]);

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

/**
 * 内容放不下的区块（渲染器回报）。
 *
 * 只保留仍存在于版式里、且当前可见的项：删掉区块或关掉显隐后提示要立刻消失，
 * 否则会留着一条点不动的僵尸告警。
 */
const overflowBlocks = computed(() => {
  const byId = new Map(layout.value.blocks.map((b) => [b.id, b]));
  return renderOverflow.value
    .filter((o) => byId.get(o.id)?.visible)
    .map((o) => ({ ...o, block: byId.get(o.id)!, label: POSTER_BLOCK_META[byId.get(o.id)!.type].label }));
});

/**
 * 一键把区块拉高到「刚好排得下」。
 *
 * 不去挤压邻居：只改自己的高度，若因此压到下方区块，
 * 由用户自己用对齐/分布收拾——设计器的原则是不偷偷改用户没选的区块。
 */
function fitOverflow(id: string): void {
  const target = renderOverflow.value.find((o) => o.id === id);
  const block = layout.value.blocks.find((b) => b.id === id);
  if (!target || !block) return;
  pushHistory();
  block.h = Math.min(3240, Math.max(block.h, target.neededH));
  selectOnly(id);
  ElMessage.success(`已把「${POSTER_BLOCK_META[block.type].label}」拉高到 ${block.h}px`);
}

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
        renderOverflow.value = [...info.overflow];
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
  /** 多选拖动时的整组初始位置；单选时只有一项 */
  group: Array<{ id: string; x: number; y: number }>;
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
    // 整组一起移动时，组内成员之间不该互相吸附（否则组会被拉扯变形）
    if (b.id === excludeId || multiSelected.value.has(b.id)) continue;
    if (!b.visible || skippedInRender.value.has(b.id)) continue;
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

  /**
   * Shift+按下 = 切换多选，不进入拖动。
   * 否则「想多选几个块对齐」会变成「把其中一个拖走了」。
   */
  if (ev.shiftKey && mode === 'move') {
    toggleSelect(block.id);
    return;
  }

  /**
   * 锁定区块不参与拖动与缩放。
   * 只拦「几何变更」，不拦选中：锁上之后还要能点开右侧面板解锁、改文字改颜色。
   */
  if (block.locked) {
    if (mode !== 'move') return;
    selectOnly(block.id);
    return;
  }

  // 拖到的块不在当前多选里 → 收成单选；在多选里 → 整组一起移动
  if (!multiSelected.value.has(block.id)) selectOnly(block.id);
  else selectedId.value = block.id;

  // 连续操作只记一次快照：一次拖动不该产生上百条历史
  pushHistory();

  // 整组拖动时跳过锁定块：锁定就是「别动我」，多选也不该把它带走
  const group = mode === 'move' && multiSelected.value.size > 1
    ? layout.value.blocks.filter((b) => multiSelected.value.has(b.id) && !b.locked)
    : [block];

  drag.value = {
    id: block.id,
    mode,
    startX: ev.clientX,
    startY: ev.clientY,
    origin: { x: block.x, y: block.y, w: block.w, h: block.h },
    group: group.map((b) => ({ id: b.id, x: b.x, y: b.y })),
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

    /**
     * 多选时按「主选块的位移」整组平移：
     * 用主块吸附后的实际位移（而不是鼠标原始位移），整组才会跟着吸附对齐。
     */
    const gdx = nx - d.origin.x;
    const gdy = ny - d.origin.y;
    for (const g of d.group) {
      const target = layout.value.blocks.find((b) => b.id === g.id);
      if (!target) continue;
      target.x = r(g.x + gdx);
      target.y = r(g.y + gdy);
    }
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
  // Shift+点击在 pointerdown 阶段已处理（切换多选），这里不再覆盖
  if (ev.shiftKey) return;
  if (!ev.altKey) {
    selectOnly(block.id);
    return;
  }

  // 把鼠标位置换算成画布坐标，才能判断「这一点上还压着哪些区块」
  const canvasEl = previewCanvas.value;
  if (!canvasEl) { selectOnly(block.id); return; }
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

/** 剪贴板：复制的是深拷贝，粘贴时重新分配 id，避免与原块撞 id */
const clipboard = ref<PosterBlockDto[]>([]);
const canPaste = computed(() => clipboard.value.length > 0);

/**
 * 全局快捷键。
 *
 * 只在设计器可见时生效（本组件挂在弹窗里，卸载即解绑）；
 * 焦点在输入框 / 取色器里时不抢按键，否则打字会触发删除。
 */
function onKeydown(ev: KeyboardEvent): void {
  const el = ev.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;

  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();

  if (mod) {
    let handled = true;
    switch (key) {
      case 'z': ev.shiftKey ? redo() : undo(); break;
      case 'y': redo(); break;
      case 'a': selectAll(); break;
      case 'c': copySelection(); break;
      case 'x': copySelection(); removeSelection(); break;
      case 'v': pasteClipboard(); break;
      case 'd': duplicateSelection(); break;
      case 's': void save(); break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
    return;
  }

  if (key === 'escape') { clearSelection(); return; }

  const targets = selectedBlocks.value.length ? selectedBlocks.value : (selected.value ? [selected.value] : []);
  if (!targets.length) return;

  const step = ev.shiftKey ? 10 : 1;
  let handled = true;
  switch (ev.key) {
    case 'ArrowLeft': nudgeSelection(-step, 0); break;
    case 'ArrowRight': nudgeSelection(step, 0); break;
    case 'ArrowUp': nudgeSelection(0, -step); break;
    case 'ArrowDown': nudgeSelection(0, step); break;
    case 'Delete':
    case 'Backspace': removeSelection(); break;
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
  sessions: { x: 72, y: 1200, w: 528, h: 192 },
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
  pushHistory();
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
        // 排版与效果一律用中性默认值：新加进来的区块与预设区块长得一样，
        // 用户想调再去右侧面板改，不要让「加一个文字」自带旋转或描边。
        rotation: 0,
        fontWeight: null,
        letterSpacing: null,
        lineHeightPct: null,
        shadow: true,
        strokeColor: null,
        strokeWidth: 0,
        bgColor: null,
        locked: false,
      };

  // 自定义文字块自带文案，但要让它落在现有内容之下，避免盖住标题
  if (type === 'text') block.z = maxZ + 1;

  layout.value.blocks.push(block);
  selectOnly(id);
}

function removeBlock(id: string): void {
  const i = layout.value.blocks.findIndex((b) => b.id === id);
  if (i < 0) return;
  pushHistory();
  layout.value.blocks.splice(i, 1);
  const next = new Set(multiSelected.value);
  next.delete(id);
  multiSelected.value = next;
  if (selectedId.value === id) {
    selectedId.value = [...next][0] ?? layout.value.blocks[0]?.id ?? null;
    if (selectedId.value) multiSelected.value = new Set([selectedId.value]);
  }
}

/** 删除整个选区（多选时一次删完，只记一条历史） */
function removeSelection(): void {
  const ids = multiSelected.value.size ? new Set(multiSelected.value) : new Set(selectedId.value ? [selectedId.value] : []);
  if (!ids.size) return;
  pushHistory();
  layout.value.blocks = layout.value.blocks.filter((b) => !ids.has(b.id));
  selectOnly(layout.value.blocks[0]?.id ?? null);
}

function duplicateBlock(id: string): void {
  const src = layout.value.blocks.find((b) => b.id === id);
  if (!src) return;
  pushHistory();
  const copy: PosterBlockDto = {
    ...src,
    id: nextBlockId(layout.value, src.type),
    x: src.x + 24,
    y: src.y + 24,
    z: src.z + 1,
  };
  layout.value.blocks.push(copy);
  selectOnly(copy.id);
}

/** 复制整组（Ctrl+D）：保持相对位置，整组偏移 24px */
function duplicateSelection(): void {
  const src = selectedBlocks.value.length ? selectedBlocks.value : (selected.value ? [selected.value] : []);
  if (!src.length) return;
  pushHistory();
  const copies: PosterBlockDto[] = [];
  for (const b of src) {
    const copy: PosterBlockDto = {
      ...b,
      id: nextBlockId(layout.value, b.type),
      x: b.x + 24,
      y: b.y + 24,
      z: b.z + 1,
    };
    layout.value.blocks.push(copy);
    copies.push(copy);
  }
  multiSelected.value = new Set(copies.map((c) => c.id));
  selectedId.value = copies[copies.length - 1]?.id ?? null;
}

function copySelection(): void {
  const src = selectedBlocks.value.length ? selectedBlocks.value : (selected.value ? [selected.value] : []);
  if (!src.length) return;
  clipboard.value = src.map((b) => ({ ...b }));
  ElMessage.success(`已复制 ${src.length} 个区块`);
}

function pasteClipboard(): void {
  if (!clipboard.value.length) return;
  if (layout.value.blocks.length + clipboard.value.length > 40) {
    ElMessage.warning('区块数量已达上限 40 个，无法继续粘贴');
    return;
  }
  pushHistory();
  const pasted: PosterBlockDto[] = [];
  for (const b of clipboard.value) {
    const copy: PosterBlockDto = {
      ...b,
      id: nextBlockId(layout.value, b.type),
      x: b.x + 32,
      y: b.y + 32,
      z: b.z + 1,
    };
    layout.value.blocks.push(copy);
    pasted.push(copy);
  }
  // 粘贴后剪贴板跟着挪，连续 Ctrl+V 会呈阶梯排开而不是叠在一处
  clipboard.value = pasted.map((b) => ({ ...b }));
  multiSelected.value = new Set(pasted.map((b) => b.id));
  selectedId.value = pasted[pasted.length - 1]?.id ?? null;
}

/** 方向键微调：整组一起动，只记一条历史 */
/**
 * 锁定的区块不参与任何几何变更。
 *
 * 对齐 / 分布 / 微调都是「一键改一批」，如果连锁定块也一起挪，
 * 用户精心定位好的 LOGO 会被一次「全选 + 左对齐」推走，而且很难发现。
 */
function editableOf(blocks: PosterBlockDto[]): PosterBlockDto[] {
  return blocks.filter((b) => !b.locked);
}

function nudgeSelection(dx: number, dy: number): void {
  const raw = selectedBlocks.value.length ? selectedBlocks.value : (selected.value ? [selected.value] : []);
  const targets = editableOf(raw);
  if (!targets.length) return;
  pushHistory();
  for (const b of targets) { b.x += dx; b.y += dy; }
}

/** 置顶 / 置底：把 z 拉到全组最大 / 最小之外 */
function toFront(id: string): void {
  const b = layout.value.blocks.find((x) => x.id === id);
  if (!b) return;
  pushHistory();
  b.z = Math.max(0, ...layout.value.blocks.map((x) => x.z)) + 1;
}

function toBack(id: string): void {
  const b = layout.value.blocks.find((x) => x.id === id);
  if (!b) return;
  pushHistory();
  b.z = Math.min(...layout.value.blocks.map((x) => x.z)) - 1;
  if (b.z < 0) {
    // z 有下界 0，整体上移一层再把它压到 0
    for (const x of layout.value.blocks) x.z += 1;
    b.z = 0;
  }
}

/**
 * 图层面板上下移一层：与相邻区块交换 z。
 *
 * 「置顶/置底」跨度太大，微调叠放关系时需要这种一格一格的移动。
 * z 相同时按数组顺序决定叠放，所以交换后要把 z 也拉成严格递增。
 */
function moveLayer(id: string, dir: -1 | 1): void {
  const ordered = orderedBlocks.value;
  const i = ordered.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  pushHistory();
  const a = ordered[i]!;
  const b = ordered[j]!;
  const za = a.z;
  a.z = b.z;
  b.z = za;
  if (a.z === b.z) {
    // 同 z：给目标方向让出一格，保证顺序真的变了
    if (dir === 1) a.z = Math.min(99, b.z + 1);
    else b.z = Math.min(99, a.z + 1);
  }
}

/* ---------------- 对齐 / 分布 ---------------- */

type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/**
 * 对齐：多选时以**整组外接矩形**为基准，单选时以画布为基准。
 *
 * 单选对齐画布是很常用的操作（「把标题水平居中」），
 * 多选对齐外接矩形则符合 Figma / Canva 的直觉。
 */
function alignSelection(mode: AlignMode): void {
  const raw = selectedBlocks.value.length ? selectedBlocks.value : (selected.value ? [selected.value] : []);
  const targets = editableOf(raw);
  if (!targets.length) {
    if (raw.length) ElMessage.info('选中的区块已锁定，先解锁再对齐');
    return;
  }
  pushHistory();

  const useCanvas = targets.length === 1;
  const left = useCanvas ? 0 : Math.min(...targets.map((b) => b.x));
  const right = useCanvas ? CANVAS_W : Math.max(...targets.map((b) => b.x + b.w));
  const top = useCanvas ? 0 : Math.min(...targets.map((b) => b.y));
  const bottom = useCanvas ? CANVAS_H : Math.max(...targets.map((b) => b.y + b.h));

  for (const b of targets) {
    switch (mode) {
      case 'left': b.x = left; break;
      case 'hcenter': b.x = Math.round((left + right) / 2 - b.w / 2); break;
      case 'right': b.x = right - b.w; break;
      case 'top': b.y = top; break;
      case 'vcenter': b.y = Math.round((top + bottom) / 2 - b.h / 2); break;
      case 'bottom': b.y = bottom - b.h; break;
    }
  }
}

/**
 * 等间距分布：首尾两块不动，中间的按「空隙相等」排开。
 * 至少要 3 块才有意义（2 块谈不上分布）。
 */
function distributeSelection(axis: 'h' | 'v'): void {
  const targets = editableOf(selectedBlocks.value);
  if (targets.length < 3) {
    ElMessage.info('等间距分布需要选中至少 3 个未锁定的区块');
    return;
  }
  pushHistory();
  if (axis === 'h') {
    const sorted = [...targets].sort((a, b) => a.x - b.x);
    const span = Math.max(...sorted.map((b) => b.x + b.w)) - Math.min(...sorted.map((b) => b.x));
    const totalW = sorted.reduce((s, b) => s + b.w, 0);
    const gap = (span - totalW) / (sorted.length - 1);
    let cursor = sorted[0]!.x;
    for (const b of sorted) { b.x = Math.round(cursor); cursor += b.w + gap; }
  } else {
    const sorted = [...targets].sort((a, b) => a.y - b.y);
    const span = Math.max(...sorted.map((b) => b.y + b.h)) - Math.min(...sorted.map((b) => b.y));
    const totalH = sorted.reduce((s, b) => s + b.h, 0);
    const gap = (span - totalH) / (sorted.length - 1);
    let cursor = sorted[0]!.y;
    for (const b of sorted) { b.y = Math.round(cursor); cursor += b.h + gap; }
  }
}

/** 统一尺寸：把选区里其它区块的宽/高/两者对齐到主选中块 */
function matchSize(mode: 'w' | 'h' | 'both'): void {
  const main = selected.value;
  const targets = editableOf(selectedBlocks.value.filter((b) => b.id !== main?.id));
  if (!main || !targets.length) return;
  pushHistory();
  for (const b of targets) {
    if (mode === 'w' || mode === 'both') b.w = main.w;
    if (mode === 'h' || mode === 'both') b.h = main.h;
  }
}

/** 锁定/解锁：只切换标记，不动几何；导出时 locked 不影响绘制 */
function toggleLock(id: string): void {
  const b = layout.value.blocks.find((x) => x.id === id);
  if (!b) return;
  pushHistory();
  b.locked = !b.locked;
}

/* ---------------- 版式操作 ---------------- */

function applyPreset(key: PosterPresetKey): void {
  pushHistory();
  // 换版式保留已选配色：排版和配色是两件独立的事
  layout.value = posterPresetOf(key, layout.value.theme);
  selectOnly(layout.value.blocks[0]?.id ?? null);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const saved = await api.admin.posterSettings.get();
    layout.value = saved.layout ?? posterPresetOf('classic');
  } catch {
    layout.value = posterPresetOf('classic');
  } finally {
    // 打开时清空历史：撤销不该退回「上一次的空白初始态」
    past.value = [];
    future.value = [];
    selectOnly(layout.value.blocks[0]?.id ?? null);
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
    pushHistory();
    layout.value = posterPresetOf('classic');
    selectOnly(layout.value.blocks[0]?.id ?? null);
    ElMessage.success('已恢复为预设版式，导出将按所选预设渲染');
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

/* ---------------- 版式 JSON 导入 / 导出 ---------------- */

/**
 * 把版式导出成 JSON 文件。
 *
 * 这是「模板」能力的落地方式：运营排好一张满意的图，导出 JSON 存着，
 * 下次换场次直接导入，不必从预设重新拖一遍。比在服务端建模板表轻得多，
 * 而且文件可以微信发给同事直接用。
 */
function exportLayoutJson(): void {
  const parsed = posterLayoutSchema.safeParse(layout.value);
  if (!parsed.success) {
    ElMessage.error('当前版式不合法，无法导出');
    return;
  }
  const blob = new Blob([JSON.stringify(parsed.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '猫爪社海报版式.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  ElMessage.success('版式已导出为 JSON，可保存为模板');
}

const jsonInput = ref<HTMLInputElement | null>(null);

function pickLayoutJson(): void {
  jsonInput.value?.click();
}

async function importLayoutJson(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = posterLayoutSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      ElMessage.error(`版式文件不合法：${parsed.error.issues[0]?.message ?? '请检查内容'}`);
      return;
    }
    pushHistory();
    layout.value = parsed.data;
    selectOnly(parsed.data.blocks[0]?.id ?? null);
    ElMessage.success('版式已导入，确认后点「保存版式」落库');
  } catch {
    ElMessage.error('无法解析该文件，请选择本工具导出的 JSON');
  }
}

/** 只重置配色，不动排版 */
function resetTheme(): void {
  pushHistory();
  layout.value.theme = null;
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

/* ---------------- 画布显示选项 ---------------- */

/** 手动缩放倍率（1 = 适应容器）。放大后画布可滚动，热区与内容同比例放大 */
const zoom = ref(1);
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function zoomBy(dir: -1 | 1): void {
  const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - zoom.value) < 0.001);
  const cur = i >= 0 ? i : ZOOM_STEPS.indexOf(1);
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, cur + dir));
  zoom.value = ZOOM_STEPS[next]!;
}

function resetZoom(): void {
  zoom.value = 1;
}

/** 是否显示区块虚线框：关掉就是「干净的成品预览」 */
const showFrames = ref(true);
/** 安全边距参考线：印刷/裁切常用的内缩 72px（与设计边距一致） */
const showSafeArea = ref(false);
/** 网格：每 60 画布像素一格，方便目测对齐 */
const showGrid = ref(false);

/**
 * 缩放 = 直接改 stage 的宽度上限。
 *
 * CSS 里那条 `max-width: calc(var(--pd-pane-h) * 0.6667)` 是「100% 时整张一屏可见」
 * 的基准；放大时必须用行内 max-width 覆盖它，否则 stage 变宽了画布仍被卡住，
 * 表现就是「点了 + 号没反应」。
 * 不用 transform: scale —— 那会把 canvas 位图一起缩放，放大后字会糊。
 */
const stageStyle = computed(() => ({
  width: `${Math.round(stageW.value)}px`,
  maxWidth: `${Math.round(stageW.value)}px`,
}));

/** 网格背景（按当前缩放换算成屏幕像素，保证放大后格子也跟着变大） */
const gridStyle = computed(() => {
  const cell = 60 * scale.value;
  const line = lightCanvas.value ? 'rgba(15,23,42,0.14)' : 'rgba(255,255,255,0.14)';
  return {
    backgroundSize: `${cell}px ${cell}px`,
    backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
  };
});

/** 安全边距（画布像素 → 屏幕像素） */
const safeStyle = computed(() => {
  const m = 72 * scale.value;
  return { left: `${m}px`, top: `${m}px`, right: `${m}px`, bottom: `${m}px` };
});

/* ---------------- 尺寸自适应 ---------------- */

let ro: ResizeObserver | null = null;

/**
 * 量画布容器宽度。
 *
 * 只认 `clientWidth`，并且必须用 `Math.max(1, ...)` 兜底：
 * 量到 0 时 scale 会变成 0，热区全部塌到左上角，看起来就是「框和内容错位」。
 *
 * 缩放（zoom）作用在**内层** `.poster-stage` 的宽度上，外层 viewport 宽度不变，
 * 所以这里量的是 viewport（stageViewportEl），缩放不会把 scale 算崩。
 */
function measure(): void {
  const el = stageViewportEl.value;
  if (!el) return;
  const w = el.clientWidth;
  if (w > 0) baseW.value = w;
  // 视口高度由 CSS 的 max-height 决定，量它才能算出「一屏放得下」的基准宽
  const h = window.innerHeight;
  if (h > 0) viewportH.value = h;
}

/**
 * stageEl 只有在 `loading` 结束后才会被渲染出来（模板里是 v-if/v-else），
 * 所以不能只在 onMounted 里量一次——那时元素还不存在，量不到就等于一直用默认 520，
 * 热区与画布就会按不同比例缩放，出现「框和图片对不上、图被拉宽」。
 * 这里监听元素本身，一旦出现就立刻测量并挂上 ResizeObserver。
 */
watch(stageViewportEl, (el) => {
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
  window.addEventListener('resize', measure);
  await load();
  // 数据到位、模板切到 v-else 之后，再补量一次
  await nextTick();
  measure();
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', measure);
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
  <div class="poster-designer" :class="{ 'is-light-canvas': lightCanvas }">
    <!-- 顶部工具条：版式 / 历史 / 模板 / 保存 -->
    <div class="pd-toolbar mb-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="pd-label">起始版式</span>
        <el-button v-for="p in PRESETS" :key="p.key" size="small" @click="applyPreset(p.key)">
          {{ p.label }}
        </el-button>

        <span class="pd-divider" />

        <el-tooltip content="撤销（Ctrl+Z）" placement="bottom">
          <el-button size="small" :disabled="!canUndo" @click="undo">↶ 撤销</el-button>
        </el-tooltip>
        <el-tooltip content="重做（Ctrl+Shift+Z）" placement="bottom">
          <el-button size="small" :disabled="!canRedo" @click="redo">↷ 重做</el-button>
        </el-tooltip>

        <span class="pd-divider" />

        <el-tooltip content="把当前版式存成 JSON 模板文件" placement="bottom">
          <el-button size="small" @click="exportLayoutJson">导出模板</el-button>
        </el-tooltip>
        <el-tooltip content="导入之前导出的 JSON 模板" placement="bottom">
          <el-button size="small" @click="pickLayoutJson">导入模板</el-button>
        </el-tooltip>
        <input ref="jsonInput" type="file" accept="application/json,.json" class="hidden" @change="importLayoutJson">

        <div class="flex-1" />
        <el-button size="small" :loading="exporting" @click="exportPreview">导出预览</el-button>
        <el-button size="small" @click="resetToDefault">恢复预设</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存版式</el-button>
      </div>
    </div>

    <div v-if="loading" class="py-16 text-center text-sm text-slate-500">加载版式中…</div>

    <div v-else class="pd-workbench">
      <!-- 左栏：配色 + 图层（原来都在右侧，堆成一长列才出现滚动条） -->
      <aside class="pd-pane pd-pane-left">
        <!-- 配色主题：色卡一键切换 + 三色微调 -->
        <el-card shadow="never" class="mb-3 pd-card">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-800">配色方案</span>
              <el-button size="small" text @click="resetTheme">恢复默认</el-button>
            </div>
          </template>

          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="t in THEME_LIST"
              :key="t.key"
              type="button"
              class="pd-swatch"
              :class="{ 'is-active': activeThemeKey === t.key }"
              :title="t.hint"
              @click="applyTheme(t.key)"
            >
              <span class="pd-swatch-art" :style="{ background: t.bg }">
                <span class="pd-swatch-bar" :style="{ background: t.accent }" />
                <span class="pd-swatch-line" :style="{ background: t.text }" />
                <span class="pd-swatch-line short" :style="{ background: t.text, opacity: 0.55 }" />
                <span class="pd-swatch-dot" :style="{ background: t.accent }" />
              </span>
              <span class="pd-swatch-name">{{ t.label }}</span>
            </button>
          </div>

          <p class="mt-2 text-[11px] leading-5 text-slate-500">
            {{ activeThemeKey ? THEME_LIST.find(t => t.key === activeThemeKey)?.hint : '自定义配色：三个颜色可分别微调' }}
          </p>

          <el-divider class="!my-3" />

          <div class="space-y-2">
            <div class="pd-colorrow">
              <span class="pd-colorname">底色</span>
              <el-color-picker
                :model-value="theme.bg"
                size="small"
                :predefine="['#080a0e', '#0c0a09', '#f6f4ef', '#071310', '#0d0a1a', '#061019']"
                @update:model-value="(v: string | null) => setThemeColor('bg', v)"
              />
              <code class="pd-colorcode">{{ theme.bg }}</code>
            </div>
            <div class="pd-colorrow">
              <span class="pd-colorname">主色</span>
              <el-color-picker
                :model-value="theme.accent"
                size="small"
                :predefine="['#f43f5e', '#d4a537', '#dc2626', '#34d399', '#a78bfa', '#38bdf8', '#fb923c', '#22d3ee']"
                @update:model-value="(v: string | null) => setThemeColor('accent', v)"
              />
              <code class="pd-colorcode">{{ theme.accent }}</code>
            </div>
            <div class="pd-colorrow">
              <span class="pd-colorname">正文</span>
              <el-color-picker
                :model-value="theme.text"
                size="small"
                :predefine="['#ffffff', '#faf7f0', '#1c1917', '#f0fdf4', '#f5f3ff', '#f0f9ff', '#0f172a']"
                @update:model-value="(v: string | null) => setThemeColor('text', v)"
              />
              <code class="pd-colorcode">{{ theme.text }}</code>
            </div>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-slate-500">
            次要文字、三档价格、图片蒙层与描边都由这三个色自动派生；
            浅色底会自动改用深色文字与提亮蒙层，不会出现「白底白字」。
          </p>
        </el-card>

        <el-card shadow="never" class="mb-3 pd-card">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-800">区块图层</span>
              <div class="flex items-center gap-2">
                <el-button size="small" text @click="selectAll">全选</el-button>
                <span class="text-[11px] text-slate-400">{{ layout.blocks.length }} 个</span>
              </div>
            </div>
          </template>
          <div class="pd-layers max-h-[240px] space-y-1 overflow-y-auto pr-1">
            <div
              v-for="(b, i) in orderedBlocks"
              :key="b.id"
              class="pd-layer"
              :class="{
                'is-main': b.id === selectedId,
                'is-multi': multiSelected.has(b.id) && b.id !== selectedId,
              }"
              @click="($event.shiftKey ? toggleSelect(b.id) : selectOnly(b.id))"
            >
              <el-checkbox
                :model-value="b.visible"
                size="small"
                @click.stop
                @change="(v: any) => { pushHistory(); b.visible = Boolean(v); }"
              />
              <span class="min-w-0 flex-1 truncate text-slate-700">{{ labelOf(b.type) }}</span>
              <!--
                锁图标直接放在图层行里：想解某个被锁的区块时，
                如果还得先选中再翻到右栏找开关，等于把「防误拖」变成了「难解锁」。
              -->
              <button
                v-if="b.locked"
                class="pd-lock is-on"
                type="button"
                title="已锁定位置，点击解锁"
                @click.stop="toggleLock(b.id)"
              >🔒</button>
              <button
                v-else
                class="pd-lock"
                type="button"
                title="锁定位置（防误拖）"
                @click.stop="toggleLock(b.id)"
              >🔓</button>
              <span class="shrink-0 text-[10px] text-slate-400">z{{ b.z }}</span>
              <span class="flex shrink-0 flex-col">
                <button
                  class="pd-layerbtn"
                  type="button"
                  title="上移一层"
                  :disabled="i === orderedBlocks.length - 1"
                  @click.stop="moveLayer(b.id, 1)"
                >▲</button>
                <button
                  class="pd-layerbtn"
                  type="button"
                  title="下移一层"
                  :disabled="i === 0"
                  @click.stop="moveLayer(b.id, -1)"
                >▼</button>
              </span>
            </div>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-slate-500">
            列表自下而上就是叠放顺序；勾选框控制该区块是否出现在海报上。
          </p>
        </el-card>

      </aside>

      <!-- 中栏：画布 -->
      <div class="pd-pane pd-pane-center min-w-0">
        <!-- 画布显示控制条：缩放 / 参考线 / 网格 / 选区操作 -->
        <div class="pd-canvasbar mb-2">
          <div class="flex items-center gap-1">
            <el-button size="small" text :disabled="zoom <= 0.5" @click="zoomBy(-1)">−</el-button>
            <button class="pd-zoom" type="button" title="点击回到 100%" @click="resetZoom">
              {{ Math.round(zoom * 100) }}%
            </button>
            <el-button size="small" text :disabled="zoom >= 2" @click="zoomBy(1)">＋</el-button>
          </div>

          <span class="pd-divider" />

          <el-tooltip content="显示/隐藏区块虚线框" placement="bottom">
            <el-button size="small" :type="showFrames ? 'primary' : 'default'" text bg @click="showFrames = !showFrames">
              区块框
            </el-button>
          </el-tooltip>
          <el-tooltip content="内缩 72px 安全边距，避免文字贴边被裁" placement="bottom">
            <el-button size="small" :type="showSafeArea ? 'primary' : 'default'" text bg @click="showSafeArea = !showSafeArea">
              安全边距
            </el-button>
          </el-tooltip>
          <el-tooltip content="60px 网格，方便目测对齐" placement="bottom">
            <el-button size="small" :type="showGrid ? 'primary' : 'default'" text bg @click="showGrid = !showGrid">
              网格
            </el-button>
          </el-tooltip>

          <div class="flex-1" />

          <template v-if="multiCount > 1">
            <span class="pd-chip">已选 {{ multiCount }} 个</span>
            <el-button size="small" text @click="duplicateSelection">复制组</el-button>
            <el-button size="small" text type="danger" @click="removeSelection">删除组</el-button>
            <el-button size="small" text @click="clearSelection">取消选择</el-button>
          </template>
          <span v-else class="pd-hint">Shift + 点击可多选</span>
        </div>

        <!--
          内容放不下的告警：不是「渲染失败」，而是「区块太矮，信息被省略」。
          必须显式告诉运营少了什么、以及一键补多高，否则导出的海报会静默少几场。
        -->
        <div v-if="overflowBlocks.length" class="pd-overflow mb-2">
          <div v-for="o in overflowBlocks" :key="o.id" class="pd-overflow-row">
            <span class="pd-overflow-icon">!</span>
            <span class="pd-overflow-text">
              「{{ o.label }}」高度不足，有 {{ o.hidden }} 个时段未显示
            </span>
            <button class="pd-overflow-fix" type="button" @click="fitOverflow(o.id)">
              拉高到 {{ o.neededH }}px
            </button>
            <button class="pd-overflow-jump" type="button" @click="selectOnly(o.id)">定位</button>
          </div>
        </div>

        <div ref="stageViewportEl" class="poster-viewport">
          <div ref="stageEl" class="poster-stage" :style="stageStyle">
            <div class="poster-canvas-wrap">
              <canvas ref="previewCanvas" class="poster-preview" />

              <!-- 网格 / 安全边距：纯参考层，不接收点击 -->
              <div v-if="showGrid" class="poster-grid" :style="gridStyle" />
              <div v-if="showSafeArea" class="poster-safe" :style="safeStyle" />

              <!-- 交互层：只画框，不承载像素，避免拖拽时反复重绘 Canvas -->
              <div class="poster-hotspots" :class="{ 'frames-off': !showFrames }">
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
                    'is-multi': multiSelected.has(b.id) && b.id !== selectedId,
                    'is-hidden': !b.visible,
                    'is-locked': b.locked,
                    'is-skipped': skippedInRender.has(b.id),
                  }"
                  :style="boxStyle(b)"
                  @pointerdown="beginDrag($event, b, 'move')"
                  @click.stop="onHotspotClick($event, b)"
                >
                  <span class="poster-hotspot-label">
                    {{ labelOf(b.type) }}<template v-if="skippedInRender.has(b.id)">（本场不显示）</template>
                    <template v-if="b.locked"> 🔒</template>
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
        </div>
        <p class="mt-2 text-[11px] leading-5 text-slate-500">
          拖动区块移动，拖四角缩放，方向键微调（Shift 加速）；
          <kbd class="pd-kbd">Shift</kbd>+点击多选后可对齐 / 分布 / 整组拖动，
          <kbd class="pd-kbd">Alt</kbd>+点击在重叠区块间循环选中。
          快捷键：<kbd class="pd-kbd">Ctrl+Z</kbd> 撤销、
          <kbd class="pd-kbd">Ctrl+D</kbd> 复制、
          <kbd class="pd-kbd">Ctrl+C/V</kbd> 复制粘贴、
          <kbd class="pd-kbd">Ctrl+A</kbd> 全选、
          <kbd class="pd-kbd">Ctrl+S</kbd> 保存、
          <kbd class="pd-kbd">Delete</kbd> 删除。
        </p>
      </div>

      <!-- 右栏：选中区块的属性（窄屏时排到最后） -->
      <aside class="pd-pane pd-pane-right">
        <!-- 多选对齐 / 分布 -->
        <el-card v-if="multiCount > 1" shadow="never" class="mb-3 pd-card">
          <template #header>
            <span class="text-sm font-medium text-slate-800">对齐与分布（{{ multiCount }} 个）</span>
          </template>
          <div class="grid grid-cols-3 gap-1.5">
            <el-button size="small" @click="alignSelection('left')">左对齐</el-button>
            <el-button size="small" @click="alignSelection('hcenter')">水平居中</el-button>
            <el-button size="small" @click="alignSelection('right')">右对齐</el-button>
            <el-button size="small" @click="alignSelection('top')">顶对齐</el-button>
            <el-button size="small" @click="alignSelection('vcenter')">垂直居中</el-button>
            <el-button size="small" @click="alignSelection('bottom')">底对齐</el-button>
          </div>
          <div class="mt-1.5 grid grid-cols-2 gap-1.5">
            <el-button size="small" :disabled="multiCount < 3" @click="distributeSelection('h')">横向等间距</el-button>
            <el-button size="small" :disabled="multiCount < 3" @click="distributeSelection('v')">纵向等间距</el-button>
          </div>
          <div class="mt-1.5 grid grid-cols-3 gap-1.5">
            <el-button size="small" @click="matchSize('w')">同宽</el-button>
            <el-button size="small" @click="matchSize('h')">同高</el-button>
            <el-button size="small" @click="matchSize('both')">同尺寸</el-button>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-slate-500">
            多选以整组外接矩形为基准；「同宽/同高」以最后选中的区块为准。
            只选一个区块时，对齐按钮以整张画布为基准。
          </p>
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
            <el-button
              size="small"
              :type="selected.locked ? 'warning' : 'default'"
              class="ml-auto"
              @click="toggleLock(selected.id)"
            >
              {{ selected.locked ? '已锁定' : '锁定位置' }}
            </el-button>
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
            <el-form-item label="颜色" label-width="52px" class="!mb-2">
              <el-color-picker v-model="selected.color" size="small" />
              <span class="ml-2 text-[11px] text-slate-400">{{ selected.color || '跟随主题配色' }}</span>
            </el-form-item>

            <!--
              排版四项：字重 / 字间距 / 行高 / 旋转。
              都设成「留空 = 用渲染器的默认值」而不是写死一个数，
              因为不同区块（大标题 vs 底部小字）的默认值本来就不同，
              面板一打开就把默认值固化成具体数字，等于把渲染器的自适应废掉了。
            -->
            <el-divider class="!my-3">排版</el-divider>
            <el-form-item label="字重" label-width="52px" class="!mb-2">
              <el-radio-group v-model="selected.fontWeight" size="small">
                <el-radio-button :value="null">默认</el-radio-button>
                <el-radio-button :value="400">细</el-radio-button>
                <el-radio-button :value="600">中</el-radio-button>
                <el-radio-button :value="800">粗</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <div class="grid grid-cols-2 gap-2">
              <el-form-item label="字距" label-width="52px" class="!mb-2">
                <el-input-number
                  v-model="selected.letterSpacing"
                  :min="-6"
                  :max="24"
                  size="small"
                  controls-position="right"
                  placeholder="默认"
                  class="w-full"
                />
              </el-form-item>
              <el-form-item label="行高%" label-width="56px" class="!mb-2">
                <el-input-number
                  v-model="selected.lineHeightPct"
                  :min="80"
                  :max="260"
                  :step="5"
                  size="small"
                  controls-position="right"
                  placeholder="默认"
                  class="w-full"
                />
              </el-form-item>
            </div>
            <el-form-item label="旋转" label-width="52px" class="!mb-2">
              <div class="flex w-full items-center gap-2">
                <el-slider
                  v-model="selected.rotation"
                  :min="-180"
                  :max="180"
                  :step="1"
                  class="flex-1"
                  :show-tooltip="false"
                />
                <el-input-number
                  v-model="selected.rotation"
                  :min="-180"
                  :max="180"
                  size="small"
                  controls-position="right"
                  class="!w-[92px]"
                />
              </div>
            </el-form-item>

            <!-- 文字效果三项：阴影 / 描边 / 底板 -->
            <el-divider class="!my-3">效果</el-divider>
            <el-form-item label="阴影" label-width="52px" class="!mb-2">
              <el-switch v-model="selected.shadow" size="small" />
              <span class="ml-2 text-[11px] text-slate-400">
                {{ selected.shadow ? '深色描边底更清晰' : '关闭后文字更干净' }}
              </span>
            </el-form-item>
            <div class="grid grid-cols-2 gap-2">
              <el-form-item label="描边" label-width="52px" class="!mb-2">
                <el-color-picker v-model="selected.strokeColor" size="small" />
              </el-form-item>
              <el-form-item label="宽度" label-width="52px" class="!mb-2">
                <el-input-number
                  v-model="selected.strokeWidth"
                  :min="0"
                  :max="12"
                  size="small"
                  controls-position="right"
                  class="w-full"
                />
              </el-form-item>
            </div>
            <el-form-item label="底板" label-width="52px" class="!mb-0">
              <el-color-picker v-model="selected.bgColor" size="small" />
              <span class="ml-2 text-[11px] text-slate-400">{{ selected.bgColor || '无底色' }}</span>
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
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
 * 设计器自身的视觉语言
 *
 * 这套面板是「印刷工作台」：深色石墨台面 + 玫红主色 + 琥珀提示，
 * 与海报本身的配色同源，所以换主题时工作台不会显得像另一个产品。
 * 所有滚动条都按这套调色板自绘，不留浏览器默认的灰条。
 * ============================================================ */
.poster-designer {
  --pd-ink: #0b1020;
  --pd-surface: #ffffff;
  --pd-surface-2: #f7f8fb;
  --pd-line: #e3e7ef;
  --pd-line-strong: #cdd5e3;
  --pd-accent: #f43f5e;
  --pd-accent-soft: rgba(244, 63, 94, 0.1);
  --pd-blue: #2563eb;
  --pd-blue-soft: rgba(37, 99, 235, 0.1);
  --pd-amber: #d97706;
  --pd-text: #1f2937;
  --pd-muted: #64748b;
}

/* ---------------- 工具条 ---------------- */

.pd-toolbar {
  padding: 8px 10px;
  border: 1px solid var(--pd-line);
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff 0%, var(--pd-surface-2) 100%);
}

.pd-label {
  font-size: 12px;
  color: var(--pd-muted);
}

/** 工具条分组之间的竖分隔线 */
.pd-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--pd-line-strong);
}

/* ---------------- 画布控制条 ---------------- */

.pd-canvasbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--pd-line);
  border-radius: 10px;
  background: var(--pd-surface-2);
}

.pd-zoom {
  min-width: 52px;
  padding: 2px 6px;
  border: 1px solid var(--pd-line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--pd-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.pd-zoom:hover {
  border-color: var(--pd-accent);
  color: var(--pd-accent);
}

.pd-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--pd-blue-soft);
  color: var(--pd-blue);
  font-size: 11px;
  font-weight: 600;
}

.pd-hint {
  font-size: 11px;
  color: var(--pd-muted);
}

.pd-kbd {
  display: inline-block;
  padding: 0 4px;
  border: 1px solid var(--pd-line-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fff;
  color: var(--pd-text);
  font-size: 10px;
  line-height: 16px;
}

/* ---------------- 内容溢出告警 ---------------- */

.pd-overflow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pd-overflow-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid rgba(245, 158, 11, 0.42);
  border-left-width: 3px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.04));
}

.pd-overflow-icon {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--pd-amber);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.pd-overflow-text {
  flex: 1;
  min-width: 140px;
  color: #92400e;
  font-size: 12px;
  font-weight: 500;
}

.pd-overflow-fix,
.pd-overflow-jump {
  padding: 3px 9px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.pd-overflow-fix {
  border: 1px solid var(--pd-amber);
  background: var(--pd-amber);
  color: #fff;
}

.pd-overflow-fix:hover {
  border-color: #d97706;
  background: #d97706;
}

.pd-overflow-jump {
  border: 1px solid rgba(146, 64, 14, 0.32);
  background: transparent;
  color: #92400e;
}

.pd-overflow-jump:hover {
  border-color: #92400e;
  background: rgba(146, 64, 14, 0.08);
}

/* ---------------- 卡片 ---------------- */

.pd-card :deep(.el-card__header) {
  padding: 10px 14px;
}

.pd-card :deep(.el-card__body) {
  padding: 12px 14px;
}

/* ---------------- 三栏工作台 ----------------
 * 原来所有面板都堆在画布右侧一列里，光是配色 + 图层 + 属性就超过一屏，
 * 弹窗内必然出现整页滚动条——滚一下画布就看不见了。
 *
 * 现在改成：左栏配色/图层、中栏画布、右栏选中属性。
 * 关键点是「每栏各自滚动」：三栏等高，画布居中不滚，
 * 左右两栏自己 overflow-y:auto，滚到底也只在栏内滚，画布原地不动。
 * ============================================================ */

.pd-workbench {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/**
 * 三栏的统一高度预算：画布高度与左右栏高度都从这里取，保证三者齐平。
 *
 * 340px 是弹窗自身的开销（4vh 上边距 + 标题栏 + 底部按钮栏 + 顶部工具条 + 画布控制条 + 快捷键说明）。
 * 不留给它，画布按容纳宽度撑开后总高就会超出视口，弹窗又冒出整页滚动条。
 * 上限 700px 是为了在超宽大屏上别把海报拉得过大。
 */
.poster-designer {
  --pd-pane-h: min(700px, calc(100dvh - 340px));
}
.pd-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/**
 * 窄屏（<1024px）单列堆叠时不要给面板限高：
 * 手机上弹窗本身就是全屏滚动，再套一个内层滚动条会变成「滚不动」的套娃。
 */
@media (min-width: 1024px) {
  .pd-workbench {
    flex-direction: row;
    align-items: flex-start;
  }

  .pd-pane-left {
    width: 268px;
    flex: 0 0 268px;
    max-height: var(--pd-pane-h);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 2px;
  }

  .pd-pane-center {
    flex: 1 1 auto;
    min-width: 0;
  }

  .pd-pane-right {
    width: 320px;
    flex: 0 0 320px;
    max-height: var(--pd-pane-h);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-left: 2px;
  }
}

/* ---------------- 配色色卡 ---------------- */

.pd-swatch {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--pd-line);
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.pd-swatch:hover {
  border-color: var(--pd-line-strong);
  transform: translateY(-1px);
}

.pd-swatch.is-active {
  border-color: var(--pd-accent);
  box-shadow: 0 0 0 2px var(--pd-accent-soft);
}

/**
 * 色卡缩略图：不是纯色块，而是「这张海报长什么样」的抽象版——
 * 一条主色竖条 + 两行正文 + 一个价格胶囊，换配色时能一眼看出差异。
 */
.pd-swatch-art {
  position: relative;
  display: block;
  height: 44px;
  border-radius: 7px;
  overflow: hidden;
}

.pd-swatch-bar {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 3px;
  height: 12px;
  border-radius: 2px;
}

.pd-swatch-line {
  position: absolute;
  left: 8px;
  height: 3px;
  border-radius: 2px;
}

.pd-swatch-line:nth-of-type(2) {
  top: 24px;
  width: 60%;
}

.pd-swatch-line.short {
  top: 31px;
  width: 38%;
}

.pd-swatch-dot {
  position: absolute;
  right: 7px;
  bottom: 7px;
  width: 16px;
  height: 9px;
  border-radius: 3px;
  opacity: 0.85;
}

.pd-swatch-name {
  font-size: 11px;
  line-height: 16px;
  color: var(--pd-text);
  text-align: center;
}

.pd-swatch.is-active .pd-swatch-name {
  color: var(--pd-accent);
  font-weight: 600;
}

.pd-colorrow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pd-colorname {
  width: 32px;
  font-size: 12px;
  color: var(--pd-muted);
}

.pd-colorcode {
  font-size: 11px;
  color: var(--pd-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---------------- 图层列表 ---------------- */

.pd-layer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 1px solid var(--pd-line);
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}

.pd-layer:hover {
  border-color: var(--pd-line-strong);
}

.pd-layer.is-main {
  border-color: var(--pd-blue);
  background: var(--pd-blue-soft);
}

/** 多选里的非主选中：用主色区分「主选中」与「一起被选中」 */
.pd-layer.is-multi {
  border-color: var(--pd-accent);
  background: var(--pd-accent-soft);
}

.pd-layerbtn {
  width: 16px;
  height: 11px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--pd-muted);
  font-size: 8px;
  line-height: 11px;
  cursor: pointer;
}

.pd-layerbtn:hover:not(:disabled) {
  color: var(--pd-accent);
}

.pd-layerbtn:disabled {
  opacity: 0.3;
  cursor: default;
}

/** 锁定按钮：未锁时几乎不可见（避免干扰扫视），锁上后常亮琥珀 */
.pd-lock {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-size: 10px;
  line-height: 18px;
  opacity: 0.35;
  cursor: pointer;
  transition: opacity 0.12s, background 0.12s;
}

.pd-layer:hover .pd-lock {
  opacity: 0.8;
}

.pd-lock:hover {
  background: var(--pd-surface-2);
  opacity: 1;
}

.pd-lock.is-on {
  opacity: 1;
  background: rgba(217, 119, 6, 0.12);
}

/**
 * 滚动条自绘：细、圆角、颜色取自面板调色板，hover 变主色。
 * Firefox 用 scrollbar-* 兜底（不支持 ::-webkit-scrollbar）。
 */
.pd-layers {
  scrollbar-width: thin;
  scrollbar-color: var(--pd-line-strong) transparent;
}

.pd-layers::-webkit-scrollbar {
  width: 6px;
}

.pd-layers::-webkit-scrollbar-track {
  background: transparent;
}

.pd-layers::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--pd-line-strong);
}

.pd-layers::-webkit-scrollbar-thumb:hover {
  background: var(--pd-accent);
}

/* ---------------- 画布视口与参考层 ---------------- */

/**
 * 画布视口：缩放后画布会超出这里，由它出滚动条。
 * 关键是**它的宽度不随 zoom 变**，measure() 量的就是它，
 * 否则「量宽 → 放大 → 再量到更大的宽」会形成正反馈把画布撑爆。
 */
/**
 * 视口高度上限：与 `.poster-stage` 共用 `--pd-pane-h`。
 *
 * 早先这里写的是 `100vh - 260px`，而 stage 的宽度上限是 `(100vh - 300px) * 0.6667`，
 * 两者差着 40px 的口径 —— 三栏模式下这会多出一条没意义的滚动条。
 * 现在高度统一：阶段按 `--pd-pane-h * 0.6667` 定宽，视口按 `--pd-pane-h` 定高，
 * 100% 时海报正好铺满、放大后才出滚动条。
 */
.poster-viewport {
  overflow: auto;
  max-height: var(--pd-pane-h);
  padding: 2px;
  border-radius: 14px;
  background: repeating-conic-gradient(#f1f3f8 0% 25%, #e9ecf3 0% 50%) 0 0 / 16px 16px;
  scrollbar-width: thin;
  scrollbar-color: #b9c2d4 #eceff5;
}

.poster-viewport::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.poster-viewport::-webkit-scrollbar-track {
  border-radius: 999px;
  background: #eceff5;
}

.poster-viewport::-webkit-scrollbar-thumb {
  border: 2px solid #eceff5;
  border-radius: 999px;
  background: #b9c2d4;
}

.poster-viewport::-webkit-scrollbar-thumb:hover {
  background: var(--pd-accent);
}

.poster-viewport::-webkit-scrollbar-corner {
  background: #eceff5;
}

.poster-grid,
.poster-safe {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.poster-safe {
  inset: auto;
  border: 1px dashed rgba(217, 119, 6, 0.75);
  border-radius: 4px;
}

/**
 * 关掉区块框：只去掉描边与标签，命中区域保留（仍可拖动）。
 *
 * 用「border-color: transparent」而不是「border: none」，框的几何尺寸不变，
 * 热区不会因少了 1px 边框而错位。选中态与多选态也要一起收掉，
 * 否则关了框还留一圈蓝边，就不是「干净的成品预览」了。
 */
.poster-hotspots.frames-off .poster-hotspot,
.poster-hotspots.frames-off .poster-hotspot.is-selected,
.poster-hotspots.frames-off .poster-hotspot.is-multi {
  border-color: transparent;
  background: transparent;
}

.poster-hotspots.frames-off .poster-hotspot-label {
  opacity: 0 !important;
}

/** 关框后缩放手柄也藏起来，但命中区仍在（想调尺寸开回区块框即可） */
.poster-hotspots.frames-off .poster-handle {
  opacity: 0;
}

/** 多选中的非主选中：主色虚线，和主选中的蓝色实线区分 */
.poster-hotspot.is-multi {
  border: 2px dashed var(--pd-accent);
  background: rgba(244, 63, 94, 0.08);
}

/**
 * 浅色主题（如「素白朱砂」）下，浅灰虚线框在白底上几乎看不见，
 * 所以整套辅助框改用深色描边，标签底色也换成深色保证对比度。
 */
.is-light-canvas .poster-hotspot {
  border-color: rgba(15, 23, 42, 0.4);
}

.is-light-canvas .poster-hotspot.is-skipped {
  border-color: rgba(15, 23, 42, 0.25);
}

.is-light-canvas .poster-hotspot.is-skipped .poster-hotspot-label {
  background: #475569;
}

.poster-stage {
  width: 100%;
  /**
   * 让整张海报一屏放得下：按**三栏公用高度预算**反推最大宽度，再居中。
   *
   * 预览是 1080:1620 的竖图。早先这里写的是 `(100vh - 300px) * 0.6667`，
   * 但那 300px 是「只有画布一栏」时代的估计；改成三栏后左右栏各自限高，
   * 画布若仍按视口高换算就会比左右栏高出一截，把弹窗顶出滚动条。
   * 改成跟 `--pd-pane-h` 同一个来源，三者天然齐平。
   */
  max-width: calc(var(--pd-pane-h) * 0.6667);
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

/**
 * 锁定的区块：**框直接藏起来**（用户要的「隐藏已锁定区块的框，防误拖」）。
 *
 * 只剩透明命中区的原因：框画在那里就等于告诉用户「这块可以拖」，
 * 一拖才发现拖不动，比没有框更让人困惑。想动它就在图层列表里解锁。
 * 注意**不设 pointer-events:none** —— 还得能点它选中、改文字改颜色。
 */
.poster-hotspot.is-locked {
  border-color: transparent;
  background: transparent;
  cursor: default;
}

.poster-hotspot.is-locked .poster-hotspot-label {
  opacity: 0;
}

.poster-hotspot.is-locked .poster-handle {
  opacity: 0;
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
