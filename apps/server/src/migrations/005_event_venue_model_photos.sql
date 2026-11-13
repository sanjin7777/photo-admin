-- ============================================================================
-- 005：详情页三块图区所需字段
--
-- 场地照片：场次维度（同一场地不同场次可能拍不同区域）
-- 模特照片：模特档案维度（可多张，替代原来只有一张 portfolio_url）
-- ============================================================================

ALTER TABLE events
  ADD COLUMN venue_urls JSON DEFAULT NULL COMMENT '场地照片数组，详情页"场地"图区';

ALTER TABLE model_profiles
  ADD COLUMN photo_urls JSON DEFAULT NULL COMMENT '模特照片数组，详情页"模特"图区';
