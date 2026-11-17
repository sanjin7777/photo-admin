/**
 * 海报版式（低代码设计器）数据契约。
 *
 * 背景：海报原本是写死的三段式（左图 + 右侧小卡 + 下方文案），
 * 「哪块放哪、要不要显示、字号多大」任何一点改动都得改代码。
 * 这里把海报拆成一组**可拖拽的区块**：坐标与尺寸直接使用 1080×1620 画布像素，
 * 后台设计器只负责改这份 JSON，渲染器按 z 顺序逐块绘制。
 *
 * 区块坐标允许少量负值（做出血/贴边效果），但整体不应大幅超出画布；
 * 服务端只做形状校验（类型 / 范围 / 数量），「好不好看」由设计器里的人判断。
 */
import { z } from 'zod';

/** 画布尺寸：与导出 PNG 完全一致，设计器里 1px 就是 1px */
export const POSTER_CANVAS = { width: 1080, height: 1620 } as const;

/**
 * 区块类型。
 *
 * 带数据的区块（stage / wardrobe / venue / qr / title …）内容来自场次本身，
 * 设计器只决定位置与显隐；`text` 是唯一的纯自定义区块。
 */
export const POSTER_BLOCKS = [
  'stage',
  'stage2',
  'brand',
  'title',
  'intro',
  'sessions',
  'prices',
  'wardrobe',
  'wardrobe2',
  'venue',
  'qr',
  'qrSite',
  'footer',
  'text',
  'divider',
] as const;

export const posterBlockTypeSchema = z.enum(POSTER_BLOCKS);
export type PosterBlockType = (typeof POSTER_BLOCKS)[number];

/** 区块的中文名与说明：设计器面板直接使用，避免两处维护 */
export const POSTER_BLOCK_META: Readonly<
  Record<PosterBlockType, { label: string; hint: string; custom?: boolean }>
> = {
  stage: { label: '主模特图', hint: '首位模特的照片，按裁剪/完整两种方式铺进区块' },
  stage2: { label: '第二模特图', hint: '双模特场次的第二位模特，单模特时自动跳过' },
  brand: { label: '品牌标题', hint: '左上角站点名，未配置时用内置默认文案' },
  title: { label: '活动标题', hint: '自动缩放字号，优先在 · 、／ 等分隔符处断行' },
  intro: { label: '副标题 / 场地', hint: '副标题 + 「模特 · 场地 · 场景」一行' },
  sessions: { label: '场次安排', hint: '时段双列排布；高度不足时行高自动压缩，仍放不下会提示缺几场并可一键拉高' },
  prices: { label: '价格三档', hint: '活动价 / VIP 价 / SVIP 价' },
  wardrobe: { label: '当日服装图', hint: '报名关键信息，默认完整显示不裁切' },
  wardrobe2: { label: '第二模特服装', hint: '双模特场次的第二位模特穿什么；单模特时自动跳过' },
  venue: { label: '场地照片', hint: '场地实拍图' },
  qr: { label: '客服二维码', hint: '扫码添加客服，未配置时画虚线占位' },
  qrSite: { label: '网站二维码', hint: '扫码进站报名；默认隐藏，需要时在设计器里打开' },
  footer: { label: '页脚', hint: '底部一句行动号召' },
  text: { label: '自定义文字', hint: '任意文案，可调字号、颜色与对齐', custom: true },
  divider: { label: '分隔线', hint: '细线 + 一小段主题色强调' },
};

/** 坐标与尺寸允许的范围：够做贴边与出血，又不至于把内容丢到画布外找不回来 */
const COORD = z.number().int().min(-400).max(2600);
const SIZE_W = z.number().int().min(24).max(2160);
const SIZE_H = z.number().int().min(8).max(3240);

