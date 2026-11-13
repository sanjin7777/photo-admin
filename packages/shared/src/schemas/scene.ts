/**
 * 场景库（点4）：可复用拍摄场地档案的写入校验。
 * 一个「场地 venue」下可挂多个「场景 name」（如 A厅 / 自然光棚）；地址属于场地，按场景重复录入。
 * 新增场次时下拉选择场景，自动带出场地名/场景名/照片与信息；场次仍保留自己的 venue/scene/venueUrls 快照。
 */
import { z } from 'zod';

export const sceneUpsertSchema = z
  .object({
    /** 所属场地（一个场地多个场景，按此名分组） */
    venue: z.string().trim().min(1, '所属场地必填').max(80),
    name: z.string().trim().min(1, '场景名称必填').max(80),
    address: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** 场地照片（多图），由上传组件写入同源 URL */
    photoUrls: z.array(z.string().trim().max(512)).max(9).default([]),
    /** 容纳人数（可空） */
    capacity: z.number().int().min(1, '容纳人数至少 1').max(1000).nullable().optional(),
  })
  .strict();
export type SceneUpsertPayload = z.infer<typeof sceneUpsertSchema>;