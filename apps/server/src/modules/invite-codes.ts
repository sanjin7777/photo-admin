/**
 * 注册邀请码（后台）：批量生成 / 列表 / 作废。
 *
 * 规则：
 * - 一个邀请码只能使用一次，消费逻辑在 auth/service.ts 的注册事务里（FOR UPDATE + 条件 UPDATE）；
 * - 管理员代注册（/admin/users）与 Excel 导入不走这里，也不消耗邀请码；
 * - 生成的明文只在创建响应里返回一次，后续列表从库里读；
 * - source / parent_user_id / reward_cent 已为「用户端生成 + 邀请奖励」预留，本期不实现。
 */
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  inviteCodeCreateSchema,
  inviteCodeListQuerySchema,
  type InviteCodeCreatePayload,
  type InviteCodeCreateResultDto,
  type InviteCodeDto,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody, validateQuery } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { pageArgsOf, paginatedOf } from '../domain/dto';
import { fromSqlDateTime, toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

/** Crockford 风格字母表：剔除 I / O / 0 / 1，避免人工抄录歧义 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

const isoOf = (value: unknown): string | null =>
  value ? fromSqlDateTime(String(value)).toISOString() : null;

export function mountInviteCodes(app: Express): void {
  const router = Router();
  router.use(authenticate);

  /** 批量生成：事务内一次性写入，极少数 uk_code 碰撞自动重试 */
  router.post(
    '/',
    requireCapabilities('admin:invite:write'),
    validateBody(inviteCodeCreateSchema),
    asyncHandler(async (req, res) => {
      const payload = req.body as InviteCodeCreatePayload;
      const actorId = getIdentity()?.userId;
      if (!actorId) throw new AppError(BIZ_CODES.UNAUTHORIZED);
      const expiresAt = payload.expiresAt ? toSqlDateTime(new Date(payload.expiresAt)) : null;

      const codes = await withTransaction(async (conn) => {
        const created: string[] = [];
        for (let i = 0; i < payload.count; i += 1) {
          let code = newCode();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await conn.execute(
                `INSERT INTO invite_codes (code, created_by, expires_at, note, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NOW(3), NOW(3))`,
                [code, actorId, expiresAt, payload.note ?? null],
              );
              break;
            } catch (error: unknown) {
              if ((error as { code?: string }).code !== 'ER_DUP_ENTRY' || attempt === 2) throw error;
              code = newCode();
            }
          }
          created.push(code);
        }
        return created;
      });

      await auditOf(res)?.({
        action: 'INVITE_CODE_CREATE', targetType: 'invite_code', targetId: String(payload.count),
      });
      const result: InviteCodeCreateResultDto = {
        codes,
        count: codes.length,
        expiresAt: payload.expiresAt ?? null,
      };
      sendOk(res, result, 201);
    }),
  );

  /** 列表：状态 / 码 / 生成人 / 使用人均可筛选；total 用真实 COUNT，不用 rows.length */
  router.get(
    '/',
    requireCapabilities('admin:invite:read'),
    validateQuery(inviteCodeListQuerySchema),
    asyncHandler(async (req, res) => {
      const { page, pageSize, offset } = pageArgsOf(
        req.query as { page?: number; pageSize?: number },
      );
      const q = req.query as { status?: 'UNUSED' | 'USED' | 'REVOKED'; keyword?: string };
      const where: string[] = ['1 = 1'];
      const params: Array<string | number> = [];
      if (q.status) {
        where.push('ic.status = ?');
        params.push(q.status);
      }
      if (q.keyword) {
        where.push('(ic.code LIKE ? OR creator.wechat_id LIKE ? OR used.wechat_id LIKE ?)');
        params.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
      }
      const fromSql = `
        FROM invite_codes ic
        LEFT JOIN users creator ON creator.id = ic.created_by
        LEFT JOIN users used ON used.id = ic.used_by`;
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ic.*, creator.wechat_id AS creator_wechat_id, used.wechat_id AS used_wechat_id
         ${fromSql} ${whereSql}
         ORDER BY ic.id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      );
      const [counts] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`,
        params,
      );
      const list: InviteCodeDto[] = rows.map((r) => ({
        id: String(r.id),
        code: String(r.code),
        status: r.status as InviteCodeDto['status'],
        createdByWechatId: r.creator_wechat_id == null ? null : String(r.creator_wechat_id),
        usedByWechatId: r.used_wechat_id == null ? null : String(r.used_wechat_id),
        usedAt: isoOf(r.used_at),
        expiresAt: isoOf(r.expires_at),
        note: r.note == null ? null : String(r.note),
        createdAt: isoOf(r.created_at) ?? new Date().toISOString(),
      }));
      sendOk(res, paginatedOf(list, Number(counts[0]?.total ?? 0), page, pageSize));
    }),
  );

  /** 作废：只有未使用的码可作废，已使用记录必须保留以便追溯 */
  router.post(
    '/:id/revoke',
    requireCapabilities('admin:invite:write'),
    asyncHandler(async (req, res) => {
      const [result] = await pool.execute<ResultSetHeader>(
        "UPDATE invite_codes SET status = 'REVOKED' WHERE id = ? AND status = 'UNUSED'",
        [req.params.id],
      );
      if (result.affectedRows !== 1) {
        throw new AppError(BIZ_CODES.INVALID_PARAM, '仅未使用的邀请码可以作废');
      }
      await auditOf(res)?.({
        action: 'INVITE_CODE_REVOKE', targetType: 'invite_code', targetId: req.params.id,
      });
      sendOk(res, { id: req.params.id });
    }),
  );

  app.use(`${API_BASE_PATH}/admin/invite-codes`, router);
}
