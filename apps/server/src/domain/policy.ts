/**
 * 纯业务规则层（无 DB 依赖，模块 6 可直接做单元验证）。
 * 所有金额单位为「分」的整数；时间入参一律带时区 ISO 或 UTC DATETIME 字面值。
 */
import {
  BIZ_CODES,
  FREE_CANCEL_BEFORE_HOURS,
  satisfiesLevel,
  satisfiesVisibility,
  type BalanceTxnDirection,
  type EventVisibility,
  type MemberLevel,
} from '@photo/shared';

/** 账本内部操作 → 流水方向。SETTLE 与 DEBIT 都记为 OUT，但动的是不同余额桶。 */
export type LedgerOp = 'FREEZE' | 'SETTLE' | 'UNFREEZE' | 'CREDIT' | 'DEBIT';
const DIRECTION_OF: Readonly<Record<LedgerOp, BalanceTxnDirection>> = {
  FREEZE: 'FREEZE',
  SETTLE: 'OUT',
  UNFREEZE: 'UNFREEZE',
  CREDIT: 'IN',
  DEBIT: 'OUT',
};

export interface BalanceState {
  availableCent: number;
  frozenCent: number;
  direction: BalanceTxnDirection;
}

/** 余额不足或金额非法时返回 null；调用方据此在事务内抛错，绝不产生负余额 */
export function computeBalanceAfter(
  op: LedgerOp,
  amountCent: number,
  availableCent: number,
  frozenCent: number,
): BalanceState | null {
  if (!Number.isSafeInteger(amountCent) || amountCent <= 0) return null;
  const direction = DIRECTION_OF[op];
  switch (op) {
    case 'FREEZE':
      if (availableCent < amountCent) return null;
      return { availableCent: availableCent - amountCent, frozenCent: frozenCent + amountCent, direction };
    case 'SETTLE':
      if (frozenCent < amountCent) return null;
      return { availableCent, frozenCent: frozenCent - amountCent, direction };
    case 'UNFREEZE':
      if (frozenCent < amountCent) return null;
      return { availableCent: availableCent + amountCent, frozenCent: frozenCent - amountCent, direction };
    case 'CREDIT':
      return { availableCent: availableCent + amountCent, frozenCent, direction };
    case 'DEBIT':
      if (availableCent < amountCent) return null;
      return { availableCent: availableCent - amountCent, frozenCent, direction };
  }
}

function parseUtc(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export interface RegisterableEvent {
  status: string;
  visibility: EventVisibility;
  /** 人工分批报名门槛（点2）：此刻允许报名的最低等级；缺省 NONE 表示不设门槛 */
  registerMinLevel?: MemberLevel;
  registrationOpenAt: string;
  registrationCloseAt: string;
}

export interface RegisterableSession {
  status: string;
  startAt: string;
  endAt: string;
  capacity: number;
  capacityUsed: number;
}

export interface RegistrationDecision {
  ok: boolean;
  reasonCode: number | null;
}

export interface RegistrationInput {
  event: RegisterableEvent;
  session: RegisterableSession;
  level: MemberLevel;
  priceCent: number;
  /** 单席折后价（用券后）；缺省等于 priceCent。批量总价校验仍由调用方完成 */
  payableCent?: number;
  /** 仅 VIP/SVIP 有余额；非会员走线下支付，不做余额校验 */
  hasBalance: boolean;
  availableCent: number;
  now?: Date;
}

/** 校验链顺序固定：活动状态/时间窗 → 可见性 → 人工报名门槛 → 余额（仅会员）→ 时段容量 */
export function decideRegistration(input: RegistrationInput): RegistrationDecision {
  const { event, session, level, priceCent, hasBalance, availableCent } = input;
  const t = (input.now ?? new Date()).getTime();
  if (
    event.status !== 'REGISTRATION_OPEN' ||
    session.status !== 'OPEN' ||
    t < parseUtc(event.registrationOpenAt) ||
    t >= parseUtc(event.registrationCloseAt) ||
    t >= parseUtc(session.startAt)
  ) {
    return { ok: false, reasonCode: BIZ_CODES.EVENT_NOT_OPEN };
  }
  if (!satisfiesVisibility(level, event.visibility)) {
    return { ok: false, reasonCode: BIZ_CODES.LEVEL_INSUFFICIENT };
  }
  // 点2：人工分批报名。看得到（过可见性）不代表此刻报得了——运营手动从 SVIP→VIP→NONE 放开
  if (!satisfiesLevel(level, event.registerMinLevel ?? 'NONE')) {
    return { ok: false, reasonCode: BIZ_CODES.REGISTRATION_LEVEL_GATE };
  }
  if (hasBalance && availableCent < (input.payableCent ?? priceCent)) {
    return { ok: false, reasonCode: BIZ_CODES.BALANCE_INSUFFICIENT };
  }
  if (session.capacityUsed >= session.capacity) {
    // 候补已下线：满员即拒绝。容量并发一致性由调用方的条件 UPDATE 兜底。
    return { ok: false, reasonCode: BIZ_CODES.EVENT_FULL };
  }
  return { ok: true, reasonCode: null };
}

/**
 * 按等级取价：SVIP 无专属价时回退 VIP 价，再回退公开价。
 * 会员价缺失不应导致报名失败，否则运营漏配一档就没人能报名。
 */
export function pickPrice(
  prices: ReadonlyArray<{ level: string; priceCent: number }>,
  level: MemberLevel,
): number {
  const find = (lv: string) => prices.find((p) => p.level === lv)?.priceCent;
  if (level === 'SVIP') return find('SVIP') ?? find('VIP') ?? find('PUBLIC') ?? 0;
  if (level === 'VIP') return find('VIP') ?? find('PUBLIC') ?? 0;
  return find('PUBLIC') ?? 0;
}

export function canCancel(
  freeCancelBeforeHours: number = FREE_CANCEL_BEFORE_HOURS,
  startAt: string,
  now: Date = new Date(),
): boolean {
  return parseUtc(startAt) - now.getTime() >= freeCancelBeforeHours * 3_600_000;
}

export function refundAmountOf(feeCent: number, feeRatio: number): number {
  if (feeRatio <= 0 || feeRatio >= 1) return Math.max(0, feeCent - Math.round(feeCent * feeRatio));
  return Math.max(0, Math.round(feeCent * (1 - feeRatio)));
}

export function voteWindowOpen(openAt: string, closeAt: string, now: Date = new Date()): boolean {
  const t = now.getTime();
  return t >= parseUtc(openAt) && t < parseUtc(closeAt);
}
