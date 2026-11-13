/**
 * 系统设置：后台「海报二维码」（网站码 + 客服码 + 左上角标题），以及前台报名页展示的客服二维码。
 *
 * 用键值表 app_settings 存储（迁移 014 预置 poster_qr_url=NULL；其余键按需写入，无需追加迁移），
 * 同一张表后续可复用给公告、客服微信等运营配置。
 * 二维码只做「图片地址」校验：站内 /uploads 路径或 http(s)，拒绝其它协议；
 * 标题留空即回退海报内置默认文案。
 */
import type { Express } from 'express';
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  posterSettingsUpdateSchema,
  type PosterSettingsDto,
  type PosterSettingsUpdatePayload,
  type PublicSettingsDto,
} from '@photo/shared';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { sendOk } from '../utils/response';

const QR_KEY = 'poster_qr_url';
const SITE_QR_KEY = 'site_qr_url';
const BRAND_TITLE_KEY = 'poster_brand_title';

/** 一次读出两枚二维码与海报标题，未写入的键返回 null */
async function readQrSettings(): Promise<PosterSettingsDto> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?, ?)',
    [QR_KEY, SITE_QR_KEY, BRAND_TITLE_KEY],
  );
  const map = new Map(
    rows.map((r) => [String(r.setting_key), r.setting_value == null ? null : String(r.setting_value)]),
  );
  return {
    qrUrl: map.get(QR_KEY) ?? null,
    siteQrUrl: map.get(SITE_QR_KEY) ?? null,
    brandTitle: map.get(BRAND_TITLE_KEY) ?? null,
  };
}

async function writeSetting(key: string, value: string | null): Promise<void> {
  await pool.execute(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  );
}

export function mountPosterSettings(app: Express): void {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/',
    requireCapabilities('admin:event:write'),
    asyncHandler(async (_req, res) => {
      sendOk(res, await readQrSettings());
    }),
  );

  router.put(
    '/',
    requireCapabilities('admin:event:write'),
    validateBody(posterSettingsUpdateSchema),
    asyncHandler(async (req, res) => {
      const payload = req.body as PosterSettingsUpdatePayload;
      const siteQrUrl = payload.siteQrUrl ?? null;
      const brandTitle = payload.brandTitle ?? null;
      await Promise.all([
        writeSetting(QR_KEY, payload.qrUrl),
        writeSetting(SITE_QR_KEY, siteQrUrl),
        writeSetting(BRAND_TITLE_KEY, brandTitle),
      ]);
      const dto: PosterSettingsDto = { qrUrl: payload.qrUrl, siteQrUrl, brandTitle };
      sendOk(res, dto);
    }),
  );

  app.use(`${API_BASE_PATH}/admin/settings/poster`, router);
}

/**
 * 前台报名页要展示客服二维码，用户未登录也要能拿到，故单独开一个只读公开路由，
 * 只暴露二维码地址，不含任何后台配置项。
 */
export function mountPublicSettings(app: Express): void {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const dto: PublicSettingsDto = { serviceQrUrl: (await readQrSettings()).qrUrl };
      sendOk(res, dto);
    }),
  );

  app.use(`${API_BASE_PATH}/settings/public`, router);
}
