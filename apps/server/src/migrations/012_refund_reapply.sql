-- ============================================================================
-- 012 退款被拒后允许重新申请
--
-- 背景：refund_orders.registration_id 原为 UNIQUE，退款被驳回后报名恢复 CONFIRMED，
-- 用户再次取消会插入新的退款单，直接撞唯一键报 500。改为普通索引保留查询能力。
--
-- 回滚思路（需先保证每个报名只剩一条退款单）：
--   DELETE r1 FROM refund_orders r1 JOIN refund_orders r2
--     ON r1.registration_id = r2.registration_id AND r1.id < r2.id;
--   ALTER TABLE refund_orders DROP INDEX idx_registration,
--     ADD UNIQUE KEY uk_registration (registration_id);
-- ============================================================================
ALTER TABLE refund_orders
  DROP INDEX uk_registration,
  ADD KEY idx_registration (registration_id);
