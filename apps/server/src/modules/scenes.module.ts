/**
 * 场景库（点4）：可复用拍摄场地档案的后台 CRUD。
 * 新增场次时下拉选择场景，自动带出 venue/scene/venueUrls 快照；场次仍保留自由文本可改。
 * 读接口同样要求 admin:scene:write —— 场景库纯属后台运营资料，与场次管理同一批角色。
 */
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  pageQuerySchema,
  sceneUpsertSchema,
  type SceneUpsertPayload,
} from '@photo/shared';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { pageArgsOf, paginatedOf, sceneDtoOf } from '../domain/dto';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

/** 下拉选项一次最多带出的场景数，防止极端数据量拖垮场次表单 */
const OPTIONS_LIMIT = 200;

export function mountScenes(app: Express): void {
  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:scene:write'));

  /** 管理列表：分页，按创建倒序 */
  admin.get('/', validateQuery(pageQuerySchema), asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = pageArgsOf(req.query as { page?: number; pageSize?: number });
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM scenes WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?',
      [pageSize, offset],
    );
    const [counts] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM scenes WHERE deleted_at IS NULL',
    );
    sendOk(res, paginatedOf(rows.map(sceneDtoOf), Number(counts[0]?.total ?? 0), page, pageSize));
  }));

  /** 场次表单下拉：一次带出全部在用场景（含场地/照片/简介，供自动填充），按场地+场景名排序便于分组 */
  admin.get('/options', asyncHandler(async (_req, res) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM scenes WHERE deleted_at IS NULL ORDER BY venue ASC, name ASC, id ASC LIMIT ?',
      [OPTIONS_LIMIT],
    );
    sendOk(res, rows.map(sceneDtoOf));
  }));

  admin.get('/:id', asyncHandler(async (req, res) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL LIMIT 1', [req.params.id],
    );
    if (!rows[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    sendOk(res, sceneDtoOf(rows[0]));
  }));

  admin.post('/', validateBody(sceneUpsertSchema), asyncHandler(async (req, res) => {
    const b = req.body as SceneUpsertPayload;
    const now = toSqlDateTime();
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO scenes (venue, name, address, description, photo_urls, capacity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.venue, b.name, b.address ?? null, b.description ?? null,
        JSON.stringify(b.photoUrls ?? []), b.capacity ?? null, now, now],
    );
    const id = String(result.insertId);
    await auditOf(res)?.({ action: 'SCENE_UPSERT', targetType: 'scene', targetId: id });
    sendOk(res, { id }, 201);
  }));

  admin.patch('/:id', validateBody(sceneUpsertSchema.partial()), asyncHandler(async (req, res) => {
    const b = req.body as Partial<SceneUpsertPayload>;
    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM scenes WHERE id = ? AND deleted_at IS NULL LIMIT 1', [req.params.id],
    );
    if (!existing[0]) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    await pool.execute(
      `UPDATE scenes SET
         venue = COALESCE(?, venue),
         name = COALESCE(?, name),
         address = COALESCE(?, address),
         description = COALESCE(?, description),
         photo_urls = COALESCE(?, photo_urls),
         capacity = COALESCE(?, capacity),
         updated_at = ?
       WHERE id = ?`,
      [b.venue ?? null, b.name ?? null, b.address ?? null, b.description ?? null,
        b.photoUrls ? JSON.stringify(b.photoUrls) : null,
        b.capacity ?? null, toSqlDateTime(), req.params.id],
    );
    await auditOf(res)?.({ action: 'SCENE_UPSERT', targetType: 'scene', targetId: req.params.id });
    sendOk(res, { id: req.params.id });
  }));

  /** 软删除：已引用该场景的场次保留自己的快照，不受影响 */
  admin.delete('/:id', asyncHandler(async (req, res) => {
    const [result] = await pool.execute<ResultSetHeader>(
      'UPDATE scenes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
      [toSqlDateTime(), req.params.id],
    );
    if (result.affectedRows !== 1) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
    await auditOf(res)?.({ action: 'SCENE_DELETE', targetType: 'scene', targetId: req.params.id });
    sendOk(res, { id: req.params.id });
  }));

  app.use(`${API_BASE_PATH}/admin/scenes`, admin);
}