-- ============================================================================
-- 022 投票活动直接关联模特（第九轮 点C）
--
-- 背景（2026-11-12 用户决策）：服装投票页此前不展示模特信息——后台新建投票没有
--   模特字段，投票只能靠 event_id 间接带出场次模特，独立投票（event_id 为 NULL）
--   前台永远看不到模特。用户选择「直接选模特」：投票活动新增 model_id，后台新建/
--   修改投票时下拉选一位模特，前台投票页展示该模特资料（身高/三围仍按会员 gating）。
--
-- 设计：
--   1. vote_campaigns 增加 model_id（BIGINT UNSIGNED NULL），与 event_id 一样可空、
--      只加普通索引 idx_model，不加外键（model_profiles 走软删除 deleted_at，
--      DTO 组装时按 deleted_at IS NULL 过滤，模特被删则前台自动隐藏入口）。
--   2. 存量行 model_id 自动为 NULL，旧投票不受影响；event_id 关联保持不变。
--
-- 回滚思路：
--   ALTER TABLE vote_campaigns DROP KEY idx_model;     -- 先摘索引
--   ALTER TABLE vote_campaigns DROP COLUMN model_id;   -- 再删字段
--   回滚后投票回到「仅靠 event_id 间接带模特」的形态，选项/投票记录/票数均不丢；
--   仅「直接关联的模特」信息随字段丢失。
-- ============================================================================

ALTER TABLE vote_campaigns
  ADD COLUMN model_id BIGINT UNSIGNED NULL
    COMMENT '直接关联的模特（点C）；可空，软删除模特由 DTO 过滤' AFTER event_id;

ALTER TABLE vote_campaigns ADD KEY idx_model (model_id);