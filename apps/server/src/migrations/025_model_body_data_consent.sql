-- ============================================================================
-- 025：模特身高/三围的「单独同意」留痕
--
-- 背景：身高、三围属《个人信息保护法》第 28 条的敏感个人信息。
-- 第 29 条要求取得**单独同意**，第 17 条要求告知处理目的与必要性。
-- 原表只有 portrait_auth_status（肖像授权），没有针对身体数据的同意凭证。
--
-- 变更：新增两列，只记录「何时、以何方式取得同意」，不改动既有数据。
-- 回滚：
--   ALTER TABLE model_profiles DROP COLUMN body_data_consent_note;
--   ALTER TABLE model_profiles DROP COLUMN body_data_consent_at;
-- ============================================================================

SET @db := DATABASE();

-- 同意时间
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = @db AND table_name = 'model_profiles' AND column_name = 'body_data_consent_at'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE model_profiles ADD COLUMN body_data_consent_at DATETIME(3) NULL COMMENT ''身高/三围单独同意时间；NULL 表示未取得同意''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 同意方式备注
SET @has_col2 := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = @db AND table_name = 'model_profiles' AND column_name = 'body_data_consent_note'
);
SET @sql2 := IF(@has_col2 = 0,
  'ALTER TABLE model_profiles ADD COLUMN body_data_consent_note VARCHAR(200) NULL COMMENT ''同意方式留痕：口头/书面/线上''',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- 校验：两列都应存在
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.columns
 WHERE table_schema = @db AND table_name = 'model_profiles'
   AND COLUMN_NAME IN ('body_data_consent_at', 'body_data_consent_note');
