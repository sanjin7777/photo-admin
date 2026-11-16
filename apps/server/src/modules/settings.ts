/**
 * 系统设置：后台「海报二维码」（网站码 + 客服码 + 左上角标题 + 海报版式），
 * 以及前台报名页展示的客服二维码。
 *
 * 用键值表 app_settings 存储（迁移 014 预置 poster_qr_url=NULL；其余键按需写入，无需追加迁移），
 * 同一张表后续可复用给公告、客服微信等运营配置。
 * 二维码只做「图片地址」校验：站内 /uploads 路径或 http(s)，拒绝其它协议；
 * 标题留空即回退海报内置默认文案。
 *
 * 版式（layout）单独存 `poster_layout` 键，值是一段 JSON；
 * 读取时若 JSON 损坏或不符合当前 schema，一律降级为 null（前端回退预设），
 * 不让一条脏数据把整个海报功能卡死。
 */
import type { Express } from 'express';
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  posterLayoutSchema,
  posterLayoutUpdateSchema,
  posterSettingsUpdateSchema,
  type PosterLayoutDto,
  type PosterLayoutUpdatePayload,
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
const LAYOUT_KEY = 'poster_layout';

/** 解析存库的版式 JSON；任何异常都降级为 null，避免脏数据毒化导出 */
function parseLayout(raw: string | null): PosterLayoutDto | null {
  if (!raw) return null;
  try {
    const parsed = posterLayoutSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 一次读出两枚二维码、海报标题与版式，未写入的键返回 null */
async function readQrSettings(): Promise<PosterSettingsDto> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?, ?, ?)',
    [QR_KEY, SITE_QR_KEY, BRAND_TITLE_KEY, LAYOUT_KEY],
  );
  const map = new Map(
    rows.map((r) => [String(r.setting_key), r.setting_value == null ? null : String(r.setting_value)]),
  );
  return {
    qrUrl: map.get(QR_KEY) ?? null,
    siteQrUrl: map.get(SITE_QR_KEY) ?? null,
    brandTitle: map.get(BRAND_TITLE_KEY) ?? null,
    layout: parseLayout(map.get(LAYOUT_KEY) ?? null),
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
        // 只在显式传了 layout 时才写，避免「改二维码」把设计好的版式清掉
        payload.layout === undefined
          ? Promise.resolve()
          : writeSetting(LAYOUT_KEY, payload.layout ? JSON.stringify(payload.layout) : null),
      ]);
      sendOk(res, await readQrSettings());
    }),
  );

  /**
   * 版式单独读写：设计器点保存只碰这一个键。
   * 与上面的 PUT / 分开，避免设计器请求里没带二维码字段时把它们覆盖成 null。
   */
  router.get(
    '/layout',
    requireCapabilities('admin:event:write'),
    asyncHandler(async (_req, res) => {
      sendOk(res, (await readQrSettings()).layout);
    }),
  );

  router.put(
    '/layout',
    requireCapabilities('admin:event:write'),
    validateBody(posterLayoutUpdateSchema),
    asyncHandler(async (req, res) => {
      const { layout } = req.body as PosterLayoutUpdatePayload;
      // null = 清除自定义版式，回退预设
      await writeSetting(LAYOUT_KEY, layout ? JSON.stringify(layout) : null);
      sendOk(res, layout);
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
