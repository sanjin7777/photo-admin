/**
 * 服务端二次校验：直接复用 @photo/shared/schemas 的 Zod schema。
 * 校验通过后用 parsed.data 覆盖原始入参，业务层拿到的永远是已净化的数据。
 * ⚠️ 前端校验只做提示，本中间件才是安全边界。
 */
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError, BIZ_CODES } from '@photo/shared';

type AnySchema = z.ZodTypeAny;

function parseOrThrow(schema: AnySchema, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(BIZ_CODES.SCHEMA_VALIDATION_FAILED, '表单校验未通过', result.error.flatten());
  }
  return result.data;
}

export function validateBody(schema: AnySchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
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
