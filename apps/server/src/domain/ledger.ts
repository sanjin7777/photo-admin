/**
 * 余额账本写入（必须在 withTransaction 的连接上调用，与业务写入同一事务）。
 *
 * 风控要点：
 *  * SELECT ... FOR UPDATE 锁账户行 + version 条件更新双保险；金额非零安全整数；
 *  * 流水 append-only：只 INSERT，balance_after_cent 记录变更后可用余额；
 *  * 唯一键 (biz_type, biz_id, direction) 兜底重复入账；
 *  * 禁止任何业务代码直接 UPDATE balance_accounts。
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AppError, BIZ_CODES, type BalanceBizType } from '@photo/shared';
import { computeBalanceAfter, type LedgerOp } from './policy';
import { toSqlDateTime } from '../utils/datetime';

interface AccountRow extends RowDataPacket {
  available_cent: string;
  frozen_cent: string;
  version: number;
}

export interface LedgerEntry {
  userId: string;
  op: LedgerOp;
  amountCent: number;
  bizType: BalanceBizType;
  bizId: string;
  originTxnId?: string | null;
  idempotencyKey?: string | null;
  operatorId?: string | null;
  remark?: string | null;
}

export interface LedgerResult {
  txnId: string;
  availableCent: number;
  frozenCent: number;
  direction: string;
}

export async function applyLedgerEntry(
  conn: PoolConnection,
  entry: LedgerEntry,
): Promise<LedgerResult> {
  const [rows] = await conn.execute<AccountRow[]>(
    'SELECT available_cent, frozen_cent, version FROM balance_accounts WHERE user_id = ? FOR UPDATE',
    [entry.userId],
  );
  const account = rows[0];
  if (!account) throw new AppError(BIZ_CODES.INTERNAL_ERROR, '积分账户不存在');

  const available = Number(account.available_cent);
  const frozen = Number(account.frozen_cent);
  const after = computeBalanceAfter(entry.op, entry.amountCent, available, frozen);
  if (!after) throw new AppError(BIZ_CODES.BALANCE_INSUFFICIENT);

  const [updated] = await conn.execute<ResultSetHeader>(
    'UPDATE balance_accounts SET available_cent = ?, frozen_cent = ?, version = version + 1 WHERE user_id = ? AND version = ?',
    [after.availableCent, after.frozenCent, entry.userId, account.version],
  );
  if (updated.affectedRows !== 1) throw new AppError(BIZ_CODES.CONCURRENCY_CONFLICT);

  const [result] = await conn.execute<ResultSetHeader>(
    `INSERT INTO balance_transactions
      (account_user_id, direction, amount_cent, balance_after_cent, biz_type, biz_id,
       origin_txn_id, idempotency_key, operator_id, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      after.direction,
      entry.amountCent,
      after.availableCent,
      entry.bizType,
      entry.bizId,
      entry.originTxnId ?? null,
      entry.idempotencyKey ?? null,
      entry.operatorId ?? null,
      entry.remark ?? null,
      toSqlDateTime(),
    ],
  );
  return {
    txnId: String(result.insertId),
    availableCent: after.availableCent,
    frozenCent: after.frozenCent,
    direction: after.direction,
  };
}

/*
 * 对账（流水聚合 vs 账户物化值）此前是一个没人调用的导出函数，2026-11 清理死代码时删掉了实现，
 * 但把口径留在这里：日常核对直接在 MySQL 上跑下面这条，diff 非 0 说明有绕过 applyLedgerEntry 的写入口。
 *
 *   SELECT a.user_id, a.available_cent,
 *          COALESCE(SUM(CASE WHEN t.direction IN ('IN','UNFREEZE') THEN t.amount_cent
 *                            WHEN t.direction IN ('FREEZE','OUT')     THEN -t.amount_cent END), 0) AS ledger_available,
 *          a.available_cent - COALESCE(SUM(...), 0) AS diff
 *     FROM balance_accounts a
 *     LEFT JOIN balance_transactions t ON t.account_user_id = a.user_id
 *    GROUP BY a.user_id, a.available_cent
 *   HAVING diff <> 0;
 *
 * 之所以不放进接口：全表聚合在流水上百万行时会拖慢数据库，对账属于低频运维动作，不该占用线上请求线程。
 */
