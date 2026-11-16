import { Router } from 'express';
import {
  AppError,
  BIZ_CODES,
  changePasswordSchema,
  deleteAccountSchema,
  type CapabilitiesDto,
  type ChangePasswordPayload,
  type DeleteAccountPayload,
} from '@photo/shared';
import { authenticate } from '../../middleware/auth';
import { getIdentity } from '../../middleware/context';
import { asyncHandler } from '../../middleware/error';
import { validateBody } from '../../middleware/validate';
import { sendOk } from '../../utils/response';
import { changePassword, deleteAccount, toUserDto } from '../auth/service';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    sendOk(res, toUserDto(identity));
  }),
);

/** 前端只用于渲染；后端每个接口独立鉴权，不以此清单为安全依据 */
router.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const dto: CapabilitiesDto = {
      capabilities: [...identity.capabilities],
      level: identity.level,
      backendRoles: identity.backendRoles,
      sessionVersion: identity.sessionVersion,
      issuedAt: new Date().toISOString(),
    };
    sendOk(res, dto);
  }),
);

/** 本人修改密码；导入账号首次登录也走这里解除强制改密 */
router.post(
  '/password',
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    sendOk(res, await changePassword(identity.userId, req.body as ChangePasswordPayload, res));
  }),
);

/**
 * 本人注销账号。
 * 用 POST 而非 DELETE：部分反向代理会丢弃 DELETE 的请求体，导致密码校验读不到。
 */
router.post(
  '/delete',
  validateBody(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    await deleteAccount(identity.userId, (req.body as DeleteAccountPayload).password, res);
    sendOk(res, null);
  }),
);

export default router;