export const posterBlockSchema = z
  .object({
    /** 区块实例 id：同类区块可能被复制多份，必须唯一 */
    id: z.string().trim().min(1).max(40),
    type: posterBlockTypeSchema,
    x: COORD,
    y: COORD,
    w: SIZE_W,
    h: SIZE_H,
    /** 关掉即不绘制，但保留位置配置，方便随时恢复 */
    visible: z.boolean().default(true),
    /** 叠放顺序：数字小的先画（在底层） */
    z: z.number().int().min(0).max(99).default(10),
    /** 覆盖区块内置文案（title/intro/footer/text 有效） */
    text: z.string().max(120).nullable().default(null),
    /** 覆盖区块内置字号 */
    fontSize: z.number().int().min(10).max(160).nullable().default(null),
    align: z.enum(['left', 'center', 'right']).nullable().default(null),
    /** 十六进制或 rgba 颜色；留空用区块默认配色 */
    color: z.string().trim().max(24).nullable().default(null),
    /** 覆盖图片源（wardrobe / venue / stage / stage2 / qr 有效） */
    imageUrl: z.string().trim().max(512).nullable().default(null),
    /**
     * 该区块对应第几位模特（从 0 开始）。
     *
     * 双模特场次里两位穿的衣服不同，服装图必须绑定到具体模特；
     * `stage` / `stage2` / `wardrobe` 都按它取 `event.modelSlots[i]`
     * 的照片与服装，因此「给第二位模特再加一块服装」只是多一个 modelIndex=1 的区块。
     */
    modelIndex: z.number().int().min(0).max(19).default(0),
    /** 图片填充方式：cover 裁切铺满，contain 完整显示留白 */
    fit: z.enum(['cover', 'contain']).nullable().default(null),
  })
  .strict();

export type PosterBlockDto = z.infer<typeof posterBlockSchema>;

/* ---------------- 配色主题 ---------------- */

/**
 * 海报配色。
 *
 * 只存三个色：底色 / 主色（强调色）/ 正文色。次要文字、价格档位、
 * 图片蒙层与描边全部由渲染器从这三个色**派生**——否则每加一套配色
 * 都要手填十几个色值，且很容易出现「浅色底 + 白字」这种看不见的组合。
 *
 * 旧版式没有 theme 字段（schema 填 null），渲染时回退到「曜黑」，
 * 与主题功能上线前的观感完全一致。
 */
export const posterThemeSchema = z
  .object({
    /** 画布底色：区块之间的缝隙露出这层 */
    bg: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, '底色须为 6 位十六进制，如 #080a0e'),
    /** 主色（强调色）：品牌竖条 / 分隔线 / VIP 价 / 人数比 / 图片角标 */
    accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, '主色须为 6 位十六进制，如 #f43f5e'),
    /** 正文色：标题与时段名；浅色底请选深色，否则看不清 */
    text: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, '正文色须为 6 位十六进制，如 #ffffff'),
  })
  .strict();

export type PosterThemeDto = z.infer<typeof posterThemeSchema>;

export const POSTER_THEMES = [
  'midnight',
  'ink',
  'porcelain',
  'forest',
  'violet',
  'ocean',
] as const;

export type PosterThemeKey = (typeof POSTER_THEMES)[number];

/** 预设配色：设计器色卡直接用，避免两处维护色值 */
export const POSTER_THEME_PRESETS: Readonly<
  Record<PosterThemeKey, { label: string; hint: string } & PosterThemeDto>
> = {
  midnight: {
    label: '曜黑玫红',
    hint: '默认配色，深色底 + 玫红强调，与站内品牌色一致',
    bg: '#080a0e',
    accent: '#f43f5e',
    text: '#ffffff',
  },
  ink: {
    label: '墨金',
    hint: '暖黑底 + 金色强调，适合质感与高级感场次',
    bg: '#0c0a09',
    accent: '#d4a537',
    text: '#faf7f0',
  },
  porcelain: {
    label: '素白朱砂',
    hint: '浅色底 + 朱砂强调，清爽明亮，适合白天外景',
    bg: '#f6f4ef',
    accent: '#dc2626',
    text: '#1c1917',
  },
  forest: {
    label: '森野',
    hint: '深绿底 + 嫩绿强调，适合自然光与户外主题',
    bg: '#071310',
    accent: '#34d399',
    text: '#f0fdf4',
  },
  violet: {
    label: '夜紫',
    hint: '紫黑底 + 亮紫强调，适合夜场与赛博主题',
    bg: '#0d0a1a',
    accent: '#a78bfa',
    text: '#f5f3ff',
  },
  ocean: {
    label: '海蓝',
    hint: '深蓝底 + 天蓝强调，冷静克制，适合棚拍科技景',
    bg: '#061019',
    accent: '#38bdf8',
    text: '#f0f9ff',
  },
};

