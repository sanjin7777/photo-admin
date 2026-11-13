/**
 * 场次海报导出（1080×1620 竖版）。
 *
 * 版式：左侧完整展示模特图（contain，不裁切），自身虚化作背景；
 * 右上角竖排「当日服装 + 场地照片」两张卡片；
 * 右下角竖排「网站二维码 + 客服二维码」两张卡片，地址都可在后台配置；
 * 网站码未配置时回退内置默认图，客服码未配置时画虚线占位；
 * 网站二维码暂时隐藏（2026-11-11），恢复时把 SHOW_SITE_QR 改回 true 即可；
 * 下半屏纯色信息区，左栏依次为标题 / 模特场地 / 全部时段 / 三档价格。
 *
 * 不依赖任何截图/二维码库：全部用原生 Canvas 2D 绘制，
 * 因此导出的是固定像素 PNG，不受后台页面缩放影响。
 * 字体使用系统中文字体栈，不能复刻示例图里的定制字体与手写排版。
 */
import type { EventDto, EventSessionDto } from '@photo/shared';

const W = 1080;
const H = 1620;
const PAD = 72;
const STAGE_H = 860;
const INFO_TOP = STAGE_H;
const INFO_BG = '#080a0e';

const QR_W = 264;
const QR_H = 318;
/** 网站二维码未在后台配置时使用内置默认图 */
const SITE_QR_SRC = `${import.meta.env.BASE_URL}site-qr.png`;
/** 后台未配置时，海报左上角使用这行默认标题 */
export const DEFAULT_BRAND_TITLE = "CAT'S PAW · 猫爪摄影会";

const LEFT_X = PAD;
const LEFT_W = 528;
const RIGHT_X = 672;
const RIGHT_W = 336;
/** 模特图可用宽度：右侧让出服装 / 场地卡片的位置 */
const MODEL_W = RIGHT_X;

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const WHITE = '#ffffff';
const MUTED = 'rgba(255,255,255,0.72)';
const FAINT = 'rgba(255,255,255,0.5)';
const ACCENT = '#f43f5e';

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
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function money(cent: number): string {
  const yuan = cent / 100;
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
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

/**
 * 上半屏：模特图自身放大虚化、压暗后铺满作背景，原图按比例完整落在中间偏左，
 * 右侧空出二维码卡片的位置。模特图一律 contain，绝不裁切。
 */
function drawStage(ctx: CanvasRenderingContext2D, model: HTMLImageElement | null): void {
  if (model) {
    const scale = Math.max(W / model.width, STAGE_H / model.height);
    const dw = model.width * scale;
    const dh = model.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, STAGE_H);
    ctx.clip();
    ctx.filter = 'blur(24px)';
    ctx.drawImage(model, (W - dw) / 2, (STAGE_H - dh) / 2, dw, dh);
    ctx.filter = 'none';
    ctx.restore();
    ctx.fillStyle = 'rgba(8,10,14,0.62)';
    ctx.fillRect(0, 0, W, STAGE_H);
  } else {
    const bg = ctx.createLinearGradient(0, 0, W, STAGE_H);
    bg.addColorStop(0, '#2b1f25');
    bg.addColorStop(0.55, '#171a21');
    bg.addColorStop(1, INFO_BG);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, STAGE_H);
  }

  if (model) {
    const scale = Math.min(MODEL_W / model.width, STAGE_H / model.height);
    const dw = model.width * scale;
    const dh = model.height * scale;
    const x = (MODEL_W - dw) / 2;
    const y = (STAGE_H - dh) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 10;
    roundRect(ctx, x, y, dw, dh, 18);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, dw, dh, 18);
    ctx.clip();
    ctx.drawImage(model, x, y, dw, dh);
    ctx.restore();
  }

  const top = ctx.createLinearGradient(0, 0, 0, 240);
  top.addColorStop(0, 'rgba(8,10,14,0.65)');
  top.addColorStop(1, 'rgba(8,10,14,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 240);

  const fade = ctx.createLinearGradient(0, STAGE_H - 150, 0, STAGE_H);
  fade.addColorStop(0, 'rgba(8,10,14,0)');
  fade.addColorStop(1, INFO_BG);
  ctx.fillStyle = fade;
  ctx.fillRect(0, STAGE_H - 150, W, 150);
}

