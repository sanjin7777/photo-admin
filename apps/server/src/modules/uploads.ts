/**
 * 图片上传（后台上传场次海报、当日服装、投票方案图）。
 *
 * 存储：服务器本地磁盘（与现有部署方式一致），目录由 UPLOAD_DIR 决定，
 * 默认 `<cwd>/data/uploads`，按 YYYY/MM 分目录、用 uuid 命名。
 * 通过 `/uploads/...` 同源提供，前端拿到 URL 直接放进 img src。
 *
 * 安全：
 * - 不采信 Content-Type 与扩展名，一律按**文件头魔数**判定真实类型；
 * - 白名单只允许 jpeg / png / webp；**拒绝 SVG**（可内嵌脚本，是 XSS 载体）；
 * - 单文件 ≤ 5MB，单请求单文件；
 * - 落盘用 uuid 重命名，原始文件名只用于回显，绝不参与路径拼接。
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { API_BASE_PATH, AppError, BIZ_CODES, type UploadResultDto } from '@photo/shared';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { asyncHandler } from '../middleware/error';
import { sendOk } from '../utils/response';
import { classifyImage } from './nsfw';

const MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');

type AllowedMime = 'image/jpeg' | 'image/png' | 'image/webp';
const EXT_OF: Record<AllowedMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 按文件头判断真实图片类型；只认这三种，其余一律拒绝 */
function sniff(buf: Buffer): AllowedMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.subarray(0, 8).equals(png)) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function mountUploads(app: Express): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // 同源静态托管：文件名带 uuid、内容不可变，可以放心长缓存
  app.use(
    '/uploads',
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      next();
    },
    express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny' }),
  );

  const router = Router();
  router.use(authenticate, requireCapabilities('admin:media:upload'));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
  });

  router.post(
    '/',
    // 用回调形式包一层，把 multer 的错误（尤其体积超限）翻译成业务错误码，避免 500
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) { next(); return; }
        const code = (err as { code?: string }).code;
        next(new AppError(
          BIZ_CODES.INVALID_PARAM,
          code === 'LIMIT_FILE_SIZE' ? '图片不能超过 5MB' : '上传失败，请重试',
        ));
      });
    },
    asyncHandler(async (req, res) => {
      const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
      if (!file?.buffer?.length) throw new AppError(BIZ_CODES.INVALID_PARAM, '请选择要上传的图片');

      const mime = sniff(file.buffer);
      if (!mime) {
        throw new AppError(
          BIZ_CODES.INVALID_PARAM,
          '只支持 JPG / PNG / WebP；不支持 SVG（存在安全风险），请另存为 PNG 后再上传',
        );
      }

      /**
       * 内容安全检测（NSFW）。
       *
       * 策略由环境变量控制：
       *   · UPLOAD_NSFW_STRICT=1（生产建议）：模型不可用时**拒绝上传**，宁可不给传；
       *   · 未设置（默认）：模型不可用时放行并记警告，避免模型没配好导致全站不能传图。
       * 命中违规（Porn/Hentai 超过阈值）一律拒绝，与 strict 无关。
       */
      const verdict = await classifyImage(file.buffer);
      if (verdict.available && verdict.blocked) {
        throw new AppError(
          BIZ_CODES.INVALID_PARAM,
          `图片疑似含有违规内容（${verdict.topCategory}），已拒绝上传；如为误判请联系管理员`,
        );
      }
      if (!verdict.available) {
        const strict = process.env.UPLOAD_NSFW_STRICT === '1';
        if (strict) {
          throw new AppError(
            BIZ_CODES.DEPENDENCY_UNAVAILABLE,
            '图片内容检测服务当前不可用，已拒绝上传；请联系管理员检查模型配置',
          );
        }
      }

      const now = new Date();
      const sub = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const dir = path.join(UPLOAD_DIR, sub);
      await fs.promises.mkdir(dir, { recursive: true });

      const name = `${randomUUID()}.${EXT_OF[mime]}`;
      await fs.promises.writeFile(path.join(dir, name), file.buffer);

      const dto: UploadResultDto = {
        url: `/uploads/${sub}/${name}`,
        name: file.originalname || name,
        size: file.buffer.length,
        mimeType: mime,
      };
      sendOk(res, dto, 201);
    }),
  );

  app.use(`${API_BASE_PATH}/admin/uploads`, router);
}
