-- ============================================================================
-- 003：模特社交账号
--
-- 模特对外展示需要抖音 / 小红书 / B 站等主页，用一列 JSON 存数组，
-- 避免每加一个平台就改一次表；结构调整频率远低于数据写入。
-- 形状：[{"platform":"DOUYIN","handle":"catpaw","url":"https://..."}]
-- ============================================================================

ALTER TABLE model_profiles
  ADD COLUMN social_accounts JSON DEFAULT NULL
  COMMENT '社交账号数组：platform/handle/url；仅展示用，不参与权限判定';
