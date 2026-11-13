/**
 * 时间统一 UTC。
 * DB 列为 DATETIME(3)（无时区），因此由应用侧生成 UTC 字面值写入，
 * 避免依赖 MySQL 服务器 time_zone；展示层再按 Asia/Shanghai 转换。
 */

/** `Date` → MySQL DATETIME(3) 字面值，例：'2026-11-09 08:00:00.000' */
export function toSqlDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').slice(0, 23);
}

export function sqlDateTimeFrom(epochMs: number): string {
  return toSqlDateTime(new Date(epochMs));
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 24 * 60 * 60);
}

/** DB 里的 UTC DATETIME 字面值 → Date */
export function fromSqlDateTime(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export function isPast(value: Date | string, now: Date = new Date()): boolean {
  return fromSqlDateTime(value).getTime() <= now.getTime();
}

/** mysql2 返回的 DATETIME（Date）或字面值字符串 → ISO 8601 UTC */
export function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return fromSqlDateTime(value).toISOString();
}

/**
 * 运营所在时区固定 UTC+8（Asia/Shanghai 无夏令时，全系统只有这一个时区）。
 *
 * 后台筛选框里选的是**本地自然日**「2026-10-01 ~ 2026-10-07」，
 * 而 DB 存的是 UTC 字面值。直接把 '2026-10-01' 塞进 SQL 会按 UTC 零点切分，
 * 导致北京时间 10-01 00:00–08:00 的单子被算进 9 月 30 日——财务对账会差一天。
 */
const LOCAL_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 本地自然日区间 → UTC DATETIME(3) 半开区间 `[start, end)`。
 *
 * 返回 end 是**次日零点**而不是当日 23:59:59，配合 SQL 的 `< end` 使用：
 * 这样当天 23:59:59.500 这类带毫秒的记录也不会漏（DATETIME(3) 有毫秒精度）。
 * 两个参数都可缺省，缺省侧不加边界条件（由调用方决定是否拼进 WHERE）。
 */
export function localDayRangeUtc(
  dateFrom?: string,
  dateTo?: string,
): { start: string | null; end: string | null } {
  const toUtc = (day: string, dayOffset: number): string => {
    const [y, m, d] = day.split('-').map(Number);
    const localMidnight = Date.UTC(y!, (m ?? 1) - 1, d!, 0, 0, 0, 0) - LOCAL_UTC_OFFSET_MS;
    return toSqlDateTime(new Date(localMidnight + dayOffset * 24 * 60 * 60 * 1000));
  };
  return {
    start: dateFrom ? toUtc(dateFrom, 0) : null,
    end: dateTo ? toUtc(dateTo, 1) : null,
  };
}
