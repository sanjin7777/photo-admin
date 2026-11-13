/** 场次海报配置（后台）：网站二维码 + 客服二维码地址 + 左上角标题。 */
import { z } from 'zod';

/** 允许站内 /uploads 路径或 http(s) 绝对地址；拒绝 // 开头与其它协议 */
const qrImageUrlSchema = z
  .string()
  .trim()
  .max(512, '二维码地址不超过 512 字符')
  .refine(
    (v) => (v.startsWith('/') ? !v.startsWith('//') : /^https?:\/\//i.test(v)),
    '二维码地址必须是 http(s) 链接或以 / 开头的站内路径',
  );

/** null 或空串表示清除已配置的二维码 */
const qrUrlField = z.union([qrImageUrlSchema, z.literal(''), z.null()]).transform((v) => (v ? v : null));

/** 海报左上角标题：留空 / null 表示使用海报内置默认标题 */
const brandTitleField = z
  .string()
  .trim()
  .max(32, '海报标题不超过 32 个字符')
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || v.length >= 2, '海报标题至少 2 个字符');

export const posterSettingsUpdateSchema = z
  .object({
    /** 客服二维码：印在海报上，同时展示在前台报名页 */
    qrUrl: qrUrlField,
    /** 网站二维码：可选，未配置时海报回退使用内置默认图 */
    siteQrUrl: qrUrlField.optional(),
    /** 海报左上角标题：留空使用内置默认标题 */
    brandTitle: brandTitleField.optional(),
  })
  .strict();
export type PosterSettingsUpdatePayload = z.infer<typeof posterSettingsUpdateSchema>;
