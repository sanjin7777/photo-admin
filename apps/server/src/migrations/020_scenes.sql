-- ============================================================================
-- 020 场景库（点4）
--
-- 背景（2026-11-12 用户决策）：拍摄场地可复用，运营希望先录入场地照片与信息，
--   新增场次时**下拉选择场景**自动带出，同时**保留自由文本**可再改。
--
-- 设计：
--   1. 新建 scenes 表存放可复用场地档案（名称/地址/简介/多图/容纳人数）；
--   2. events 增加 scene_id 引用所选场景（可空）。
--   ⚠️ 场次仍保留自己的 venue / scene / venue_urls 快照：选场景只是「带出默认值」，
--      带出后运营可自由改，改完存的是场次自己的快照。这样：
--        · 老场次 scene_id=NULL，完全不受影响；
--        · 日后改场景库不会追溯改动已发布场次的场地展示（快照隔离）。
--   3. 不加外键约束，与 events.model_id 一致（仅普通索引），避免迁移顺序/删除耦合。
--
-- 回滚思路：
--   ALTER TABLE events DROP COLUMN scene_id;   -- 先摘引用（无外键，顺序不敏感）
--   DROP TABLE IF EXISTS scenes;               -- 再删场景库
--   删除后场次场地展示回退为各自的 venue/scene/venue_urls 快照，历史数据不丢；
--   仅「场景库档案」本身随表丢失，如需留档可先备份 scenes 表再删。
-- ============================================================================

CREATE TABLE IF NOT EXISTS scenes (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(80) NOT NULL COMMENT '场景名称',
  address      VARCHAR(200) DEFAULT NULL COMMENT '场地地址',
  description  TEXT COMMENT '场地简介/拍摄须知',
  photo_urls   JSON DEFAULT NULL COMMENT '场地照片数组',
  capacity     INT UNSIGNED DEFAULT NULL COMMENT '容纳人数（可空）',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at   DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='可复用拍摄场地档案；场次下拉选择后带出快照';

ALTER TABLE events
  ADD COLUMN scene_id BIGINT UNSIGNED DEFAULT NULL
    COMMENT '关联场景库（点4）；仅引用，场地展示仍用本场次自己的 venue/scene/venue_urls 快照' AFTER model_id;

ALTER TABLE events ADD KEY idx_scene (scene_id);