function drawInfoPanel(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = INFO_BG;
  ctx.fillRect(0, INFO_TOP, W, H - INFO_TOP);
}

function drawBrand(ctx: CanvasRenderingContext2D, brandTitle: string | null): void {
  ctx.fillStyle = ACCENT;
  ctx.fillRect(PAD, 82, 6, 34);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = px(28, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const text = (brandTitle ?? '').trim() || DEFAULT_BRAND_TITLE;
  // 标题不能压到右侧服装卡片：超出可视宽度时按字符截断并加省略号
  const maxW = RIGHT_X - (PAD + 20) - 16;
  let label = text;
  if (ctx.measureText(label).width > maxW) {
    while (label && ctx.measureText(`${label}…`).width > maxW) label = label.slice(0, -1);
    label = `${label}…`;
  }
  ctx.fillText(label, PAD + 20, 110);
}

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

function splitTwoLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): [string, string] | null {
  const tokens = titleTokens(text);
  let best: { at: number; diff: number } | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const head = tokens.slice(0, i).join('').trim();
    const tail = tokens.slice(i).join('').trim();
    if (!head || !tail) continue;
    const headW = ctx.measureText(head).width;
    const tailW = ctx.measureText(tail).width;
    if (headW > maxWidth || tailW > maxWidth) continue;
    const diff = Math.abs(headW - tailW);
    if (!best || diff < best.diff) best = { at: i, diff };
  }
  if (!best) return null;
  return [tokens.slice(0, best.at).join('').trim(), tokens.slice(best.at).join('').trim()];
}

function drawTitle(ctx: CanvasRenderingContext2D, event: EventDto): void {
  const text = (event.title || '猫爪社摄影会').trim();

  // 左栏较窄：字号从大到小试探，找到能把标题均匀排成两行（或一行）的字号
  let size = 56;
  let lines: string[] = [];
  for (const candidate of [68, 64, 60, 56]) {
    ctx.font = px(candidate, 800);
    size = candidate;
    if (ctx.measureText(text).width <= LEFT_W) {
      lines = [text];
      break;
    }
    const pair = splitTwoLines(ctx, text, LEFT_W);
    if (pair) {
      lines = pair;
      break;
    }
  }
  if (!lines.length) {
    ctx.font = px(56, 800);
    size = 56;
    lines = wrapText(ctx, text, LEFT_W, 3);
  }

  ctx.font = px(size, 800);
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;

  const lineHeight = Math.round(size * 1.26);
  const lastBaseline = 1158;
  lines.forEach((line, i) => {
    ctx.fillText(line, LEFT_X, lastBaseline - (lines.length - 1 - i) * lineHeight);
  });

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawIntro(ctx: CanvasRenderingContext2D, event: EventDto): void {
  const subtitle = event.subtitle?.trim() || event.ratioLabel?.trim() || '';
  if (subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.84)';
    ctx.font = px(30, 500);
    ctx.textAlign = 'left';
    ctx.fillText(wrapText(ctx, subtitle, LEFT_W, 1)[0] ?? '', LEFT_X, 1204);
  }

  const parts: string[] = [];
  if (event.model?.stageName) parts.push(`模特 ${event.model.stageName}`);
  const place = [event.venue, event.scene].filter(Boolean).join(' · ');
  if (place) parts.push(place);
  if (!parts.length) return;

  ctx.fillStyle = MUTED;
  ctx.font = px(26, 400);
  ctx.textAlign = 'left';
  ctx.fillText(wrapText(ctx, parts.join('　·　'), LEFT_W, 1)[0] ?? '', LEFT_X, 1242);
}

