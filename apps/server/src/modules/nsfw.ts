/**
 * 图片内容安全检测（NSFW）。
 *
 * 目标：阻止上传淫秽色情图片。
 * 使用 nsfwjs + @tensorflow/tfjs（纯 JS 后端，**无需原生编译**，Alpine 镜像直接可用）。
 *
 * 模型来源：
 *   · 默认用 nsfwjs **包内置**的 MobileNetV2 模型（`nsfw.load()` 不传参数），
 *     无需另外下载权重文件，也不需要运行时外网访问；
 *   · 如需更大模型或自建模型，设置 NSFW_MODEL_DIR 指向含 model.json 的目录即可。
 *
 * 设计要点：
 *   · **模型不可用不阻塞上传**：加载失败返回 `available:false`，
 *     由 uploads.ts 按 UPLOAD_NSFW_STRICT 决定放行还是拒绝，
 *     避免「模型没配好 → 全站不能传图」。
 *   · **懒加载 + 单例**：首次上传才加载（约 4s），之后复用。
 *   · 纯 JS 版 tfjs 没有 Node 图像解码器，所以用 sharp 把图解成 RGB 像素再喂模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { logger } from '../utils/logger';

/** nsfwjs 的五个分类；Porn / Hentai 为明确违规，Sexy 为擦边但不拦 */
export type NsfwCategory = 'Drawing' | 'Hentai' | 'Neutral' | 'Porn' | 'Sexy';

export interface NsfwVerdict {
  /** false = 模型没加载成功，此时 scores 为空，调用方需按策略决定放行与否 */
  available: boolean;
  /** 是否判定为违规（命中阈值） */
  blocked: boolean;
  /** 命中的最高违规类别 */
  topCategory: NsfwCategory | null;
  /** 各类别概率，按高到低 */
  scores: Array<{ className: NsfwCategory; probability: number }>;
  /** 不可用 / 失败时的原因，便于排查 */
  reason?: string;
}

/** 自建模型目录（可选）；不设置时用包内置 MobileNetV2 */
const MODEL_DIR = process.env.NSFW_MODEL_DIR || '';
/** 命中即拒绝的类别 */
const BLOCK_CATEGORIES: ReadonlySet<NsfwCategory> = new Set(['Porn', 'Hentai']);
/** 概率阈值：Porn/Hentai 超过它即判定违规 */
const BLOCK_THRESHOLD = Number(process.env.NSFW_THRESHOLD ?? 0.6);
/** nsfwjs 的输入边长（MobileNetV2 为 224） */
const INPUT_SIZE = 224;

type NsfwModel = { classify: (input: unknown) => Promise<Array<{ className: string; probability: number }>> };

interface Loaded {
  tf: typeof import('@tensorflow/tfjs');
  model: NsfwModel;
}

let loading: Promise<Loaded | null> | null = null;
let cached: Loaded | null = null;
let lastError = '';

/** 检查自建模型目录是否可用；未配置则视为使用内置模型 */
function customModelPath(): string | null {
  if (!MODEL_DIR) return null;
  const json = path.join(MODEL_DIR, 'model.json');
  if (!fs.existsSync(json)) {
    lastError = `NSFW_MODEL_DIR 已设置但缺少 model.json：${json}`;
    logger.warn(lastError);
    return null;
  }
  const shards = fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.bin'));
  if (!shards.length) {
    lastError = `自建模型缺少权重分片（.bin）：${MODEL_DIR}`;
    logger.warn(lastError);
    return null;
  }
  return json;
}

async function loadModel(): Promise<Loaded | null> {
  try {
    const tf = await import('@tensorflow/tfjs');
    const nsfw = await import('nsfwjs');
    // 生产模式：关掉 tfjs 的调试检查，推理更快
    tf.enableProdMode();

    const custom = customModelPath();
    const t0 = Date.now();
    /**
     * 不传参数 = 用包内置的 MobileNetV2（权重已随 nsfwjs 打包）。
     * 之前误以为要单独下载模型而传了 URL，结果 CDN 失效导致加载失败。
     */
    const model = (custom
      ? await nsfw.load(`file://${custom}`, { type: 'graph' })
      : await nsfw.load()) as unknown as NsfwModel;

    logger.info(`NSFW 模型已就绪（${custom ? '自建' : '内置 MobileNetV2'}，${Date.now() - t0}ms）`);
    return { tf, model };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    logger.warn(`NSFW 模型加载失败，图片内容检测将跳过：${lastError}`);
    return null;
  }
}

/** 懒加载单例；失败后不反复重试，避免每次上传都等一次超时 */
async function ensureLoaded(): Promise<Loaded | null> {
  if (cached) return cached;
  if (!loading) {
    loading = loadModel().then((r) => { cached = r; return r; });
  }
  return loading;
}

/** 供健康检查 / 诊断用 */
export function nsfwStatus(): {
  available: boolean; source: string; reason: string; threshold: number;
} {
  return {
    available: Boolean(cached),
    source: MODEL_DIR ? `自建：${MODEL_DIR}` : '内置 MobileNetV2',
    reason: cached ? '' : (lastError || '模型尚未加载（首次上传时自动加载）'),
    threshold: BLOCK_THRESHOLD,
  };
}

/**
 * 判定一张图片。
 *
 * sharp 负责解码：纯 JS 版 tfjs 没有 `tf.node` 解码器，
 * 必须先把 JPEG/PNG/WebP 解成 RGB 像素，再用 `tf.tensor3d` 交给模型。
 * sharp 自带预编译二进制，Alpine 上无需 node-gyp。
 */
export async function classifyImage(buffer: Buffer): Promise<NsfwVerdict> {
  const loaded = await ensureLoaded();
  if (!loaded) {
    return {
      available: false, blocked: false, topCategory: null, scores: [],
      reason: lastError || '模型未加载',
    };
  }
  try {
    // 缩到模型输入尺寸；cover 裁切保证比例不变形
    const { data } = await sharp(buffer)
      .removeAlpha()
      .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { tf } = loaded;
    /**
     * data 是 Uint8Array（每像素 3 字节）。
     * `Int32Array` 的构造参数是**元素个数**，不是字节数，
     * 直接传 `data.buffer` 会把缓冲区按 4 字节一组重新解释（长度变成 1/4）。
     * 这里显式逐字节搬运，避免踩这个坑。
     */
    const values = new Int32Array(INPUT_SIZE * INPUT_SIZE * 3);
    for (let i = 0; i < values.length; i += 1) values[i] = data[i]!;
    const tensor = tf.tensor3d(values, [INPUT_SIZE, INPUT_SIZE, 3], 'int32');
    let raw: Array<{ className: string; probability: number }>;
    try {
      raw = await loaded.model.classify(tensor);
    } finally {
      // 必须显式释放：tfjs 的 tensor 不受 GC 管理
      tensor.dispose();
    }

    const scores = raw
      .map((r) => ({ className: r.className as NsfwCategory, probability: r.probability }))
      .sort((a, b) => b.probability - a.probability);
    const hit = scores.find((s) => BLOCK_CATEGORIES.has(s.className) && s.probability >= BLOCK_THRESHOLD);
    return {
      available: true,
      blocked: Boolean(hit),
      topCategory: hit?.className ?? scores[0]?.className ?? null,
      scores,
    };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    logger.warn(`NSFW 判定失败，本次跳过：${lastError}`);
    return { available: false, blocked: false, topCategory: null, scores: [], reason: lastError };
  }
}
