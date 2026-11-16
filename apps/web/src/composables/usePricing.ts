import type { EventDto, MemberLevel } from '@photo/shared';
import { pointsOf } from '@photo/shared';

/**
 * 前台计价工具（已去货币化）。
 *
 * 约定：站点不出现任何货币符号与「元」字。场次档案里的 price_cent 现在只作
 * **积分台账的存储单位**（1 积分 = 100 单位，保留两位小数精度），对外一律显示为「积分」。
 * 积分不可购买、不可退还、不可转让，仅由运营发放，因此不构成预付储值。
 */

/** 按等级取积分：SVIP 无专属值回退 VIP，再回退公开值；与后端 pickPrice 保持同序 */
export function pointsFor(event: EventDto, level: MemberLevel): number {
  const find = (lv: string) => event.prices?.find((p) => p.level === lv)?.priceCent;
  if (level === 'SVIP') return find('SVIP') ?? find('VIP') ?? find('PUBLIC') ?? event.feeCent;
  if (level === 'VIP') return find('VIP') ?? find('PUBLIC') ?? event.feeCent;
  return find('PUBLIC') ?? event.feeCent;
}

/** 公开档所需积分（未登录 / 普通用户看到的基准） */
export function publicPointsOf(event: EventDto): number {
  return event.prices?.find((p) => p.level === 'PUBLIC')?.priceCent ?? event.feeCent;
}

/**
 * 积分文案：入参是台账存储单位（分数量级），输出「189 积分」。
 * 兼容金额写法的地方统一改成这个，确保页面里不再有「¥」。
 */
export function pts(cent: number): string {
  const value = pointsOf(cent);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} 积分`;
}

/** 只要数字不要单位（用于「消耗 189 积分」这类拼接） */
export function ptsNum(cent: number): string {
  const value = pointsOf(cent);
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function timeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const d = s.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const hm = (x: Date) => x.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${d} ${hm(s)}–${hm(e)}`;
}
