/**
 * 积分与金额换算。
 *
 * 业务口径（2026-11-11 用户确认）：1 积分 = 1 元，存量余额按 1 元 = 1 积分等价转换。
 * 账本仍以「分」为最小单位存储（沿用 *_cent 列，避免改表），仅在展示与录入时换算成积分，
 * 这样 0.01 元的差额不会因取整丢失。
 */
export const CENT_PER_POINT = 100;

/** 账本单位（分）→ 积分数值 */
export function pointsOf(cent: number | null | undefined): number {
  if (cent == null) return 0;
  return cent / CENT_PER_POINT;
}

/** 积分录入值 → 账本单位（分），四舍五入到分 */
export function pointsToCent(points: number): number {
  return Math.round(points * CENT_PER_POINT);
}

/** 账本单位（分）→ 积分展示文本：整数不带小数，非整数保留两位 */
export function formatPoints(cent: number | null | undefined): string {
  if (cent == null) return '—';
  const value = pointsOf(cent);
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
