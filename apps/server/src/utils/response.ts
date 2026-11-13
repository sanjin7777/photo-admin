/** 统一响应出口：所有成功响应走 sendOk，错误由 errorMiddleware 统一包装。 */
import type { Response } from 'express';
import { successResponse, AppError, BIZ_CODES, type ApiResponse } from '@photo/shared';
import { getTraceId } from '../middleware/context';

export function sendOk<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json(successResponse(data, getTraceId()));
}

export function errorBody(code: number, message?: string): ApiResponse<null> {
  const err = new AppError(code, message);
  return { code: err.code, message: err.message, data: null, traceId: getTraceId() };
}

export function isSuccessBody(body: unknown): body is ApiResponse<unknown> {
  return (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    (body as ApiResponse<unknown>).code === BIZ_CODES.OK
  );
}
