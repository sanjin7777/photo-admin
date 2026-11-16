/**
 * 场次海报导出（1080×1620 竖版）。
 *
 * 渲染方式：**区块布局**。海报不再写死成三段式，而是一组带坐标的区块
 * （主模特图 / 服装 / 场地 / 场次 / 价格 / 二维码 …），按 z 顺序逐块绘制。
 * 这样后台的「海报设计器」改一份 JSON 就能换版式，不用动代码；
 * 同一个渲染器既服务预设版式（classic / duo / compact），也服务自定义版式。
 *
 * 关键约定：
 * · 模特图默认 contain（完整展示不裁切），服装/场地同理——「穿什么、在哪拍」是报名关键信息；
 * · 二维码只认后台配置，未配置时画虚线占位而不是静默消失，避免运营以为导出成功；
 * · 不依赖任何截图/二维码库，全部 Canvas 2D 绘制，导出像素不受页面缩放影响；
 * · 字体使用系统中文字体栈，不能复刻定制字体与手写排版。
 */
import type { EventDto, EventSessionDto } from '@photo/shared';
import {
  POSTER_BLOCK_META,
  posterPresetOf,
  type PosterBlockDto,
  type PosterBlockType,
  type PosterLayoutDto,
  type PosterPresetKey,
} from '@photo/shared';

const W = 1080;
const H = 1620;

/** 网站二维码未在后台配置时使用内置默认图 */
const SITE_QR_SRC = `${import.meta.env.BASE_URL}site-qr.png`;
/** 后台未配置时，海报左上角使用这行默认标题 */
export const DEFAULT_BRAND_TITLE = "CAT'S PAW · 猫爪摄影会";

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const WHITE = '#ffffff';
const MUTED = 'rgba(255,255,255,0.72)';
const FAINT = 'rgba(255,255,255,0.5)';
const ACCENT = '#f43f5e';
const INFO_BG = '#080a0e';

function px(size: number, weight: number | string = 400): string {
  return `${weight} ${size}px ${FONT}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 台账单位（分）→ 海报上的价格文案。
 *
 * 海报是对外分发的物料（朋友圈 / 微信群），外部受众不认识「积分」，
 * 因此这里刻意使用人民币符号，与站内的积分口径**故意不同**。
 * 站内所有页面仍然只显示积分，不受此处影响。
 */
function money(cent: number): string {
  const value = cent / 100;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `¥${text}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] ?? '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
}

function shortDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 中文按字符换行，英文数字尽量不切断单词；超出 maxLines 时末行加省略号 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of Array.from(text)) {
    const next = current + ch;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = ch;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  else if (lines.length === maxLines && current) {
    let last = lines[maxLines - 1] ?? '';
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/* ==================================================================== */
/*                        预设版式（与设计器共用）                        */
/* ==================================================================== */

export const POSTER_STYLES = ['classic', 'duo', 'compact'] as const;
export type PosterStyle = (typeof POSTER_STYLES)[number];

export const POSTER_STYLE_META: Readonly<Record<PosterStyle, { label: string; hint: string }>> = {
  classic: { label: '经典', hint: '左侧主图 + 右侧服装与场地，信息密度均衡' },
  duo: { label: '双人', hint: '两张模特图左右并置；双模特场次推荐' },
  compact: { label: '通栏', hint: '整幅大图铺满顶部，文案区更紧凑' },
};

/** 取某个预设的区块布局（每次返回独立副本，可安全修改） */
export function presetLayout(style: PosterStyle): PosterLayoutDto {
  return posterPresetOf(style as PosterPresetKey);
}

/* ==================================================================== */
/*                              绘制原语                                 */
/* ==================================================================== */

/** 把一张图按 cover 规则画进矩形（裁切铺满） */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 把一张图按 contain 规则居中画进矩形（完整显示，四周留白） */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
): void {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * 图片区块：模糊底 + 主图。
 *
 * contain 时用同一张图放大虚化填满背景，避免留白变成死黑；
 * cover 时直接铺满，不需要背景层。
 */
function drawImageBlock(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  block: PosterBlockDto,
  placeholder?: string,
  /** 角标文案（如「当日服装 · 白电波」）；不传表示不加角标 */
  tag: string | null = null,
): void {
  const { x, y, w, h } = block;
  const fit = block.fit ?? 'contain';

  if (!img) {
    // 缺图时画占位框而不是留空，导出后能一眼看出「这里本该有图」
    ctx.save();
    roundRect(ctx, x, y, w, h, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (placeholder) {
      ctx.fillStyle = FAINT;
      ctx.font = px(Math.min(22, Math.max(14, Math.round(h / 8))), 500);
      ctx.textAlign = 'center';
      ctx.fillText(placeholder, x + w / 2, y + h / 2 + 8);
    }
    ctx.restore();
    return;
  }

  ctx.save();
  roundRect(ctx, x, y, w, h, 18);
  ctx.clip();

  if (fit === 'contain') {
    const scale = Math.max(w / img.width, h / img.height);
    const cw = img.width * scale;
    const ch = img.height * scale;
    ctx.filter = 'blur(20px)';
    ctx.drawImage(img, x + (w - cw) / 2, y + (h - ch) / 2, cw, ch);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(8,10,14,0.42)';
    ctx.fillRect(x, y, w, h);
    drawContain(ctx, img, x, y, w, h);
  } else {
    drawCover(ctx, img, x, y, w, h);
  }

  /**
   * 角标：只在「服装 / 场地」这类需要点明身份的区块上加。
   *
   * 没有角标时，右上角两张图在别人眼里就是「两张好看的图」，
   * 分不清哪张是当天要穿的衣服、哪张是拍摄场地——而这两件事恰恰是报名要看的。
   * 双模特场次还要带上模特名，否则两张「当日服装」同样分不清是谁的。
   */
  if (tag && h >= 90) {
    const barH = Math.min(44, Math.round(h * 0.16));
    const grad = ctx.createLinearGradient(0, y + h - barH * 1.6, 0, y + h);
    grad.addColorStop(0, 'rgba(8,10,14,0)');
    grad.addColorStop(1, 'rgba(8,10,14,0.82)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y + h - barH * 1.6, w, barH * 1.6);

    ctx.fillStyle = ACCENT;
    ctx.fillRect(x, y + h - barH, Math.min(6, w), barH);

    ctx.fillStyle = WHITE;
    ctx.font = px(Math.min(24, Math.max(15, Math.round(barH * 0.55))), 600);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    /**
     * 角标必须放得下：窄卡片（双人版式里的两列服装卡只有 162px 宽）
     * 直接 fillText 会把「当日服装 · 幽浮水母」裁成「幽浮水手」——看着像另一个名字。
     * 这里按可用宽度逐步截断并补省略号，宁可少显示也不要显示错的字。
     */
    const tagMax = Math.max(20, w - 34);
    let visibleTag = tag;
    if (ctx.measureText(visibleTag).width > tagMax) {
      while (visibleTag && ctx.measureText(`${visibleTag}…`).width > tagMax) {
        visibleTag = visibleTag.slice(0, -1);
      }
      visibleTag = visibleTag ? `${visibleTag}…` : '';
    }
    if (visibleTag) ctx.fillText(visibleTag, x + 20, y + h - barH / 2);
  }
  ctx.restore();

  roundRect(ctx, x, y, w, h, 18);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** 图片区块的角标文案；返回 null 表示不加角标 */
function tagOf(type: PosterBlockType): string | null {
  switch (type) {
    case 'wardrobe': return '当日服装';
    case 'wardrobe2': return '当日服装';
    case 'venue': return '场地照片';
    default: return null;
  }
}

/** 主视觉封面帧：只有贴边通栏的区块需要投影，否则在浅色图上看不出边界 */
function frameBlock(ctx: CanvasRenderingContext2D, block: PosterBlockDto): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, block.x, block.y, block.w, block.h, 18);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
}

/* ==================================================================== */
/*                            标题断行策略                               */
/* ==================================================================== */

/** 标题断行：按英文单词 / 单个汉字成词，尽量在中间断开，避免末行只剩一两个字 */
function titleTokens(text: string): string[] {
  const tokens: string[] = [];
  let latin = '';
  for (const ch of Array.from(text)) {
    if (/[A-Za-z0-9'’.-]/.test(ch)) {
      latin += ch;
      continue;
    }
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
    tokens.push(ch);
  }
  if (latin) tokens.push(latin);
  return tokens;
}

/**
 * 可以在此处断行、且断行时**应当丢弃**的分隔符。
 * 断在 `·` 上如果保留它，第二行会以「·白电波」开头，看着像个项目符号。
 */
const BREAK_TOKENS = new Set(['·', '・', '•', '/', '／', '|', '｜', '—', '–', '-', ' ', '　']);

/** 去掉字符串首尾的分隔符：`"· 白电波"` → `"白电波"` */
function trimSeparators(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && BREAK_TOKENS.has(chars[start]!)) start++;
  while (end > start && BREAK_TOKENS.has(chars[end - 1]!)) end--;
  return chars.slice(start, end).join('').trim();
}

/**
 * 把标题拆成两行。
 *
 * @param semanticOnly true = 只允许在分隔符（`·`、`／`、空格等）处断开，
 *                     这样「猫爪社摄影会」不会被切成「猫爪社摄影 / 会」；
 *                     false = 退化为「两行宽度最接近」的通用策略。
 */
function splitTwoLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  semanticOnly = false,
): [string, string] | null {
  const tokens = titleTokens(text);
  let best: { head: string; tail: string; diff: number } | null = null;
  for (let i = 1; i < tokens.length; i++) {
    // 断在分隔符上时把它从两行里都去掉
    const atSeparator = BREAK_TOKENS.has(tokens[i]!);
    if (semanticOnly && !atSeparator) continue;
    /**
     * 首尾都要再清一遍分隔符：`猫爪社摄影会 · 白电波` 在空格处断开时，
     * 原来的实现只跳过了当前这一个分隔符，下一行的 `· 白电波` 仍带着 `·`，
     * 看上去像个项目符号。这里统一把两侧的分隔符全部剥掉。
     */
    const head = trimSeparators(tokens.slice(0, i).join(''));
    const tail = trimSeparators(tokens.slice(atSeparator ? i + 1 : i).join(''));
    if (!head || !tail) continue;
    const headW = ctx.measureText(head).width;
    const tailW = ctx.measureText(tail).width;
    if (headW > maxWidth || tailW > maxWidth) continue;
    const diff = Math.abs(headW - tailW);
    if (!best || diff < best.diff) best = { head, tail, diff };
  }
  return best ? [best.head, best.tail] : null;
}

/** 标题候选字号：由大到小试探，优先「一行放得下」或「能在分隔符处断成两行」 */
const TITLE_SIZES = [68, 64, 60, 56, 52, 48, 44, 40, 36, 32, 28];

/**
 * 标题绘制：自动下探字号直到能容纳完整词组。
 *
 * 只在「一行放得下」或「能在分隔符断成两行」时采用该字号，
 * 保证不会把「猫爪社摄影会」硬切成「猫爪社摄影 / 会」。
 */
function drawTitleIn(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  text: string,
  align: CanvasTextAlign,
): void {
  const content = (block.text?.trim() || text).trim();
  if (!content) return;

  const maxW = block.w;
  const maxLines = 3;
  let size = 28;
  let lines: string[] = [];
  let fallback: { size: number; lines: [string, string] } | null = null;

  for (const candidate of TITLE_SIZES) {
    if (block.fontSize) break; // 手动指定字号时不做自适应
    ctx.font = px(candidate, 800);
    if (ctx.measureText(content).width <= maxW) {
      size = candidate;
      lines = [content];
      break;
    }
    const semantic = splitTwoLines(ctx, content, maxW, true);
    if (semantic) {
      size = candidate;
      lines = semantic;
      break;
    }
    if (!fallback) {
      const any = splitTwoLines(ctx, content, maxW, false);
      if (any) fallback = { size: candidate, lines: any };
    }
  }

  if (block.fontSize) {
    size = block.fontSize;
    ctx.font = px(size, 800);
    lines = [];
  }

  if (!lines.length) {
    if (fallback) {
      size = fallback.size;
      lines = fallback.lines;
    } else {
      size = Math.min(block.fontSize ?? 36, 36);
      ctx.font = px(size, 800);
      lines = wrapText(ctx, content, maxW, maxLines);
    }
  }

  /**
   * 高度也必须放得下：区块被拖矮时，光看宽度会挑一个过大的字号，
   * 行数堆上去就顶出矩形、压到上面的区块。
   * 这里从已选字号往下退，直到「行数 × 行高 ≤ 可用高度」。
   */
  const availH = Math.max(1, block.h);
  const lineHeightOf = (s: number): number => Math.round(s * 1.26);
  while (size > 20 && lines.length * lineHeightOf(size) > availH) {
    size -= 2;
    ctx.font = px(size, 800);
    // 只保留仍能放下的行数，避免退字号后行宽又不合适
    const maxFit = Math.max(1, Math.floor(availH / lineHeightOf(size)));
    if (lines.length > maxFit) {
      lines = lines.slice(0, maxFit);
      const last = lines[lines.length - 1] ?? '';
      while (last && ctx.measureText(`${last}…`).width > maxW) {
        lines[lines.length - 1] = `${last.slice(0, -1)}…`;
        if (lines[lines.length - 1] === '…') break;
      }
      break;
    }
  }

  ctx.font = px(size, 800);
  ctx.fillStyle = block.color || WHITE;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;

  const lineHeight = lineHeightOf(size);
  // 最后一行贴区块底边，向上堆叠
  const lastBaseline = block.y + block.h;
  const ax = align === 'center' ? block.x + block.w / 2 : align === 'right' ? block.x + block.w : block.x;
  lines.forEach((line, i) => {
    ctx.fillText(line, ax, lastBaseline - (lines.length - 1 - i) * lineHeight);
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ==================================================================== */
/*                          各类区块的绘制                               */
/* ==================================================================== */

function drawBrandBlock(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  brandTitle: string | null,
): void {
  const text = (block.text ?? brandTitle ?? '').trim() || DEFAULT_BRAND_TITLE;

  ctx.fillStyle = block.color || ACCENT;
  ctx.fillRect(block.x, block.y + 10, 6, 34);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = px(block.fontSize ?? 28, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  let label = text;
  const maxW = block.w - 20;
  if (ctx.measureText(label).width > maxW) {
    while (label && ctx.measureText(`${label}…`).width > maxW) label = label.slice(0, -1);
    label = `${label}…`;
  }
  ctx.fillText(label, block.x + 20, block.y + 38);
}

/**
 * 副标题 + 「模特 · 场地 · 场景」。
 *
 * 关键是**不能画出区块的矩形**：设计器里区块高度是可拖的，
 * 原来固定用 +32 / +78 两个写死的基线，区块一矮就把字压到下一个区块上
 * （截图里副标题和「场次安排」叠在一起就是这个原因）。
 * 现在按可用高度决定「画两行 / 只画一行 / 整块不画」。
 */
function drawIntroBlock(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  event: EventDto,
): void {
  const align = (block.align ?? 'left') as CanvasTextAlign;
  const ax = align === 'center' ? block.x + block.w / 2 : align === 'right' ? block.x + block.w : block.x;

  const subtitle = (block.text ?? '').trim() || event.subtitle?.trim() || event.ratioLabel?.trim() || '';

  const parts: string[] = [];
  const names = (event.models ?? []).map((m) => m.stageName).filter(Boolean);
  if (names.length) parts.push(`模特 ${names.join(' · ')}`);
  const place = [event.venue, event.scene].filter(Boolean).join(' · ');
  if (place) parts.push(place);
  const detail = parts.length ? parts.join('　·　') : '';

  const top = block.y + 26;
  const needTwo = Boolean(subtitle) && Boolean(detail);

  if (needTwo && block.h >= 72) {
    // 两行都放得下：副标题一行 + 明细一行
    ctx.fillStyle = block.color || 'rgba(255,255,255,0.84)';
    ctx.font = px(block.fontSize ?? 28, 500);
    ctx.textAlign = align;
    ctx.fillText(wrapText(ctx, subtitle, block.w, 1)[0] ?? '', ax, top);

    ctx.fillStyle = MUTED;
    ctx.font = px(24, 400);
    ctx.textAlign = align;
    ctx.fillText(wrapText(ctx, detail, block.w, 1)[0] ?? '', ax, top + 34);
    return;
  }

  // 高度不够两行：优先展示信息量更大的那一行（有明细就放弃副标题）
  const single = detail || subtitle;
  if (!single) return;
  ctx.fillStyle = detail ? MUTED : (block.color || 'rgba(255,255,255,0.84)');
  ctx.font = px(block.fontSize ?? 26, detail ? 400 : 500);
  ctx.textAlign = align;
  ctx.fillText(wrapText(ctx, single, block.w, 1)[0] ?? '', ax, top);
}

function drawDividerBlock(ctx: CanvasRenderingContext2D, block: PosterBlockDto): void {
  const y = block.y + block.h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(block.x, y);
  ctx.lineTo(block.x + block.w, y);
  ctx.stroke();

  ctx.strokeStyle = block.color || ACCENT;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(block.x, y);
  ctx.lineTo(block.x + Math.min(92, block.w), y);
  ctx.stroke();
}

/**
 * 时段双列排布：左栏宽度有限，两列比单列更省高度。
 *
 * 代拍不是「时段」，不参与这里的时间列——它没有具体开始时间，
 * 显示成 `代拍 15:00 – 18:20` 会让人误以为是一个可选的拍摄时间段。
 * 改为在标题行右侧统一标一句「支持代拍」。
 */
function drawSessionsBlock(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  sessions: EventSessionDto[],
  hasProxy: boolean,
): void {
  const normal = sessions.filter((s) => s.kind !== 'PROXY');
  if (!normal.length && !hasProxy) return;

  const sorted = [...normal].sort((a, b) => a.startAt.localeCompare(b.startAt));
  // 高度决定能排几行：标题占 44px，每行 40px
  const maxRows = Math.max(1, Math.min(8, Math.floor((block.h - 44) / 40)));
  const cellW = Math.floor((block.w - 24) / 2);
  const colGap = 24;
  const rowH = 40;

  ctx.textAlign = 'left';
  ctx.fillStyle = FAINT;
  ctx.font = px(22, 600);
  const extra = sorted.length > maxRows ? `（共 ${sorted.length} 场）` : '';
  const head = sorted.length
    ? `场次安排 · ${dayLabel(sorted[0]!.startAt)}${extra}`
    : '场次安排';
  ctx.fillText(head, block.x, block.y + 22);

  // 「支持代拍」紧跟标题右侧，不占一行、也不与时间混排
  if (hasProxy) {
    const headW = ctx.measureText(head).width;
    ctx.fillStyle = '#f5a524';
    ctx.font = px(22, 600);
    ctx.fillText('· 支持代拍', block.x + headW + 12, block.y + 22);
  }

  const firstBaseline = block.y + 62;
  const firstDay = sorted.length ? dayKey(sorted[0]!.startAt) : '';

  sorted.slice(0, maxRows).forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = block.x + col * (cellW + colGap);
    const y = firstBaseline + row * rowH;

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = px(25, 600);
    ctx.textAlign = 'left';
    ctx.fillText(wrapText(ctx, s.label || `第${i + 1}场`, 108, 1)[0] ?? '', x, y);

    ctx.fillStyle = MUTED;
    ctx.font = px(22, 400);
    ctx.textAlign = 'right';
    const day = dayKey(s.startAt) === firstDay ? '' : `${shortDay(s.startAt)} `;
    ctx.fillText(`${day}${timeOf(s.startAt)} – ${timeOf(s.endAt)}`, x + cellW, y);
  });
  ctx.textAlign = 'left';
}

/** 三档价格用不同配色区分：活动价中性、VIP 玫红、SVIP 金色 */
const PRICE_TONES: Record<'PUBLIC' | 'VIP' | 'SVIP', {
  fill: string;
  stroke: string;
  label: string;
  amount: string;
}> = {
  PUBLIC: {
    fill: 'rgba(255,255,255,0.08)',
    stroke: 'rgba(255,255,255,0.14)',
    label: 'rgba(255,255,255,0.62)',
    amount: WHITE,
  },
  VIP: {
    fill: 'rgba(244,63,94,0.16)',
    stroke: 'rgba(244,63,94,0.55)',
    label: '#fda4af',
    amount: '#ffe4e6',
  },
  SVIP: {
    fill: 'rgba(216,180,90,0.16)',
    stroke: 'rgba(216,180,90,0.55)',
    label: '#e8cf92',
    amount: '#f8e7bd',
  },
};

function drawPricesBlock(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  event: EventDto,
): void {
  const priceOf = (level: 'PUBLIC' | 'VIP' | 'SVIP'): number =>
    event.prices.find((p) => p.level === level)?.priceCent ?? event.feeCent;

  const items: Array<{ level: 'PUBLIC' | 'VIP' | 'SVIP'; label: string; cent: number }> = [
    { level: 'PUBLIC', label: '活动价', cent: priceOf('PUBLIC') },
    { level: 'VIP', label: 'VIP 价', cent: priceOf('VIP') },
    { level: 'SVIP', label: 'SVIP 价', cent: priceOf('SVIP') },
  ];

  const gap = 12;
  const boxW = Math.floor((block.w - gap * 2) / 3);
  const boxH = Math.min(block.h, 88);

  items.forEach((item, i) => {
    const tone = PRICE_TONES[item.level];
    const x = block.x + i * (boxW + gap);
    roundRect(ctx, x, block.y, boxW, boxH, 14);
    ctx.fillStyle = tone.fill;
    ctx.fill();
    ctx.strokeStyle = tone.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = tone.label;
    ctx.font = px(21, 500);
    ctx.fillText(item.label, x + boxW / 2, block.y + 31);

    ctx.fillStyle = tone.amount;
    ctx.font = px(34, 700);
    ctx.fillText(money(item.cent), x + boxW / 2, block.y + 71);
  });
  ctx.textAlign = 'left';
}

function drawFooterBlock(ctx: CanvasRenderingContext2D, block: PosterBlockDto): void {
  const text = (block.text ?? '').trim() || '猫爪摄影会 · 名额有限，扫码锁定你的场次';
  const align = (block.align ?? 'left') as CanvasTextAlign;
  const ax = align === 'center' ? block.x + block.w / 2 : align === 'right' ? block.x + block.w : block.x;

  ctx.textAlign = align;
  ctx.fillStyle = block.color || FAINT;
  ctx.font = px(block.fontSize ?? 21, 400);
  ctx.fillText(wrapText(ctx, text, block.w, 1)[0] ?? '', ax, block.y + 24);
  ctx.textAlign = 'left';
}

function drawTextBlock(ctx: CanvasRenderingContext2D, block: PosterBlockDto): void {
  const text = (block.text ?? '').trim();
  if (!text) return;
  const align = (block.align ?? 'left') as CanvasTextAlign;
  const ax = align === 'center' ? block.x + block.w / 2 : align === 'right' ? block.x + block.w : block.x;

  const size = block.fontSize ?? 30;
  ctx.font = px(size, 600);
  ctx.fillStyle = block.color || WHITE;
  ctx.textAlign = align;
  const lineHeight = Math.round(size * 1.34);
  const maxLines = Math.max(1, Math.floor(block.h / lineHeight));
  const lines = wrapText(ctx, text, block.w, maxLines);

  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 3;
  lines.forEach((line, i) => {
    ctx.fillText(line, ax, block.y + size + i * lineHeight);
  });
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.textAlign = 'left';
}

/** 二维码卡片：白底圆角 + 二维码 + 底部说明；未配置时画虚线占位 */
function drawQrBlock(
  ctx: CanvasRenderingContext2D,
  block: PosterBlockDto,
  img: HTMLImageElement | null,
): void {
  const { x, y, w, h } = block;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, x, y, w, h, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.fill();
  ctx.restore();

  const captionH = 52;
  const boxTop = y + 18;
  const boxH = Math.max(48, h - captionH - 26);
  const size = Math.min(w - 60, boxH);

  if (img) {
    ctx.drawImage(img, x + (w - size) / 2, boxTop + (boxH - size) / 2, size, size);
  } else {
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    roundRect(ctx, x + 24, boxTop, w - 48, boxH, 12);
    ctx.stroke();
    ctx.setLineDash([]);

    /**
     * 两行提示必须留在虚线框内。
     * 原来按区块高度的一半定位，占位框比文字矮时会被底部说明压住——字叠字。
     */
    const midY = boxTop + boxH / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#64748b';
    ctx.font = px(19, 500);
    ctx.fillText('未配置二维码', x + w / 2, midY - 10);
    ctx.fillStyle = '#94a3b8';
    ctx.font = px(15, 400);
    ctx.fillText('请在后台「海报二维码」上传', x + w / 2, midY + 16);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  ctx.font = px(24, 600);
  ctx.fillText((block.text ?? '').trim() || '扫码添加客服', x + w / 2, y + h - 20);
  ctx.textAlign = 'left';
}

/* ==================================================================== */
/*                              渲染主流程                               */
/* ==================================================================== */

export interface PosterRenderInput {
  event: EventDto;
  layout: PosterLayoutDto;
  /** 客服二维码图片地址 */
  qrUrl: string | null;
  /** 网站二维码地址；未配置时用内置默认图 */
  siteQrUrl?: string | null;
  /** 左上角品牌标题；null 用内置默认 */
  brandTitle: string | null;
  /**
   * 渲染诊断回调：报告本次**实际被跳过**的区块 id。
   *
   * 设计器需要它来对齐「点击层」与「画面」：某些区块（第二模特图 / 第二模特服装）
   * 会因为「本场只有一位模特」或「图片加载失败」而不绘制，
   * 如果热区仍然保留，就会变成一层透明的点击拦截器。
   * 导出路不用关心这个回调，传了也无副作用。
   */
  onDiagnostics?: (info: { skippedIds: string[]; hasSecondModel: boolean }) => void;
}

/** 按区块布局渲染到 canvas；返回 canvas 供下载或预览复用 */
export async function renderPoster(input: PosterRenderInput): Promise<HTMLCanvasElement> {
  const { event, layout, qrUrl, siteQrUrl, brandTitle } = input;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持导出图片');

  /**
   * 按模特取图：`modelSlots` 是服务端算好的权威值（与 models 同序），
   * 每项已内置「该模特自己的 → 整场共用 → 档案首图」的回退。
   * 拿不到 modelSlots 的旧数据回退到整场的 posterUrls / wardrobeUrls。
   */
  const slots = event.modelSlots ?? [];
  const slotPhoto = (i: number): string =>
    slots[i]?.photoUrls?.[0] ?? event.models?.[i]?.photoUrls?.[0] ?? '';
  const slotWardrobe = (i: number): string =>
    slots[i]?.wardrobeUrls?.[0] ?? event.wardrobeUrls?.[0] ?? '';

  const baseUrl = slotPhoto(0) || event.posterUrls?.[0] || event.coverUrl || '';
  const secondUrl = slotPhoto(1);
  const wardrobeUrl0 = slotWardrobe(0);
  const wardrobeUrl1 = slotWardrobe(1);
  /**
   * 两位模特共用同一套服装时（后台还没分开填，回退到整场那组），
   * 第二块服装卡会和第一块画出一模一样的图 —— 看起来像重复渲染的 bug。
   * 只要两张图同源就不画第二块；真正分开填之后自然会出现。
   */
  const duplicateWardrobe = !wardrobeUrl1 || wardrobeUrl1 === wardrobeUrl0;

  const [baseImg, qrImg, wardrobeImg, wardrobe2Img, venueImg, secondImg, siteQrImg] = await Promise.all([
    loadImage(baseUrl),
    loadImage(qrUrl ?? ''),
    loadImage(wardrobeUrl0),
    // 第二位模特的服装：单模特或与第一位同源时区块会跳过
    loadImage(wardrobeUrl1),
    loadImage(event.venueUrls?.[0] ?? ''),
    loadImage(secondUrl),
    // 网站二维码默认隐藏，但区块一旦打开就要能出图，故与其它图并行加载
    loadImage(siteQrUrl || SITE_QR_SRC),
  ]);

  const hasSecondModel = Boolean(secondImg);

  const hasProxy = Boolean(event.allowProxyShoot
    || (event.sessions ?? []).some((s) => s.kind === 'PROXY'));

  // 画布底色：区块之间若有缝隙，露出的是这层深色而不是透明
  ctx.fillStyle = INFO_BG;
  ctx.fillRect(0, 0, W, H);

  /** 区块类型 → 图片资源 */
  const imageOf = (type: PosterBlockType): HTMLImageElement | null => {
    switch (type) {
      case 'stage': return baseImg;
      case 'stage2': return secondImg;
      case 'wardrobe': return wardrobeImg;
      case 'wardrobe2': return wardrobe2Img;
      case 'venue': return venueImg;
      case 'qr': return qrImg;
      case 'qrSite': return siteQrImg;
      default: return null;
    }
  };

  // 稳定排序：z 相同则保持数组顺序（设计器里「置顶/置底」依赖这一点）
  const blocks = [...layout.blocks]
    .filter((b) => b.visible)
    .sort((a, b) => (a.z - b.z) || 0);

  /** 本次真正没有绘制的区块 id（供设计器对齐点击层） */
  const skippedIds: string[] = [];

  for (const block of blocks) {
    /**
     * 第二模特的区块在单模特场次里直接跳过，**不画占位框**：
     * 占位框会让人以为「这里本该有张图但丢了」，而实际上本场就只有一位模特。
     * 设计器里始终显示这些区块（方便排版），导出时按实际模特数决定画不画。
     */
    const secondModelOnly = block.type === 'stage2' || block.type === 'wardrobe2';
    if (secondModelOnly && !hasSecondModel) { skippedIds.push(block.id); continue; }
    // 两张服装图同源时不重复画第二块
    if (block.type === 'wardrobe2' && duplicateWardrobe) { skippedIds.push(block.id); continue; }

    // 自定义图片优先于场次图片
    const custom = block.imageUrl ? await loadImage(block.imageUrl) : null;
    const img = custom ?? imageOf(block.type);
    const align = (block.align ?? 'left') as CanvasTextAlign;

    /**
     * 兜底裁剪：文字类区块只允许在自己的矩形里作画。
     *
     * 设计器里区块高度是随手拖的，靠每类绘制函数自己「尽量不越界」不够保险
     * （文字行数、字号、换行都可能溢出一截）。这里统一加一层 clip，
     * 保证拖坏一个区块只会让自己被裁掉，不会糊到相邻区块上。
     *
     * 图片与二维码区块**不裁**：它们自带圆角 clip，而且投影/光晕本来就要溢出边界，
     * 外面再套一层会把阴影切出一条硬边。
     */
    const clipped = !['stage', 'stage2', 'wardrobe', 'wardrobe2', 'venue', 'qr', 'qrSite']
      .includes(block.type);
    if (clipped) {
      ctx.save();
      ctx.beginPath();
      // 上下各留 6px 余量，避免把文字的字形下缘裁掉
      ctx.rect(block.x - 2, block.y - 6, block.w + 4, block.h + 12);
      ctx.clip();
    }

    switch (block.type) {
      case 'stage':
      case 'stage2':
      case 'wardrobe':
      case 'wardrobe2':
      case 'venue': {
        const placeholder = block.type === 'venue'
          ? '场地照片'
          : block.type === 'wardrobe' || block.type === 'wardrobe2'
            ? '当日服装'
            : block.type === 'stage2'
              ? '第二模特'
              : '模特照片';
        // 主图区贴边时不加圆角投影，避免边缘出现一圈黑线
        if (block.type === 'stage' && img && (block.fit ?? 'contain') === 'contain') {
          frameBlock(ctx, block);
        }
        /**
         * 服装角标带模特名：双模特场次有两张「当日服装」，
         * 只写「当日服装」分不清是谁的，报名的人会看错。
         */
        const baseTag = tagOf(block.type);
        const modelName = event.models?.[block.modelIndex ?? 0]?.stageName ?? '';
        const tag = baseTag && baseTag !== '场地照片' && modelName && (event.models?.length ?? 0) > 1
          ? `${baseTag} · ${modelName}`
          : baseTag;
        drawImageBlock(ctx, img, block, placeholder, tag);
        break;
      }
      case 'qr':
      case 'qrSite':
        drawQrBlock(ctx, block, img);
        break;
      case 'brand':
        drawBrandBlock(ctx, block, brandTitle);
        break;
      case 'title':
        drawTitleIn(ctx, block, event.title || '猫爪社摄影会', align);
        break;
      case 'intro':
        drawIntroBlock(ctx, block, event);
        break;
      case 'divider':
        drawDividerBlock(ctx, block);
        break;
      case 'sessions':
        drawSessionsBlock(ctx, block, event.sessions ?? [], hasProxy);
        break;
      case 'prices':
        drawPricesBlock(ctx, block, event);
        break;
      case 'footer':
        drawFooterBlock(ctx, block);
        break;
      case 'text':
        drawTextBlock(ctx, block);
        break;
      default:
        break;
    }

    if (clipped) ctx.restore();
  }

  // 报告本次实际跳过的区块，供设计器让「点击层」与画面保持一致
  input.onDiagnostics?.({ skippedIds, hasSecondModel });

  return canvas;
}

function safeName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
  return cleaned || '场次';
}

/**
 * 导出海报 PNG。
 *
 * `layout` 有值就用设计器保存的版式，否则按 `style` 取预设。
 * 这样「保存过版式」的用户导出的是自己排的图，没保存过的仍是原来的三套预设。
 */
export async function exportEventPoster(
  event: EventDto,
  qrUrl: string | null,
  brandTitle: string | null = null,
  options: {
    style?: PosterStyle;
    layout?: PosterLayoutDto | null;
    siteQrUrl?: string | null;
  } = {},
): Promise<void> {
  const style = options.style ?? 'classic';
  const layout = options.layout ?? presetLayout(style);

  const canvas = await renderPoster({
    event,
    layout,
    qrUrl,
    siteQrUrl: options.siteQrUrl ?? null,
    brandTitle,
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('海报生成失败，请重试');

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // 文件名带版式，一次导出多套时不会互相覆盖
  const suffix = options.layout ? '-自定义' : style === 'classic' ? '' : `-${POSTER_STYLE_META[style].label}`;
  a.download = `${safeName(event.title)}-海报${suffix}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 区块类型的中文名，供设计器列表复用 */
export function blockLabel(type: PosterBlockType): string {
  return POSTER_BLOCK_META[type].label;
}