/** 取某套预设配色（返回独立副本，可安全改） */
export function posterThemeOf(key: PosterThemeKey): PosterThemeDto {
  const t = POSTER_THEME_PRESETS[key] ?? POSTER_THEME_PRESETS.midnight;
  return { bg: t.bg, accent: t.accent, text: t.text };
}

/** 未指定主题时的回退：与主题功能上线前的观感一致 */
export const DEFAULT_POSTER_THEME: PosterThemeDto = posterThemeOf('midnight');

export const posterLayoutSchema = z
  .object({
    /** 版式版本：将来若坐标体系变化，用它做迁移判定 */
    version: z.literal(1).default(1),
    /** 配色主题；null / 缺省 = 曜黑（旧版式无此字段也能正常解析） */
    theme: posterThemeSchema.nullable().default(null),
    blocks: z.array(posterBlockSchema).min(1).max(40),
  })
  .strict();

export type PosterLayoutDto = z.infer<typeof posterLayoutSchema>;
/** 校验前的形态：字段可省略，由 schema 填默认值 */
export type PosterLayoutInput = z.input<typeof posterLayoutSchema>;

/* ---------------- 预设版式 ---------------- */

/** 造一个字段齐全的区块，避免每处预设都手写 11 个 null */
function mk(
  type: PosterBlockType,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<PosterBlockDto> = {},
): PosterBlockDto {
  return {
    id: type,
    type,
    x,
    y,
    w,
    h,
    visible: true,
    z: 10,
    text: null,
    fontSize: null,
    align: null,
    color: null,
    imageUrl: null,
    fit: null,
    modelIndex: 0,
    ...extra,
  };
}

/**
 * 经典版：左侧主图，右上服装 + 右下场地，下方文案区。
 *
 * 注意 `stage` 用 contain —— 模特图完整展示不裁切是这个版式的核心要求；
 * 服装卡同样 contain，因为「穿什么」比「构图好看」重要。
 *
 * 文案区纵向节奏（每一项都留了余量，避免区块互相压）：
 *   900–1090 标题（两行，字号自适应）
 *   1100–1170 副标题 / 场地（两行：副标题 28px + 明细 24px）
 *   1184–1192 分隔线
 *   1204–1396 场次
 *   1412–1508 价格
 *   1548–1592 页脚
 */
const CLASSIC: PosterLayoutDto = {
  version: 1,
  theme: null,
  blocks: [
    mk('stage', 0, 0, 672, 860, { z: 0, fit: 'contain', modelIndex: 0 }),
    mk('wardrobe', 672, 72, 336, 420, { z: 5, fit: 'contain', modelIndex: 0 }),
    // 第二位模特的服装：与第一位的卡片并排，双模特场次两张都要看得见
    mk('wardrobe2', 672, 508, 336, 356, { z: 5, fit: 'contain', modelIndex: 1 }),
    mk('venue', 672, 884, 336, 220, { z: 5, fit: 'contain' }),
    mk('title', 72, 900, 528, 180),
    mk('intro', 72, 1092, 528, 78),
    mk('divider', 72, 1184, 528, 8, { z: 6 }),
    mk('sessions', 72, 1204, 528, 192),
    mk('prices', 72, 1412, 528, 96),
    mk('footer', 72, 1548, 700, 44),
    mk('brand', 72, 72, 560, 60, { z: 12 }),
    mk('qr', 744, 1270, 264, 318, { z: 12 }),
    // 网站二维码默认隐藏（2026-11-11）：需要时在设计器里打开，或改这里 visible: true
    mk('qrSite', 744, 924, 264, 318, { z: 12, visible: false }),
  ],
};

