-- ============================================================================
-- 021 场景增加「所属场地」（点4 扩展）
--
-- 背景（2026-11-12 用户决策）：原「场景管理」每条都带地址，实际更像「场地管理」。
--   用户希望区分两级：一个「场地」下挂多个「场景」（如 A厅 / 自然光棚 / 家居景）。
--   采用轻量方案——不单独建场地表/页面，只在 scenes 上加一个 venue 字段，按场地名分组。
--
-- 设计：
--   1. scenes 增加 venue（所属场地名），NOT NULL DEFAULT '默认场地'；
--      地址 address 仍留在场景上（属场地信息，同场地多个场景会重复录入，由运营保持一致）。
--   2. 旧数据迁移：用户选择「归入一个默认场地」——NOT NULL DEFAULT 让存量行自动落到 '默认场地'，
--      原 name/address/照片/容量全部保留，旧场次的 venue/scene/venue_urls 快照不受影响。
--   3. 加 idx_venue 便于按场地分组/排序；不加外键（venue 只是分组名，非独立实体）。
--
-- 回滚思路：
--   ALTER TABLE scenes DROP KEY idx_venue;     -- 先摘索引
--   ALTER TABLE scenes DROP COLUMN venue;      -- 再删字段
--   回滚后场景库回到「每条自带地址」的单级形态，name/address/照片/容量与历史快照均不丢；
--   仅「所属场地」分组信息随字段丢失。
-- ============================================================================

ALTER TABLE scenes
  ADD COLUMN venue VARCHAR(80) NOT NULL DEFAULT '默认场地'
    COMMENT '所属场地（一个场地多个场景，按此名分组）' AFTER id;

ALTER TABLE scenes ADD KEY idx_venue (venue);