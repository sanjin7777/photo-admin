/**
 * 迁移执行器：`npm run migrate`（在 apps/server 下执行）。
 * 前置：docker compose up -d mysql，或直接指向已有 MySQL 8。
 *
 * 注意：MySQL DDL 会隐式提交，事务无法回滚 DDL。这里采用「先执行 SQL、成功后登记版本」，
 * 若中途失败需人工检查已建表后重跑；`schema_migrations` 已执行的版本不会被重复执行。
 * 幂等幂等键与账本写入的事务接入由模块 3 完成。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

async function main(): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_NAME)) {
    throw new Error('DB_NAME 只允许字母、数字、下划线');
  }
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${env.DB_NAME}\``);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [applied] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
    const done = new Set(applied.map((r) => String(r.version)));
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) {
        logger.info(`跳过已执行迁移 ${version}`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      logger.info(`执行迁移 ${version}`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      logger.info(`迁移完成 ${version}`);
    }
    logger.info('全部迁移已应用');
  } finally {
    await conn.end();
  }
}

main().catch((error: unknown) => {
  logger.error('迁移失败', { error: String(error) });
  process.exitCode = 1;
});
