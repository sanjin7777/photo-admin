-- ============================================================================
-- 013 投票活动不再强制关联场次
--
-- 背景：原 vote_campaigns.event_id 为 NOT NULL，后台新建投票必须先填场次 ID，
-- 无法创建与具体场次无关的投票（如通用服装方案征集）。改为允许 NULL。
--
-- 回滚思路（需先处理已有 NULL 数据，二选一）：
--   -- 方案 A：把独立投票挂到某个占位场次
--   UPDATE vote_campaigns SET event_id = <现有场次ID> WHERE event_id IS NULL;
--   -- 方案 B：删除独立投票（会级联删掉选项与投票记录，先备份）
--   DELETE FROM vote_campaigns WHERE event_id IS NULL;
--   ALTER TABLE vote_campaigns MODIFY COLUMN event_id BIGINT UNSIGNED NOT NULL;
-- ============================================================================
ALTER TABLE vote_campaigns
  MODIFY COLUMN event_id BIGINT UNSIGNED NULL;
