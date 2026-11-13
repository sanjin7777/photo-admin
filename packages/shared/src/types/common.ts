/**
 * 通用传输类型。
 *
 * 关键约定：
 * - `Id` 用字符串：MySQL BIGINT UNSIGNED 主键超过 2^53 时 JSON number 会丢精度。
 * - 金额统一「分」的整数；DB 列 `xxx_cent` ↔ API 字段 `xxxCent`。
 * - 时间统一带时区的 ISO 8601 字符串；DB 存 UTC，展示层按 Asia/Shanghai 转换。
 */

export type Id = string;
export type ISODateTime = string;
export type Cent = number;

/** 报名时固化到 registration 上的退款规则快照，避免规则事后变更引发争议 */
export interface RefundPolicy {
  freeCancelBeforeHours: number;
  feeRatio: number;
}

export interface Timestamps {
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
  /** 例：`-createdAt` 表示按创建时间倒序 */
  sort?: string;
}

export interface Paginated<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}