function drawDivider(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(LEFT_X, 1272);
  ctx.lineTo(LEFT_X + LEFT_W, 1272);
  ctx.stroke();

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(LEFT_X, 1272);
  ctx.lineTo(LEFT_X + 92, 1272);
  ctx.stroke();
}

/** 时段双列排布：左栏宽度有限，两列比单列更省高度，最多展示 6 场 */
function drawSessions(ctx: CanvasRenderingContext2D, sessions: EventSessionDto[]): void {
  if (!sessions.length) return;
  const sorted = [...sessions].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const maxRows = 6;

  ctx.textAlign = 'left';
  ctx.fillStyle = FAINT;
  ctx.font = px(22, 600);
  const extra = sorted.length > maxRows ? `（共 ${sorted.length} 场）` : '';
  ctx.fillText(`场次安排 · ${dayLabel(sorted[0]!.startAt)}${extra}`, LEFT_X, 1304);

  const cellW = 252;
  const colGap = 24;
  const rowH = 40;
  const firstBaseline = 1342;
  const firstDay = dayKey(sorted[0]!.startAt);

  sorted.slice(0, maxRows).forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = LEFT_X + col * (cellW + colGap);
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

function drawPrices(ctx: CanvasRenderingContext2D, event: EventDto): void {
  const priceOf = (level: 'PUBLIC' | 'VIP' | 'SVIP'): number =>
    event.prices.find((p) => p.level === level)?.priceCent ?? event.feeCent;

  const items: Array<{ level: 'PUBLIC' | 'VIP' | 'SVIP'; label: string; cent: number }> = [
    { level: 'PUBLIC', label: '活动价', cent: priceOf('PUBLIC') },
    { level: 'VIP', label: 'VIP 价', cent: priceOf('VIP') },
    { level: 'SVIP', label: 'SVIP 价', cent: priceOf('SVIP') },
  ];

  const boxW = 168;
  const gap = 12;
  const top = 1438;
  const boxH = 88;

  items.forEach((item, i) => {
    const tone = PRICE_TONES[item.level];
    const x = LEFT_X + i * (boxW + gap);
    roundRect(ctx, x, top, boxW, boxH, 14);
    ctx.fillStyle = tone.fill;
    ctx.fill();
    ctx.strokeStyle = tone.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = tone.label;
    ctx.font = px(21, 500);
    ctx.fillText(item.label, x + boxW / 2, top + 31);

    ctx.fillStyle = tone.amount;
    ctx.font = px(34, 700);
    ctx.fillText(money(item.cent), x + boxW / 2, top + 71);
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = FAINT;
  ctx.font = px(19, 400);
  ctx.fillText('价格为每人每场，会员价以报名时等级为准', LEFT_X, 1550);
}

function drawThumb(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
): void {
  const captionH = 40;
  const areaH = h - captionH;

  ctx.save();
  roundRect(ctx, x, y, w, h, 18);
  ctx.clip();

  // 背景层：cover 裁切 + 模糊；前景层：完整显示，保证服装不被裁掉
  const coverScale = Math.max(w / img.width, areaH / img.height);
  const cw = img.width * coverScale;
  const ch = img.height * coverScale;
  ctx.filter = 'blur(18px)';
  ctx.drawImage(img, x + (w - cw) / 2, y + (areaH - ch) / 2, cw, ch);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(8,10,14,0.35)';
  ctx.fillRect(x, y, w, areaH);

  const fitScale = Math.min(w / img.width, areaH / img.height);
  const fw = img.width * fitScale;
  const fh = img.height * fitScale;
  ctx.drawImage(img, x + (w - fw) / 2, y + (areaH - fh) / 2, fw, fh);

  ctx.fillStyle = ACCENT;
  ctx.fillRect(x, y + h - captionH, w, captionH);
  ctx.restore();

  roundRect(ctx, x, y, w, h, 18);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WHITE;
  ctx.font = px(23, 600);
  ctx.fillText(label, x + w / 2, y + h - 12);
}

/** 右上角卡片：当日服装（报名关键信息，完整显示不裁切）在上，场地照片在下 */
function drawSideCards(
  ctx: CanvasRenderingContext2D,
  wardrobe: HTMLImageElement | null,
  venue: HTMLImageElement | null,
): void {
  let y = PAD;
  if (wardrobe) {
    drawThumb(ctx, wardrobe, RIGHT_X, y, RIGHT_W, 500, '当日服装');
    y += 516;
  }
  if (venue) drawThumb(ctx, venue, RIGHT_X, y, RIGHT_W, 248, '场地照片');
}

/** 右侧竖排二维码卡片：网站二维码在上，客服二维码在下（都贴住右下角） */
function drawQrCard(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  y: number,
  caption: string,
  placeholder?: { title: string; hint: string },
): void {
  const size = 204;
  const x = W - PAD - QR_W;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, x, y, QR_W, QR_H, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.fill();
  ctx.restore();

  if (img) {
    ctx.drawImage(img, x + (QR_W - size) / 2, y + 18, size, size);
  } else if (placeholder) {
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    roundRect(ctx, x + 24, y + 24, QR_W - 48, 176, 12);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#64748b';
    ctx.font = px(20, 500);
    ctx.fillText(placeholder.title, x + QR_W / 2, y + 108);
    ctx.fillStyle = '#94a3b8';
    ctx.font = px(16, 400);
    ctx.fillText(placeholder.hint, x + QR_W / 2, y + 140);
  } else {
    return;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  ctx.font = px(24, 600);
  ctx.fillText(caption, x + QR_W / 2, y + QR_H - 34);
}

function drawFooter(ctx: CanvasRenderingContext2D): void {
  ctx.textAlign = 'left';
  ctx.fillStyle = FAINT;
  ctx.font = px(21, 400);
  ctx.fillText('猫爪摄影会 · 名额有限，扫码锁定你的场次', LEFT_X, 1592);
}

const QR_GAP = 28;
const QR_SERVICE_Y = H - PAD - QR_H;
const QR_SITE_Y = QR_SERVICE_Y - QR_GAP - QR_H;
/** 网站二维码暂时隐藏，导出时只保留客服码 */
const SHOW_SITE_QR = false;

function safeName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
  return cleaned || '场次';
}

export async function exportEventPoster(
  event: EventDto,
  qrUrl: string | null,
  siteQrUrl: string | null = null,
  brandTitle: string | null = null,
): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持导出图片');

  const baseUrl = event.posterUrls?.[0] ?? event.coverUrl ?? '';
  const [baseImg, qrImg, wardrobeImg, venueImg] = await Promise.all([
    loadImage(baseUrl),
    loadImage(qrUrl ?? ''),
    loadImage(event.wardrobeUrls?.[0] ?? ''),
    loadImage(event.venueUrls?.[0] ?? ''),
  ]);
  const siteQrImg = SHOW_SITE_QR ? await loadImage(siteQrUrl || SITE_QR_SRC) : null;

  drawStage(ctx, baseImg);
  drawSideCards(ctx, wardrobeImg, venueImg);
  drawInfoPanel(ctx);
  drawBrand(ctx, brandTitle);
  drawTitle(ctx, event);
  drawIntro(ctx, event);
  drawDivider(ctx);
  drawSessions(ctx, event.sessions);
  drawPrices(ctx, event);
  if (SHOW_SITE_QR) drawQrCard(ctx, siteQrImg, QR_SITE_Y, '扫码进站报名');
  drawQrCard(ctx, qrImg, QR_SERVICE_Y, '扫码添加客服', {
    title: '未配置二维码',
    hint: '请在后台「海报二维码」上传',
  });
  drawFooter(ctx);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('海报生成失败，请重试');

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(event.title)}-海报.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
