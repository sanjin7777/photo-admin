/**
 * 开发期限流：内存令牌桶（按 userId / IP 维度）。
 * 模块 6 / 上线时替换为 Redis 令牌桶；此处不引入 Redis 依赖，符合「暂不部署」边界。
 */
export interface Limiter {
  take(key: string, now?: number): boolean;
  reset(key: string): void;
}

/**
 * 顺序淘汰最老的桶，而不是无上限增长。
 * 投票限流含 IP 维度，未认证请求可用大量伪造 IP 撑大 Map，必须有上限兜底。
 */
const DEFAULT_MAX_ENTRIES = 10_000;
/** 超过该时长未访问的桶视为过期，先于顺序淘汰被清理 */
const DEFAULT_TTL_MS = 10 * 60_000;

export function createLimiter(
  capacity: number,
  refillPerSecond: number,
  options: { maxEntries?: number; ttlMs?: number } = {},
): Limiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  const prune = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > ttlMs) buckets.delete(key);
    }
    // Map 保持插入顺序，最老的键先淘汰；容量只作为内存上限，不保证精确 LRU
    while (buckets.size > maxEntries) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };

  return {
    take(key: string, now: number = Date.now()): boolean {
      if (!buckets.has(key) && buckets.size >= maxEntries) prune(now);
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
      const elapsed = Math.max(0, (now - bucket.updatedAt) / 1000);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
      bucket.updatedAt = now;
      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return false;
      }
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

/** 投票：用户维度，容量 5、每 2 秒补 1 个；与 IP 维度并用 */
export const voteLimiter = createLimiter(5, 0.5);
/** 登录：账号维度，容量 5、每 10 秒补 1 个（与 DB 失败次数锁双重） */
export const loginLimiter = createLimiter(5, 0.1);
