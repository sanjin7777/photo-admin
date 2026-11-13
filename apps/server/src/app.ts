/** Express 应用组装：中间件顺序 = context → audit → 路由 → 404 → 全局异常。 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { API_BASE_PATH, AppError, BIZ_CODES } from '@photo/shared';
import { corsOrigins, env } from './config/env';
import { contextMiddleware } from './middleware/context';
import { auditContextMiddleware } from './middleware/audit';
import { errorMiddleware, notFoundHandler } from './middleware/error';
import authRouter from './modules/auth/routes';
import meRouter from './modules/me/routes';
import healthRouter from './modules/health/routes';
import { mountDomainRoutes } from './modules';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY ? 1 : false);

// CSP 由最外层 Nginx 统一下发；避免 Helmet 的默认 CSP 与之叠加取交集后误拦资源
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: corsOrigins(env), credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Cookie 模式下的 CSRF 防护：写操作必须来自白名单 Origin（SameSite 之外的第二层）
const allowedOrigins = new Set(corsOrigins(env));
app.use((req, _res, next) => {
  const origin = req.header('Origin');
  if (!origin) {
    next();
    return;
  }
  const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (!safeMethod && !allowedOrigins.has(origin)) {
    next(new AppError(BIZ_CODES.FORBIDDEN, '请求来源不被允许'));
    return;
  }
  next();
});

app.use(contextMiddleware);
app.use(auditContextMiddleware);

app.use(`${API_BASE_PATH}/health`, healthRouter);
app.use(`${API_BASE_PATH}/auth`, authRouter);
app.use(`${API_BASE_PATH}/me`, meRouter);

// 领域路由：events / registrations / balance / refunds / votes / memberships / admin
mountDomainRoutes(app);

app.use(notFoundHandler);
app.use(errorMiddleware);

export { app };
