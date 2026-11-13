-- ============================================================================
-- 017 赠送积分（赠金）
--
-- 背景：充值常伴赠送。用户决策（2026-11-11）采用「单一积分 + 赠送标记」轻量模型：
--   · 不新增可消费余额桶，赠送积分与本金一起进 available_cent，永久有效；
--   · 赠送单独记一条 biz_type='BONUS' 的入账流水，「累计赠送」由 BONUS IN 流水求和派生；
--   · 扣减顺序 / 退款路由不变（单一余额），对账 reconcileAccount 无需改动（BONUS IN 天然计入）。
--
-- 变更：
--   1) balance_transactions.biz_type 末尾追加 'BONUS'（ENUM 末尾追加为 INSTANT，不锁表）；
--   2) balance_adjustments 增加 bonus_cent，记录每次调账随充值发放的赠送积分（分）。
--
-- 回滚思路（务必先平账，再删结构，否则账实不符）：
--   ⚠️ BONUS 流水已计入 available_cent，且可能已被报名消费。直接删流水会造成账户虚高。
--   步骤：
--     a. 先对账：逐账户核对 SUM(BONUS IN) 是否仍留存于 available_cent；
--        若赠送已被消费，需人工确认差额处理（不得使 available_cent 变负）。
--     b. 按确认后的金额扣回账户：
--        UPDATE balance_accounts a
--          JOIN (SELECT account_user_id, SUM(amount_cent) b
--                  FROM balance_transactions
--                 WHERE biz_type='BONUS' AND direction='IN'
--                 GROUP BY account_user_id) x ON x.account_user_id=a.user_id
--           SET a.available_cent = a.available_cent - x.b, a.version = a.version + 1;
--     c. DELETE FROM balance_transactions WHERE biz_type='BONUS';
--     d. ALTER TABLE balance_adjustments DROP COLUMN bonus_cent;
--     e. ALTER TABLE balance_transactions
--          MODIFY biz_type ENUM('REGISTRATION','REFUND','MANUAL_ADJUST') NOT NULL;
--        （ENUM 收缩要求库中已无 'BONUS' 行，故必须先执行 c。）
-- ============================================================================

ALTER TABLE balance_transactions
  MODIFY biz_type ENUM('REGISTRATION','REFUND','MANUAL_ADJUST','BONUS') NOT NULL;

ALTER TABLE balance_adjustments
  ADD COLUMN bonus_cent BIGINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT '赠送积分（分），随充值发放，单独记 BONUS 流水' AFTER amount_cent;