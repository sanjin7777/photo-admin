-- ============================================================================
-- 008：邀请码注册 + 用户表记录邀请码来源
--
-- 背景（2026-11-10 用户决策）：
--   前台注册必须填写向管理员获取的邀请码，一个邀请码只能使用一次；
--   邀请码需要同时保存到 users 表，便于追踪「新用户由哪个邀请码创建」。
--   source / parent_user_id / reward_cent 为后期「用户端生成邀请码 + 奖励」预留，
--   本期不实现相关端点。
--
-- 依赖：001 ~ 007。由 schema_migrations 保证只执行一次。
-- ============================================================================

CREATE TABLE IF NOT EXISTS invite_codes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(16)   NOT NULL COMMENT '剔除易混淆字符的随机码',
  status          ENUM('UNUSED','USED','REVOKED') NOT NULL DEFAULT 'UNUSED',
  created_by      BIGINT UNSIGNED NOT NULL COMMENT '生成人（管理员）',
  used_by         BIGINT UNSIGNED NULL,
  used_at         DATETIME(3)   NULL,
  expires_at      DATETIME(3)   NULL COMMENT 'NULL = 长期有效',
  note            VARCHAR(200)  NULL,
  source          ENUM('ADMIN','USER') NOT NULL DEFAULT 'ADMIN' COMMENT '预留：用户端生成',
  parent_user_id  BIGINT UNSIGNED NULL COMMENT '预留：邀请奖励归属',
  reward_cent     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '预留：邀请奖励金额',
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_code (code),
  KEY idx_status (status, expires_at),
  KEY idx_creator (created_by),
  KEY idx_used_by (used_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='注册邀请码，一码一次性';

-- 用户表冗余保存邀请码 ID（双向可查：users.invite_code_id / invite_codes.used_by）
-- 管理员代注册（/admin/users）与 Excel 批量导入均为 NULL
ALTER TABLE users
  ADD COLUMN invite_code_id BIGINT UNSIGNED NULL COMMENT '注册所用邀请码；管理员代注册/导入为 NULL' AFTER email,
  ADD KEY idx_invite_code (invite_code_id);
