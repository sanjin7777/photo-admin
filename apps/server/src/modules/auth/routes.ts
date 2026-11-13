import { Router } from 'express';
import {
  AppError,
  BIZ_CODES,
  loginSchema,
  registerSchema,
  type LoginPayload,
  type RegisterPayload,
} from '@photo/shared';
import { readCookie, REFRESH_COOKIE } from '../../utils/cookies';
import { authenticate } from '../../middleware/auth';
import { getIdentity } from '../../middleware/context';
import { asyncHandler } from '../../middleware/error';
import { validateBody } from '../../middleware/validate';
import { sendOk } from '../../utils/response';
import { login, logout, refresh, register } from './service';

const router = Router();

router.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const user = await register(req.body as RegisterPayload, {
      ip: req.ip ?? null,
      ua: req.get('user-agent') ?? null,
    });
    sendOk(res, user, 201);
  }),
);

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await login(req.body as LoginPayload, res));
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    // refresh token 只存在于 HttpOnly Cookie，前端不传任何参数
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    const token = readCookie(req, REFRESH_COOKIE)
      ?? (typeof body.refreshToken === 'string' ? body.refreshToken : '');
    sendOk(res, await refresh(token, res));
  }),
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    await logout(identity.userId, readCookie(req, REFRESH_COOKIE) ?? undefined, res);
    sendOk(res, null);
  }),
);

export default router;
