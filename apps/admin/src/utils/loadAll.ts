/**
 * 后台列表兜底：服务端单页上限 100（PAGE_SIZE_MAX），超过后旧数据会直接看不到。
 * 这里按页拉全量，保持现有列表 UI 不变；最多 50 页（5000 条）防止接口 total 异常时死循环。
 *
 * ⚠️ 这是过渡方案：报名、退款、流水这类只增不减的表迟早会突破 5000 条，
 * 届时必须改成服务端筛选 + 真分页（见 docs 里「待优化清单」）。当前数据量下够用。
 */
export const LOAD_ALL_MAX_PAGES = 50;

export interface PageSlice<T> {
  list: T[];
  total: number;
}

/** 空页对象：让 `.catch(() => emptyPage())` 不再需要 `as never` 断言 */
export function emptyPage<T>(): PageSlice<T> {
  return { list: [], total: 0 };
}

export async function loadAllPages<T>(
  fetchPage: (page: number, pageSize: number) => Promise<PageSlice<T>>,
  pageSize = 100,
): Promise<PageSlice<T>> {
  const list: T[] = [];
  let total = 0;
  for (let page = 1; page <= LOAD_ALL_MAX_PAGES; page += 1) {
    const res = await fetchPage(page, pageSize);
    total = res.total;
    list.push(...(res.list ?? []));
    if (!res.list?.length || list.length >= total) break;
  }
  return { list, total };
}
