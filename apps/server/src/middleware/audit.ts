/**
 * 审计切面：append-only 写入 audit_logs。
 * 登录/登出在 auth 路由显式记录；后台写操作由模块 3 通过 `auditOf(res)` 调用。
 * 审计写入失败只告警不阻断业务（避免日志表故障拖垮主流程），上线可改为阻断策略。
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuditAction } from '@photo/shared';
import { pool } from '../db/pool';
import { toSqlDateTime } from '../utils/datetime';
import { logger } from '../utils/logger';
import { getContext } from './context';

export interface AuditInput {
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string | null;
}

export type AuditFn = (input: AuditInput) => Promise<void>;

export async function recordAudit(input: AuditInput): Promise<void> {
  const ctx = getContext();
  try {
    await pool.execute(
      `INSERT INTO audit_logs
        (actor_id, action, target_type, target_id, before_json, after_json, ip, ua, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.actorId ?? ctx?.identity?.userId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
        ctx?.ip ?? null,
        ctx?.ua ?? null,
        ctx?.traceId ?? 'no-trace',
        toSqlDateTime(),
      ],
    );
  } catch (error: unknown) {
    logger.error('审计日志写入失败', { error: String(error), action: input.action });
  }
}

export function auditContextMiddleware(_req: Request, res: Response, next: NextFunction): void {
  (res.locals as { audit?: AuditFn }).audit = (input) => recordAudit(input);
  next();
}

export function auditOf(res: Response): AuditFn | undefined {
  return (res.locals as { audit?: AuditFn }).audit;
}
