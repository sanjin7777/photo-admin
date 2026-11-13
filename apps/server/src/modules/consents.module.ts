/**
 * 协议同意：查询当前用户对最新版用户协议 / 隐私政策的同意状态，并写入留痕。
 *
 * 注册时已在同一事务内写入首次同意；这里服务于存量用户（迁移前注册）与协议改版后的补勾。
 * 只接受明确的 agreed=true，避免空请求被当成同意。
 */
import type { Express } from 'express';
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  LEGAL_VERSION,
  consentAcceptSchema,
  type ConsentStatusDto,
} from '@photo/shared';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { sendOk } from '../utils/response';

async function statusOf(userId: string): Promise<ConsentStatusDto> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT agreement_type FROM user_consents WHERE user_id = ? AND version = ?',
    [userId, LEGAL_VERSION],
  );
  const types = new Set(rows.map((r) => String(r.agreement_type)));
  const agreedTerms = types.has('TERMS');
  const agreedPrivacy = types.has('PRIVACY');
  return {
    termsVersion: LEGAL_VERSION,
    privacyVersion: LEGAL_VERSION,
    agreedTerms,
    agreedPrivacy,
    needConsent: !(agreedTerms && agreedPrivacy),
  };
}

export function mountConsents(app: Express): void {
  const router = Router();
  router.use(authenticate);

  router.get('/', asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    sendOk(res, await statusOf(identity.userId));
  }));

  router.post('/', validateBody(consentAcceptSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const ip = req.ip ?? null;
    const ua = req.get('user-agent')?.slice(0, 255) ?? null;
    // 同一版本重复同意不覆盖首次时间：唯一键 + INSERT IGNORE
    await pool.execute(
      `INSERT IGNORE INTO user_consents (user_id, agreement_type, version, ip, ua)
       VALUES (?, 'TERMS', ?, ?, ?), (?, 'PRIVACY', ?, ?, ?)`,
      [identity.userId, LEGAL_VERSION, ip, ua, identity.userId, LEGAL_VERSION, ip, ua],
    );
    sendOk(res, await statusOf(identity.userId));
  }));

  app.use(`${API_BASE_PATH}/me/consents`, router);
}
