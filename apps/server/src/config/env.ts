/**
 * 环境变量集中校验：启动即失败优于运行期才炸。
 * ⚠️ 开发期给了可用的默认密钥，生产环境必须显式提供，否则拒绝启动。
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS } from '@photo/shared';

// 从 apps/server/.env 加载（不依赖进程 cwd）；.env 不存在时静默使用默认值
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

/** 仓库里公开的开发默认密钥；生产环境即使显式传入也必须拒绝 */
const DEV_ACCESS_SECRET = 'dev-only-access-secret-change-me-32chars-min';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().min(1).default('photo'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1).default('photo_club'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET 至少 32 字符').default(DEV_ACCESS_SECRET),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(ACCESS_TOKEN_TTL_SECONDS),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(REFRESH_TOKEN_TTL_DAYS),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (!raw.JWT_ACCESS_SECRET) {
      throw new Error('生产环境必须显式配置 JWT_ACCESS_SECRET');
    }
    if (raw.JWT_ACCESS_SECRET === DEV_ACCESS_SECRET) {
      throw new Error('生产环境不得使用仓库内的开发默认 JWT_ACCESS_SECRET');
    }
  }
  return parsed.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}

export const env = parseEnv(process.env);
