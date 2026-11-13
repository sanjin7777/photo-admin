-- ============================================================================
-- 摄影会报名与会员权限系统 · 初始 Schema（对应方案 §4，V1）
--
-- 约定：
--  * InnoDB / utf8mb4_unicode_ci；主键 BIGINT UNSIGNED，API 侧以字符串传输。
--  * 金额一律 BIGINT UNSIGNED 存「分」，禁止 FLOAT/DOUBLE。
--  * 时间 DATETIME(3) 存 UTC；应用侧写入 UTC 字面值（见 utils/datetime.ts），
--    docker-compose 已设置 --default-time-zone=+00:00。
--  * 不建物理外键：由应用层事务 + 索引保证引用完整性，便于软删与数据归档。
--  * 状态值由 @photo/shared/enums.ts 的迁移表约束；新增状态需同步迁移 + 枚举。
--  * append-only 表（balance_transactions / audit_logs / permission_logs）
--    仅允许 INSERT；上线时通过数据库账号回收 UPDATE/DELETE 权限（见文末）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 用户与角色
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nickname            VARCHAR(64)  NOT NULL,
  phone               VARCHAR(20)  DEFAULT NULL,
  email               VARCHAR(128) DEFAULT NULL,
  password_hash       VARCHAR(255) NOT NULL COMMENT 'bcrypt，生产可换 argon2id',
  avatar_url          VARCHAR(512) DEFAULT NULL,
  status              ENUM('ACTIVE','FROZEN') NOT NULL DEFAULT 'ACTIVE',
  session_version     INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '权限变更时 +1，使旧 access token 立即失效',
  login_failed_count  INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME(3) DEFAULT NULL,
  last_login_at       DATETIME(3) DEFAULT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at          DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_phone (phone),
  UNIQUE KEY uk_email (email),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号主体；phone/email 仅做格式与唯一校验，不代表实名认证';

CREATE TABLE IF NOT EXISTS admin_roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('MODEL','OPERATOR','FINANCE','ADMIN','SUPER_ADMIN') NOT NULL,
  scope       VARCHAR(64) DEFAULT NULL COMMENT '预留：多分会/多城市数据范围',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_role (user_id, role),
  KEY idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台身份，与会员等级正交';

