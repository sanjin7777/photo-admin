/**
 * 全局异常出口：任何抛出的 AppError / ZodError / 未捕获异常都转成统一响应包。
 * 不在错误响应里回传堆栈（生产），只在日志里记录。
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, BIZ_CODES, type ApiResponse } from '@photo/shared';
import { getTraceId } from './context';
import { logger } from '../utils/logger';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(BIZ_CODES.RESOURCE_NOT_FOUND, `接口不存在: ${req.method} ${req.path}`));
}

function isBodyParseError(error: unknown): boolean {
  return (error as { type?: string } | null)?.type === 'entity.parse.failed';
}

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = new AppError(BIZ_CODES.SCHEMA_VALIDATION_FAILED, '表单校验未通过', error.flatten());
  } else if (isBodyParseError(error)) {
    appError = new AppError(BIZ_CODES.INVALID_PARAM, '请求体不是合法 JSON');
  } else {
    logger.error('未捕获异常', { error: error instanceof Error ? error.stack : String(error) });
    appError = new AppError(BIZ_CODES.INTERNAL_ERROR);
  }

  if (appError.httpStatus >= 500) {
    logger.error('请求失败', { code: appError.code, message: appError.message });
  }

  if (res.headersSent) return;
  const body: ApiResponse<null> = {
    code: appError.code,
    message: appError.message,
    data: null,
    traceId: getTraceId(),
  };
  res.status(appError.httpStatus).json(body);
}
