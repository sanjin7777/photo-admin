-- ============================================================================
-- 004：模特档案独立建档（不再强制绑定登录账号）
--
-- 背景：很多模特只是挂名出镜，不需要注册前台账号；原来 model_profiles 以
-- user_id 作主键，导致必须先有用户才能建档案。
--
-- 改动：
--   1. 新增自增主键 id，作为模特档案的唯一标识；
--   2. user_id 改为可空（NULL 表示纯资料模特），保留唯一约束防止一个用户建两份；
--   3. events.model_id 的语义从「用户 ID」改为「模特档案 ID」，按 user_id 重映射。
-- ============================================================================

-- 1) 先加一列可空的 id，用旧主键(user_id)填充，保证不重不漏
ALTER TABLE model_profiles ADD COLUMN id BIGINT UNSIGNED NULL FIRST;
UPDATE model_profiles SET id = user_id WHERE id IS NULL;

-- 2) 换主键。分两句执行：MySQL 不允许 auto_increment 列在无键状态下定义
ALTER TABLE model_profiles DROP PRIMARY KEY;
ALTER TABLE model_profiles
  MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (id);

-- 3) user_id 放开为可空，并加唯一索引（多个 NULL 允许）
ALTER TABLE model_profiles
  MODIFY COLUMN user_id BIGINT UNSIGNED NULL COMMENT '绑定的登录用户；纯资料模特为 NULL',
  ADD UNIQUE KEY uk_user_id (user_id);

-- 4) 场次的 model_id 重映射到新的档案 id
UPDATE events e
  JOIN model_profiles m ON m.user_id = e.model_id
   SET e.model_id = m.id
 WHERE e.model_id IS NOT NULL;