CREATE TABLE IF NOT EXISTS memberships (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  level         ENUM('VIP','SVIP') NOT NULL,
  status        ENUM('ACTIVE','EXPIRED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  start_at      DATETIME(3) NOT NULL,
  expire_at     DATETIME(3) NOT NULL,
  source        ENUM('GRANT','RENEWAL') NOT NULL DEFAULT 'GRANT' COMMENT 'V1 为后台授予，不接在线支付',
  granted_by    BIGINT UNSIGNED DEFAULT NULL,
  grant_reason  VARCHAR(200) DEFAULT NULL,
  revoked_by    BIGINT UNSIGNED DEFAULT NULL,
  revoked_at    DATETIME(3) DEFAULT NULL,
  -- 生成列：仅 ACTIVE 记录参与唯一约束，保证同一用户同一等级同时最多一条有效记录
  active_flag   TINYINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_level_active (user_id, level, active_flag),
  KEY idx_user_expire (user_id, status, expire_at),
  KEY idx_expire (status, expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会员有效期；资格一律按 now 实时判定';

-- ---------------------------------------------------------------------------
-- 模特资料（隐私敏感）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_profiles (
  user_id                 BIGINT UNSIGNED NOT NULL,
  stage_name              VARCHAR(64) NOT NULL,
  height_cm               SMALLINT UNSIGNED DEFAULT NULL,
  measurements_json       JSON,
  portfolio_url           VARCHAR(512) DEFAULT NULL,
  contact_phone_cipher    VARBINARY(512) DEFAULT NULL COMMENT '加密存储；公开 DTO 不含此列',
  portrait_auth_status    ENUM('PENDING','GRANTED','EXPIRED','REVOKED') NOT NULL DEFAULT 'PENDING',
  portrait_auth_expire_at DATETIME(3) DEFAULT NULL COMMENT '肖像授权期限，仅记录凭证，需线下授权书配套',
  visibility              ENUM('PUBLIC','VIP','SVIP') NOT NULL DEFAULT 'PUBLIC',
  created_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at              DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (user_id),
  KEY idx_visibility (visibility)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='肖像授权与联系方式为高风险字段，展示需脱敏';

-- ---------------------------------------------------------------------------
-- 余额账本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS balance_accounts (
  user_id         BIGINT UNSIGNED NOT NULL,
  available_cent  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  frozen_cent     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  version         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '乐观锁：条件更新 WHERE version = ? AND available_cent >= ?',
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='物化余额，需定期按流水重算对账';

CREATE TABLE IF NOT EXISTS balance_transactions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_user_id     BIGINT UNSIGNED NOT NULL,
  direction           ENUM('IN','OUT','FREEZE','UNFREEZE') NOT NULL,
  amount_cent         BIGINT UNSIGNED NOT NULL COMMENT '恒为正数，方向由 direction 表达',
  balance_after_cent  BIGINT UNSIGNED NOT NULL COMMENT '变更后可用余额，用于对账',
  biz_type            ENUM('REGISTRATION','REFUND','MANUAL_ADJUST') NOT NULL,
  biz_id              VARCHAR(64) NOT NULL,
  origin_txn_id       BIGINT UNSIGNED DEFAULT NULL COMMENT '退款关联原扣费流水',
  idempotency_key     CHAR(36) DEFAULT NULL,
  operator_id         BIGINT UNSIGNED DEFAULT NULL,
  remark              VARCHAR(200) DEFAULT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_txn_idempotency_key (idempotency_key),
  UNIQUE KEY uk_biz_direction (biz_type, biz_id, direction),
  KEY idx_account_created (account_user_id, created_at),
  KEY idx_origin (origin_txn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='APPEND-ONLY 不可变流水，仅 INSERT';

CREATE TABLE IF NOT EXISTS balance_adjustments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  amount_cent      BIGINT NOT NULL COMMENT '可正可负，但不得为 0',
  reason           VARCHAR(200) NOT NULL,
  evidence_url     VARCHAR(512) DEFAULT NULL COMMENT '线下收款凭证',
  status           ENUM('REQUESTED','APPROVED','REJECTED','APPLIED') NOT NULL DEFAULT 'REQUESTED',
  requested_by     BIGINT UNSIGNED NOT NULL,
  reviewed_by      BIGINT UNSIGNED DEFAULT NULL COMMENT '入账操作人（一步调账与发起人相同）',
  reviewed_at      DATETIME(3) DEFAULT NULL,
  review_remark    VARCHAR(200) DEFAULT NULL,
  balance_txn_id   BIGINT UNSIGNED DEFAULT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_status_created (status, created_at),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='人工调账提交即入账（走账本），禁止直接改余额';

-- ---------------------------------------------------------------------------
-- 场次 / 报名 / 退款
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title                  VARCHAR(80) NOT NULL,
  description            TEXT,
  cover_url              VARCHAR(512) DEFAULT NULL,
  venue                  VARCHAR(200) NOT NULL,
  model_id               BIGINT UNSIGNED DEFAULT NULL,
  registration_open_at   DATETIME(3) NOT NULL,
  registration_close_at  DATETIME(3) NOT NULL,
  start_at               DATETIME(3) NOT NULL,
  end_at                 DATETIME(3) NOT NULL,
  visibility             ENUM('PUBLIC','VIP','SVIP') NOT NULL DEFAULT 'PUBLIC',
  fee_cent               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  capacity               INT UNSIGNED NOT NULL,
  capacity_used          INT UNSIGNED NOT NULL DEFAULT 0,
  allow_waitlist         TINYINT(1) NOT NULL DEFAULT 1,
  refund_policy          JSON NOT NULL COMMENT 'freeCancelBeforeHours / feeRatio',
  status                 ENUM('DRAFT','PUBLISHED','REGISTRATION_OPEN','REGISTRATION_CLOSED','ONGOING','FINISHED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  version                INT UNSIGNED NOT NULL DEFAULT 0,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at             DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_status_open (status, registration_open_at),
  KEY idx_visibility (visibility),
  KEY idx_model (model_id),
  CONSTRAINT chk_capacity CHECK (capacity_used <= capacity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='列表查询必须叠加 visibility 过滤';

CREATE TABLE IF NOT EXISTS registrations (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id               BIGINT UNSIGNED NOT NULL,
  user_id                BIGINT UNSIGNED NOT NULL,
  status                 ENUM('WAITLISTED','OFFERED','EXPIRED','CONFIRMED','REFUND_PENDING','REFUNDED','CHECKED_IN','COMPLETED','CANCELLED') NOT NULL,
  wait_seq               INT UNSIGNED DEFAULT NULL COMMENT '候补队列序号，事务内加锁生成',
  offer_expire_at        DATETIME(3) DEFAULT NULL COMMENT '递补确认截止时间，默认 30 分钟',
  fee_cent               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  refund_policy_snapshot JSON NOT NULL COMMENT '报名时固化，避免规则事后变更引发争议',
  balance_txn_id         BIGINT UNSIGNED DEFAULT NULL,
  idempotency_key        CHAR(36) DEFAULT NULL,
  cancel_reason          VARCHAR(200) DEFAULT NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_event_user (event_id, user_id),
  UNIQUE KEY uk_reg_idempotency_key (idempotency_key),
  KEY idx_queue (event_id, status, wait_seq),
  KEY idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='V1 假设：一场一人一条记录，取消不删除；如需「取消后可重报」需调整 uk_event_user';

CREATE TABLE IF NOT EXISTS refund_orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  registration_id BIGINT UNSIGNED NOT NULL,
  amount_cent     BIGINT UNSIGNED NOT NULL,
  reason          VARCHAR(200) DEFAULT NULL,
  status          ENUM('REQUESTED','APPROVED','REFUNDING','REFUNDED','REJECTED') NOT NULL DEFAULT 'REQUESTED',
  requested_by    BIGINT UNSIGNED NOT NULL,
  reviewed_by     BIGINT UNSIGNED DEFAULT NULL,
  reviewed_at     DATETIME(3) DEFAULT NULL,
  review_remark   VARCHAR(200) DEFAULT NULL,
  balance_txn_id  BIGINT UNSIGNED DEFAULT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_registration (registration_id),
  KEY idx_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='REFUNDING 与余额回充在同一事务内完成';

-- ---------------------------------------------------------------------------
-- 服装投票
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vote_campaigns (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id             BIGINT UNSIGNED NOT NULL,
  title                VARCHAR(80) NOT NULL,
  open_at              DATETIME(3) NOT NULL,
  close_at             DATETIME(3) NOT NULL,
  status               ENUM('DRAFT','OPEN','CLOSED','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  max_votes_per_user   INT UNSIGNED NOT NULL DEFAULT 1,
  result_published_at  DATETIME(3) DEFAULT NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_event (event_id),
  KEY idx_status_time (status, open_at, close_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提交时服务端重查 SVIP 有效性';

CREATE TABLE IF NOT EXISTS vote_options (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id  BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(60) NOT NULL,
  image_url    VARCHAR(512) DEFAULT NULL,
  sort_no      INT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_campaign_sort (campaign_id, sort_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS votes (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id   BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  option_id     BIGINT UNSIGNED NOT NULL,
  vote_version  INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '改票覆盖 + 版本递增 + 审计，不新增行',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_campaign_user (campaign_id, user_id),
  KEY idx_option (option_id),
  KEY idx_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='半匿名：user_id 仅用于去重与审计，结果接口只出聚合数';

-- ---------------------------------------------------------------------------
-- 审计 / 会话 / 幂等 / 通知
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id     BIGINT UNSIGNED DEFAULT NULL,
  action       VARCHAR(48) NOT NULL COMMENT '对应 shared AUDIT_ACTIONS',
  target_type  VARCHAR(48) NOT NULL,
  target_id    VARCHAR(64) DEFAULT NULL,
  before_json  JSON,
  after_json   JSON,
  ip           VARCHAR(64) DEFAULT NULL,
  ua           VARCHAR(512) DEFAULT NULL,
  trace_id     VARCHAR(64) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_created (created_at),
  KEY idx_actor (actor_id, created_at),
  KEY idx_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='APPEND-ONLY；留存 180 天，导出需脱敏';

CREATE TABLE IF NOT EXISTS permission_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id        BIGINT UNSIGNED DEFAULT NULL,
  action          VARCHAR(48) NOT NULL COMMENT 'MEMBERSHIP_GRANT / MEMBERSHIP_REVOKE',
  target_user_id  BIGINT UNSIGNED NOT NULL,
  level           ENUM('VIP','SVIP') NOT NULL,
  level_before    ENUM('NONE','VIP','SVIP') DEFAULT NULL,
  level_after     ENUM('NONE','VIP','SVIP') DEFAULT NULL,
  reason          VARCHAR(200) DEFAULT NULL,
  trace_id        VARCHAR(64) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_target_created (target_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='APPEND-ONLY 权限变更日志';

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  token_hash       CHAR(64) NOT NULL COMMENT '只存 SHA-256 哈希，不存明文',
  family_id        CHAR(36) NOT NULL COMMENT '同族轮换；重放时整族撤销',
  status           ENUM('ACTIVE','ROTATED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  expires_at       DATETIME(3) NOT NULL,
  session_version  INT UNSIGNED NOT NULL,
  rotated_at       DATETIME(3) DEFAULT NULL,
  ip               VARCHAR(64) DEFAULT NULL,
  ua               VARCHAR(512) DEFAULT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_family (family_id),
  KEY idx_user_status (user_id, status),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idem_key      CHAR(36) NOT NULL,
  scope         VARCHAR(64) NOT NULL,
  request_hash  CHAR(64) NOT NULL COMMENT 'method + path + body 的 SHA-256',
  status        ENUM('IN_PROGRESS','COMPLETED','FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
  response_json JSON COMMENT '已完成请求的响应回放',
  expires_at    DATETIME(3) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (idem_key),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='模块 3 在业务事务内抢占/完成，去重窗口 24h';

CREATE TABLE IF NOT EXISTS notifications (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  type          VARCHAR(48) NOT NULL,
  title         VARCHAR(120) NOT NULL,
  content       TEXT,
  payload_json  JSON,
  is_read       TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_read (user_id, is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='V1 仅站内信，开发期 Mock，不接短信/邮件通道';

-- ---------------------------------------------------------------------------
-- 上线前建议（此处注释，不执行，避免开发账号权限不足报错）：
-- REVOKE UPDATE, DELETE ON photo_club.balance_transactions FROM 'photo'@'%';
-- REVOKE UPDATE, DELETE ON photo_club.audit_logs          FROM 'photo'@'%';
-- REVOKE UPDATE, DELETE ON photo_club.permission_logs     FROM 'photo'@'%';
-- 另需配置 audit_logs / permission_logs 的 180 天归档任务（模块 6）。
-- ============================================================================