/** 双人版：两张模特图并置，服装/场地挪到文案区右侧竖排 */
const DUO: PosterLayoutDto = {
  version: 1,
  theme: null,
  blocks: [
    mk('stage', 0, 0, 540, 820, { z: 0, fit: 'cover', modelIndex: 0 }),
    mk('stage2', 540, 0, 540, 820, { z: 1, fit: 'cover', modelIndex: 1 }),
    // 两位模特各一份服装，纵向排列（并排太窄，角标会挤到看不清是谁的）
    mk('wardrobe', 672, 840, 336, 150, { z: 5, fit: 'contain', modelIndex: 0 }),
    mk('wardrobe2', 672, 998, 336, 150, { z: 5, fit: 'contain', modelIndex: 1 }),
    mk('venue', 672, 1156, 336, 110, { z: 5, fit: 'contain' }),
    mk('title', 72, 880, 540, 180),
    mk('intro', 72, 1072, 540, 78),
    mk('divider', 72, 1164, 540, 8, { z: 6 }),
    /**
     * 场次区块高度 192（原 160）：三场需要两行 × 40px + 标题 40px = 120px，
     * 160 只够两行却算成「只能画 2 个时段」，第三场会被丢掉（用户 2026-11-17 实测）。
     * 与经典版同为 192，四场也能完整排下。
     */
    mk('sessions', 72, 1184, 540, 192),
    mk('prices', 72, 1392, 540, 96),
    mk('footer', 72, 1548, 640, 44),
    mk('brand', 72, 72, 760, 60, { z: 12 }),
    mk('qr', 744, 1270, 264, 318, { z: 12 }),
    mk('qrSite', 744, 924, 264, 318, { z: 12, visible: false }),
  ],
};

/** 通栏版：主视觉整幅铺满顶部，文案更紧凑 */
const COMPACT: PosterLayoutDto = {
  version: 1,
  theme: null,
  blocks: [
    mk('stage', 0, 0, 1080, 880, { z: 0, fit: 'cover' }),
    mk('title', 72, 900, 660, 180),
    mk('intro', 72, 1092, 660, 78),
    mk('divider', 72, 1184, 660, 8, { z: 6 }),
    // 192 与另两套一致：三/四场都能完整排下，价格顺移到 1408（页脚 1548 前留足间距）
    mk('sessions', 72, 1204, 660, 192),
    mk('prices', 72, 1408, 660, 96),
    mk('wardrobe', 672, 900, 336, 190, { z: 5, fit: 'cover' }),
    mk('venue', 672, 1106, 336, 140, { z: 5, fit: 'cover' }),
    mk('footer', 72, 1548, 640, 44),
    mk('brand', 72, 72, 760, 60, { z: 12 }),
    mk('qr', 744, 1270, 264, 318, { z: 12 }),
    mk('qrSite', 744, 924, 264, 318, { z: 12, visible: false }),
  ],
};

const PRESETS: Readonly<Record<'classic' | 'duo' | 'compact', PosterLayoutDto>> = {
  classic: CLASSIC,
  duo: DUO,
  compact: COMPACT,
};

export type PosterPresetKey = keyof typeof PRESETS;

/**
 * 深拷贝：设计器会就地改区块，必须给每个调用方一份独立副本。
 *
 * 刻意**保留当前主题**：换版式（经典 / 双人 / 通栏）是换排版，
 * 不该把用户已经选好的配色一并冲掉。
 */
export function posterPresetOf(key: PosterPresetKey, theme: PosterThemeDto | null = null): PosterLayoutDto {
  const preset = PRESETS[key] ?? CLASSIC;
  return {
    version: 1,
    theme: theme ? { ...theme } : null,
    blocks: preset.blocks.map((b) => ({ ...b })),
  };
}

/**
 * 新增自定义文字区块时的初始值：放在文案区中部，样式克制。
 *
 * `color` 留 null = 跟随主题正文色。以前写死 '#ffffff'，
 * 切到浅色配色后这段字就变成白底白字，看不见。
 */
export function newTextBlock(id: string): PosterBlockDto {
  return mk('text', 72, 1330, 528, 48, {
    id,
    z: 20,
    text: '在这里写一句宣传语',
    fontSize: 30,
    align: 'left',
    color: null,
  });
}

/**
 * 给新加的区块一个不冲突的 id。
 * 同类区块第一次沿用类型名（`stage`），之后递增（`stage-2`）。
 */
export function nextBlockId(layout: PosterLayoutDto, type: PosterBlockType): string {
  const used = new Set(layout.blocks.map((b) => b.id));
  if (!used.has(type)) return type;
  let n = 2;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}
