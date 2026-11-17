/**
 * 幂等 DB helper（供模块 3 在**业务事务内**调用，与业务写入共用同一连接/事务）。
 * 模块 2 只提供骨架，不接管路由；这样「幂等记录 + 余额流水 + 报名」能原子提交。
 */
import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AppError, BIZ_CODES, IDEMPOTENCY_DEDUP_WINDOW_HOURS } from '@photo/shared';
import { addSeconds, toSqlDateTime } from '../utils/datetime';

interface IdempotencyRow extends RowDataPacket {
  idem_key: string;
  scope: string;
  request_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_json: string | null;
  expires_at: string;
}

export function requestHash(method: string, requestPath: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}:${requestPath}:${JSON.stringify(body ?? {})}`)
    .digest('hex');
}

/**
 * 幂等键按用户隔离（DDL idem_key 为 CHAR(36)，故取 SHA-256 前 36 位）。
 * 未隔离时，攻击者只要拿到别人的 key 就能回放对方的缓存响应。
 */
export function scopedIdempotencyKey(userId: string, key: string): string {
  return createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 36);
}

export interface ClaimResult {
  /** 非 null 表示命中已完成请求，直接回放缓存的业务数据，不再执行业务 */
  replay: { data: unknown } | null;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** 在事务内抢占；唯一索引兜底并发。命中同键不同参 → 幂等冲突。 */
export async function claimIdempotency(
  conn: PoolConnection,
  args: { key: string; scope: string; hash: string },
): Promise<ClaimResult> {
  const expiresAt = toSqlDateTime(addSeconds(new Date(), IDEMPOTENCY_DEDUP_WINDOW_HOURS * 3600));
  try {
    await conn.execute(
      "INSERT INTO idempotency_keys (idem_key, scope, request_hash, status, expires_at) VALUES (?, ?, ?, 'IN_PROGRESS', ?)",
      [args.key, args.scope, args.hash, expiresAt],
    );
    return { replay: null };
  } catch (error: unknown) {
    if (!isDuplicateKey(error)) throw error;
    const [rows] = await conn.execute<IdempotencyRow[]>(
      'SELECT * FROM idempotency_keys WHERE idem_key = ? FOR UPDATE',
      [args.key],
    );
    const row = rows[0];
    if (!row) throw new AppError(BIZ_CODES.CONCURRENCY_CONFLICT);
    if (row.request_hash !== args.hash || row.scope !== args.scope) {
      throw new AppError(BIZ_CODES.IDEMPOTENCY_CONFLICT);
    }
    if (row.status === 'COMPLETED' && row.response_json) {
      // response_json 存的是业务数据（如 RegistrationBatchDto），由调用方路由层再包响应壳。
      // mysql2 可能把 JSON 列自动解析成对象，也可能返回字符串，两种都兼容。
      const cached = typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
      return { replay: { data: cached } };
    }
    if (row.status === 'IN_PROGRESS') {
      throw new AppError(BIZ_CODES.CONCURRENCY_CONFLICT);
    }
    return { replay: null };
  }
}

export async function completeIdempotency(
  conn: PoolConnection,
  key: string,
  data: unknown,
): Promise<void> {
  await conn.execute(
    "UPDATE idempotency_keys SET status = 'COMPLETED', response_json = ? WHERE idem_key = ?",
    [JSON.stringify(data), key],
  );
}

export async function failIdempotency(conn: PoolConnection, key: string): Promise<void> {
  await conn.execute("UPDATE idempotency_keys SET status = 'FAILED' WHERE idem_key = ?", [key]);
}
