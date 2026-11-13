-- ============================================================================
-- 016 用户协议 / 隐私政策同意留痕
--
-- 背景：网站需可举证用户已同意协议与隐私政策；注册勾选与存量用户补勾都写这里。
-- 规则：同一用户 × 同一协议 × 同一版本只保留首次同意时间（重复提交不覆盖）。
-- 回滚：DROP TABLE IF EXISTS user_consents;
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_consents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  agreement_type ENUM('TERMS','PRIVACY') NOT NULL,
  version        VARCHAR(20) NOT NULL,
  agreed_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip             VARCHAR(64) NULL,
  ua             VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_type_version (user_id, agreement_type, version),
  KEY idx_user_agreed (user_id, agreed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='协议同意留痕（append-only）';
