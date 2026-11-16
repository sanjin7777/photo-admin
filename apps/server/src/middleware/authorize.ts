/**
 * 第二、三层校验：capability → 资源归属/可见性。
 *
 * 三层固定顺序：authenticate → requireCapabilities → requireSelfOrCapability。
 * 列表接口必须在 SQL 层用 visibilityFilter 注入过滤，
 * 详情接口必须独立判权，避免「前端隐藏但 ID 可枚举」。
 */
import type { NextFunction, Request, Response } from 'express';
import {
  AppError,
  BIZ_CODES,
  canAll,
  canAny,
  EVENT_VISIBILITIES,
  satisfiesVisibility,
  type Capability,
  type MemberLevel,
} from '@photo/shared';
import type { Identity } from '../db/identity';
import { getIdentity } from './context';

/** 纯函数，便于无 DB 的单元测试 */
export function hasRequiredCapabilities(
  identity: Identity | null,
  required: readonly Capability[],
): boolean {
  if (!identity) return false;
  return canAll(identity.capabilities, required);
}

export function requireCapabilities(
  ...required: Capability[]
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, _res, next) => {
    const identity = getIdentity();
    if (!identity) {
      next(new AppError(BIZ_CODES.UNAUTHORIZED));
      return;
    }
    if (!hasRequiredCapabilities(identity, required)) {
      next(new AppError(BIZ_CODES.FORBIDDEN));
      return;
    }
    next();
  };
}

/**
 * 任一能力即可（OR 语义）。
 *
 * 用于「多岗位共用同一个只读接口」：例如选人下拉 /admin/registrations/users，
 * 运营用它录入报名、财务用它发起调账、管理员用它发券，三者权限位不同，
 * 但都只需要「读到已注册用户的最小字段」，不必为每个岗位再开一个端点。
 */
export function requireAnyCapability(
  ...required: Capability[]
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, _res, next) => {
    const identity = getIdentity();
    if (!identity) {
      next(new AppError(BIZ_CODES.UNAUTHORIZED));
      return;
    }
    if (!canAny(identity.capabilities, required)) {
      next(new AppError(BIZ_CODES.FORBIDDEN));
      return;
    }
    next();
  };
}

/** 资源归属：本人可操作，或具备指定后台能力（运营代客操作） */
export function requireSelfOrCapability(
  capability: Capability,
  ownerIdOf: (req: Request) => string | null | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const identity = getIdentity();
    if (!identity) {
      next(new AppError(BIZ_CODES.UNAUTHORIZED));
      return;
    }
    const ownerId = ownerIdOf(req);
    if (ownerId && ownerId === identity.userId) {
      next();
      return;
    }
    if (hasRequiredCapabilities(identity, [capability])) {
      next();
      return;
    }
    next(new AppError(BIZ_CODES.RESOURCE_NOT_OWNED));
  };
}

/** 列表 SQL 片段：只返回当前等级可见的场次，参数化避免拼接注入 */
export function visibilityFilter(level: MemberLevel): { clause: string; params: string[] } {
  const allowed = EVENT_VISIBILITIES.filter((v) => satisfiesVisibility(level, v));
  return {
    clause: `visibility IN (${allowed.map(() => '?').join(', ')})`,
    params: [...allowed],
  };
}
