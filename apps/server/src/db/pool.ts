/**
 * MySQL 连接池与事务边界。
 *
 * - bigNumberStrings: BIGINT 以字符串返回，与 shared 的 `Id = string` 保持一致；
 *   金额/计数在 DTO 映射层显式 Number() 转换。
 * - withTransaction: 模块 3 的余额、报名必须走这里，且遵守固定加锁顺序
 *   （先锁 balance_accounts，再锁 events，再写流水），避免死锁。
 * - 所有时间由应用侧以 UTC DATETIME(3) 字面值写入，不依赖 DB time_zone。
 */
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';

export const pool: Pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_POOL_SIZE,
  connectTimeout: 3000,
  charset: 'utf8mb4',
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  // DATETIME 以字符串返回：避免 mysql2 按本地时区转成 Date，且与 UTC 字面值写入一致
  dateStrings: true,
  timezone: 'Z',
});

export async function withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  });
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
