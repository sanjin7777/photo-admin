-- ============================================================================
-- 030：每位模特各自一张「本场照片」
--
-- 背景：双模特场次里，两位模特需要各自选一张本场使用的照片
-- （封面/海报主图/详情页图区都按模特分别展示）。
-- 原来只有 events.poster_urls，一场只有一张模特图，第二位模特只能被动取档案首图。
--
-- 设计取舍：
--   · 与 029 的 wardrobe_urls 同粒度，都挂在 event_models 上（场次 × 模特）；
--   · events.poster_urls / cover_url 保留不动，作为**列表封面与历史数据兜底**；
--   · 纯增量，历史场次回退到 events.poster_urls，表现与升级前一致。
--
-- 回滚：
--   ALTER TABLE event_models DROP COLUMN photo_urls;
-- ============================================================================

ALTER TABLE event_models
  ADD COLUMN photo_urls JSON NULL
    COMMENT '该模特在本场次使用的照片（数组，通常 1 张）；NULL 或空时回退 events.poster_urls / 档案首图'
    AFTER wardrobe_urls;

SELECT COUNT(*) AS event_models_rows FROM event_models;
