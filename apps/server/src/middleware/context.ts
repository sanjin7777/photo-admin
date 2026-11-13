/** 请求上下文：AsyncLocalStorage 透传 traceId / 身份，避免把可变状态挂到全局 req。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { TRACE_ID_HEADER } from '@photo/shared';
import type { Identity } from '../db/identity';

export interface RequestContext {
  traceId: string;
  ip: string;
  ua: string;
  identity: Identity | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getTraceId(): string {
  return storage.getStore()?.traceId ?? 'no-trace';
}

export function getIdentity(): Identity | null {
  return storage.getStore()?.identity ?? null;
}

/** 仅 authenticate 成功后调用 */
export function setIdentity(identity: Identity): void {
  const store = storage.getStore();
  if (store) store.identity = identity;
}

export function contextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(TRACE_ID_HEADER);
  const traceId = incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader(TRACE_ID_HEADER, traceId);
  const ctx: RequestContext = {
    traceId,
    ip: req.ip ?? '',
    ua: req.header('user-agent') ?? '',
    identity: null,
  };
  storage.run(ctx, () => next());
}
