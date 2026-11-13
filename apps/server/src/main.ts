import { app } from './app';
import { env } from './config/env';
import { ping } from './db/pool';
import { logger } from './utils/logger';

app.listen(env.PORT, () => {
  logger.info('服务已启动', { port: env.PORT, nodeEnv: env.NODE_ENV });
  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.startsWith('dev-only')) {
    logger.warn('生产环境仍在使用示例密钥，请立即更换 JWT_ACCESS_SECRET');
  }
  void ping().then((up) => {
    if (!up) logger.warn('MySQL 未连接：先 docker compose up -d mysql，再在 apps/server 执行 npm run migrate');
  });
});
