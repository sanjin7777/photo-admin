-- ============================================================================
-- 002：微信号账号、活动多时段、分档价格、报名支付状态
-- 依赖 001_init.sql。ALTER 不幂等，由 schema_migrations 保证只执行一次。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 账号标识改为微信号（手机号保留为可选联系方式，不再参与登录）
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN wechat_id VARCHAR(64) NULL AFTER nickname;
UPDATE users SET wechat_id = CONCAT('legacy_', id) WHERE wechat_id IS NULL;
ALTER TABLE users MODIFY COLUMN wechat_id VARCHAR(64) NOT NULL COMMENT '微信号，登录唯一标识';
ALTER TABLE users ADD UNIQUE KEY uk_wechat_id (wechat_id);

-- ---------------------------------------------------------------------------
-- 活动扩展字段（支撑海报上的主题/场景/海报图/当日服装/须知/人数比/代拍/包场）
-- ---------------------------------------------------------------------------
ALTER TABLE events
  ADD COLUMN subtitle VARCHAR(120) NULL AFTER title,
  ADD COLUMN scene VARCHAR(64) NULL AFTER venue,
  ADD COLUMN poster_urls JSON NULL COMMENT '宣传海报多图',
  ADD COLUMN wardrobe_urls JSON NULL COMMENT '当日服装图',
  ADD COLUMN notice TEXT NULL COMMENT '报名须知（含迟到/取消/退款规则）',
  ADD COLUMN ratio_label VARCHAR(16) NULL COMMENT '人数比文案，如 4V1',
  ADD COLUMN model_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN allow_proxy_shoot TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否可代拍',
  ADD COLUMN private_booking_note VARCHAR(200) NULL COMMENT '单人包场说明';

-- ---------------------------------------------------------------------------
-- 活动时段：一场活动可有多个时段（第一场 / 第二场 / 第三场）
-- 容量与报名时间均以时段为准
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id       BIGINT UNSIGNED NOT NULL,
  label          VARCHAR(32) NOT NULL COMMENT '第一场 / 19:00-20:00',
  start_at       DATETIME(3) NOT NULL,
  end_at         DATETIME(3) NOT NULL,
  capacity       INT UNSIGNED NOT NULL,
  capacity_used  INT UNSIGNED NOT NULL DEFAULT 0,
  status         ENUM('OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  sort_no        INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_event_sort (event_id, sort_no),
  CONSTRAINT chk_session_capacity CHECK (capacity_used <= capacity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='时段级容量与时间，报名按此时段占用';

-- ---------------------------------------------------------------------------
-- 分档价格：公开价 / VIP 价 / SVIP 价（对应海报三档）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_prices (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id    BIGINT UNSIGNED NOT NULL,
  level       ENUM('PUBLIC','VIP','SVIP') NOT NULL COMMENT 'PUBLIC = 非会员价',
  price_cent  BIGINT UNSIGNED NOT NULL,
  unit_label  VARCHAR(16) NOT NULL DEFAULT '场' COMMENT '计价单位：场 / 小时',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_event_level (event_id, level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='同一活动按会员等级取价';

-- ---------------------------------------------------------------------------
-- 报名：绑定时段 + 支付状态（普通用户线下支付，运营确认收款）
-- ---------------------------------------------------------------------------
ALTER TABLE registrations
  ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER event_id,
  ADD COLUMN payment_status ENUM('NOT_REQUIRED','UNPAID','PAID','REFUNDED') NOT NULL DEFAULT 'NOT_REQUIRED' AFTER status,
  ADD KEY idx_session_status (session_id, status);

-- 旧报名回填：取该活动最早时段，避免历史数据 session_id 为空
UPDATE registrations r
JOIN (SELECT event_id, MIN(id) AS sid FROM event_sessions GROUP BY event_id) s ON s.event_id = r.event_id
SET r.session_id = s.sid
WHERE r.session_id IS NULL;
