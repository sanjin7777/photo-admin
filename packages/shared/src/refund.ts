/**
 * 取消报名的退款规定计算（前后端共用）。
 *
 * 背景：服务端在事务里已经用同一套规则算实际退款，但**前端在用户点「取消」之前**
 * 也要能算出「这一单能退多少」，否则确认框只能说「退款金额以规则为准」——
 * 用户最关心的恰恰是具体退多少钱。
 *
 * 这里只放纯函数与常量，不依赖 Node 或浏览器 API，两端可安全共用。
 */

/** 默认免费取消提前量（小时）；与 server 的 FREE_CANCEL_BEFORE_HOURS 保持一致 */
export const DEFAULT_FREE_CANCEL_BEFORE_HOURS = 48;

/** 解析服务端下发的 DATETIME（无时区字符串按 UTC）为时间戳 */
function parseUtc(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * 是否还在可取消窗口内。
 *
 * 语义：距场次开始仍不早于「免费取消提前量」小时数。
 * 注意与退款金额是两件事——超出窗口连取消都不允许，不是「少退钱」。
 */
export function canCancelRegistration(
  freeCancelBeforeHours: number,
  startAt: string,
  now: Date = new Date(),
): boolean {
  const ms = parseUtc(startAt) - now.getTime();
  return ms >= freeCancelBeforeHours * 3_600_000;
}

/**
 * 退款金额（分）。
 *
 * 与 server 的 refundAmountOf 完全一致：按手续费率扣减，结果不为负。
 * feeRatio 为 0 表示全额退款；为 1 表示全扣。
 */
export function refundAmountOf(feeCent: number, feeRatio: number): number {
  const fee = Number.isFinite(feeCent) ? feeCent : 0;
  const ratio = Number.isFinite(feeRatio) ? feeRatio : 0;
  if (ratio <= 0 || ratio >= 1) return Math.max(0, fee - Math.round(fee * ratio));
  return Math.max(0, Math.round(fee * (1 - ratio)));
}

/** 场次开始前还剩多少毫秒（负数表示已开始） */
export function msUntilStart(startAt: string, now: Date = new Date()): number {
  return parseUtc(startAt) - now.getTime();
}

/**
 * 取消时机描述：给用户看的一句话。
 * 例如「距开始 3 天」/「距开始 5 小时」。
 */
export function formatUntilStart(startAt: string, now: Date = new Date()): string {
  const ms = msUntilStart(startAt, now);
  if (ms <= 0) return '活动已开始';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    return `距开始约 ${minutes} 分钟`;
  }
  if (hours < 24) return `距开始约 ${hours} 小时`;
  return `距开始约 ${Math.floor(hours / 24)} 天`;
}
