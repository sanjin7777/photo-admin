import type { EventDto, MemberLevel } from '@photo/shared';

/** 按等级取价：SVIP 无专属价回退 VIP，再回退公开价；与后端 pickPrice 保持同序 */
export function priceFor(event: EventDto, level: MemberLevel): number {
  const find = (lv: string) => event.prices?.find((p) => p.level === lv)?.priceCent;
  if (level === 'SVIP') return find('SVIP') ?? find('VIP') ?? find('PUBLIC') ?? event.feeCent;
  if (level === 'VIP') return find('VIP') ?? find('PUBLIC') ?? event.feeCent;
  return find('PUBLIC') ?? event.feeCent;
}

export function publicPriceOf(event: EventDto): number {
  return event.prices?.find((p) => p.level === 'PUBLIC')?.priceCent ?? event.feeCent;
}

export function yuan(cent: number): string {
  return `¥${(cent / 100).toFixed(cent % 100 === 0 ? 0 : 2)}`;
}

export function timeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const d = s.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const hm = (x: Date) => x.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${d} ${hm(s)}–${hm(e)}`;
}
