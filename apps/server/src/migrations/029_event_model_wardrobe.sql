-- ============================================================================
-- 029：每位模特各自一套「当日服装」图
--
-- 背景：双模特（或多模特）场次里，两位模特穿的衣服完全不同，
-- 原来 events.wardrobe_urls 只能存一组图，无法表达「A 穿这套、B 穿那套」，
-- 后台也只能给整场传一组服装图。
--
-- 设计取舍：
--   · 服装图挂在 event_models 上 —— 它天然是「场次 × 模特」的组合，
--     同一位模特在不同场次可以穿不同服装，正好是这个粒度的语义；
--   · events.wardrobe_urls 保留不动，作为**单模特场次与历史数据的兜底**，
--     列表页、前台详情、海报在没有按模特的服装图时回退到它；
--   · 纯增量：只加列，不改不删既有数据。历史场次回落到 events.wardrobe_urls，
--     表现与升级前完全一致。
--
-- 回滚：
--   ALTER TABLE event_models DROP COLUMN wardrobe_urls;
-- ============================================================================

ALTER TABLE event_models
  ADD COLUMN wardrobe_urls JSON NULL
    COMMENT '该模特在本场次的当日服装图（数组）；NULL 或空数组时回退 events.wardrobe_urls'
    AFTER sort_no;

SELECT COUNT(*) AS event_models_rows FROM event_models;
