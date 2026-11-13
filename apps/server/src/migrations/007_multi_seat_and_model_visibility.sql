-- ============================================================================
-- 007：支持「一次报名多个名额」+ 移除模特 visibility 列
--
-- 背景（2026-11-10 用户决策）：
--   1. 一个账号可能需要连场报名、包场、带朋友（同一场次两个名额）；
--      实现方式为「一次请求生成 N 条独立报名记录，每条 = 1 个名额」，
--      每条仍可单独取消 / 退款 / 签到。
--   2. 模特档案的 visibility 在界面上早已移除，DDL 保留会造成
--      「前端不传、后端每次编辑写回 PUBLIC」的隐性行为，直接删列。
--      注意：events.visibility（场次按会员等级可见）是核心业务字段，不动。
--
-- 依赖：001 ~ 006。ALTER 本身不幂等，由 schema_migrations 保证只执行一次。
-- ============================================================================

-- 1) 报名：去掉「一人一场一条」的唯一约束，改为普通索引
ALTER TABLE registrations DROP INDEX uk_event_user;
ALTER TABLE registrations ADD KEY idx_event_user (event_id, user_id, status);

-- 2) 一次请求会写入 N 条报名，它们共享同一个幂等键；
--    幂等由 idempotency_keys 表保证，registrations 里的列仅作留痕，不再唯一
ALTER TABLE registrations DROP INDEX uk_reg_idempotency_key;
ALTER TABLE registrations ADD KEY idx_reg_idempotency_key (idempotency_key);

-- 3) 同理，一次批量报名可能产生 N 条余额流水，共享同一个幂等键；
--    uk_biz_direction(biz_type, biz_id, direction) 仍是真正的业务幂等兜底
ALTER TABLE balance_transactions DROP INDEX uk_txn_idempotency_key;
ALTER TABLE balance_transactions ADD KEY idx_txn_idempotency_key (idempotency_key);

-- 4) 模特档案去掉可见性（events.visibility 不受影响）
ALTER TABLE model_profiles DROP INDEX idx_visibility;
ALTER TABLE model_profiles DROP COLUMN visibility;
