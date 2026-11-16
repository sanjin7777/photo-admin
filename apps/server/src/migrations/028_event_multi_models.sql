-- ============================================================================
-- 028：场次支持多模特（双模特及以上）
--
-- 背景：一场活动可能同时有两位模特参与。原设计 events.model_id 只能挂一个。
--
-- 设计取舍：**不删旧列，只增加关联表**
--   · events.model_id 保留为「主模特」，所有既有逻辑（前台展示、投票关联、
--     海报、模特照片库）继续可用，历史数据零迁移；
--   · event_models 记录**全部**模特（含主模特），作为权威列表；
--   · 主模特始终是 event_models 中的一员，读取时以关联表为准，
--     model_id 仅作向后兼容的冗余字段。
--
-- 回滚：
--   DROP TABLE IF EXISTS event_models;
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_models (
  event_id BIGINT UNSIGNED NOT NULL,
  model_id BIGINT UNSIGNED NOT NULL,
  sort_no INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '展示顺序；0 通常是主模特',
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (event_id, model_id),
  KEY idx_model (model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='场次参与的模特（多对多）；主模特同时出现在 events.model_id';

-- 回填历史数据：每个已有 model_id 的场次写一行
INSERT IGNORE INTO event_models (event_id, model_id, sort_no, created_at)
SELECT id, model_id, 0, NOW(3)
  FROM events
 WHERE model_id IS NOT NULL;

SELECT COUNT(*) AS event_models_rows FROM event_models;
