-- ============================================================================
-- 014 系统设置（键值表）
--
-- 目前只承载「场次海报右下角的固定报名二维码」：
--   poster_qr_url -> /uploads/... 同源路径或 http(s) 绝对地址，NULL 表示未配置。
-- 键值表便于后续再放公告、客服微信等运营配置，避免每加一项就改表结构。
-- 回滚：DROP TABLE IF EXISTS app_settings;（二维码配置随表丢失，无法恢复）
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key    VARCHAR(64) NOT NULL,
  setting_value  TEXT NULL,
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统级键值配置';

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('poster_qr_url', NULL);
