/**
 * 服务端二次校验：直接复用 @photo/shared/schemas 的 Zod schema。
 * 校验通过后用 parsed.data 覆盖原始入参，业务层拿到的永远是已净化的数据。
 * ⚠️ 前端校验只做提示，本中间件才是安全边界。
 */
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError, BIZ_CODES } from '@photo/shared';

type AnySchema = z.ZodTypeAny;

/** 原始请求体的挂载点：Zod 的 .default() 会抹平「缺省」与「显式传默认值」的差异 */
const RAW_BODY = Symbol('rawBody');

function parseOrThrow(schema: AnySchema, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(BIZ_CODES.SCHEMA_VALIDATION_FAILED, '表单校验未通过', result.error.flatten());
  }
  return result.data;
}

/**
 * 读取「校验前」的原始请求体。
 *
 * 用于区分「字段没传」与「显式传了默认值」——例如 eventPatchSchema 上
 * allowProxyShoot 带 `.default(false)`，partial() 之后缺省时仍会注入 false，
 * 业务层若只看 parsed.data 就会把「没改」误判成「主动关闭」。
 */
export function rawBodyOf(req: Request): Record<string, unknown> {
  const raw = (req as unknown as Record<symbol, unknown>)[RAW_BODY];
  return (raw ?? {}) as Record<string, unknown>;
}

export function validateBody(schema: AnySchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      // 先留存原始体，再覆盖：顺序不能反，否则拿到的就是已注入默认值的版本
      (req as unknown as Record<symbol, unknown>)[RAW_BODY] = req.body;
      req.body = parseOrThrow(schema, req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateQuery(schema: AnySchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      (req as unknown as { query: unknown }).query = parseOrThrow(schema, req.query);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateParams(schema: AnySchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      (req as unknown as { params: unknown }).params = parseOrThrow(schema, req.params);
      next();
    } catch (error) {
      next(error);
    }
  };
}
