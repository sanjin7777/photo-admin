-- ============================================================================
-- 015 优惠券（折扣券 / 立减券）
--
-- 业务规则（2026-11-10 用户确认）：
--   1. 券由管理员按微信号发给具体用户，全场通用，不绑定场次；
--      能否用券由场次的 events.allow_coupon 开关决定（只拦新报名，不影响历史订单）。
--   2. 一次报名 N 个名额最多用 N 张券（每名额一张）；券不足时多出的名额按原价。
--   3. 折扣券在「档位价（会员价/活动价）」基础上打折，可设最高优惠封顶；
--      立减券直接减固定金额，最低减到 0 元（不出现负数）。
--   4. 券的占用/核销在报名事务内完成；只有退款「通过」后才退回（未过期可再用），
--      退款驳回不释放——用户仍在履约，券继续占用。
--   5. EXPIRED 不入库：读取时按 expires_at 动态判定，避免定时任务。
--
-- 依赖：001 ~ 014。
-- 回滚：
--   ALTER TABLE registrations
--     DROP COLUMN coupon_id, DROP COLUMN discount_cent, DROP COLUMN original_fee_cent;
--   ALTER TABLE events DROP COLUMN allow_coupon;
--   DROP TABLE IF EXISTS coupons;
--   （回滚会丢失已发券与用券记录，执行前务必备份 coupons 表）
-- ============================================================================

CREATE TABLE IF NOT EXISTS coupons (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id              BIGINT UNSIGNED NOT NULL,
  title                VARCHAR(32) NOT NULL,
  type                 ENUM('DISCOUNT','AMOUNT') NOT NULL,
  discount_bp          SMALLINT UNSIGNED DEFAULT NULL COMMENT '折扣万分比：8500 = 85 折',
  amount_cent          INT UNSIGNED DEFAULT NULL COMMENT '立减金额（分）',
  min_spend_cent       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '单席最低消费门槛',
  max_discount_cent    INT UNSIGNED DEFAULT NULL COMMENT '折扣券最高优惠封顶',
  expires_at           DATETIME(3) DEFAULT NULL COMMENT 'NULL 表示长期有效',
  status               ENUM('UNUSED','USED','REVOKED') NOT NULL DEFAULT 'UNUSED',
  used_registration_id BIGINT UNSIGNED DEFAULT NULL,
  used_at              DATETIME(3) DEFAULT NULL,
  note                 VARCHAR(200) DEFAULT NULL,
  issued_by            BIGINT UNSIGNED DEFAULT NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_status (user_id, status, expires_at),
  KEY idx_registration (used_registration_id),
  KEY idx_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='优惠券实例：发券即建行，单次使用';

-- 场次级开关：关闭后该场次新报名不能带券（历史报名不受影响）
ALTER TABLE events
  ADD COLUMN allow_coupon TINYINT(1) NOT NULL DEFAULT 1 AFTER allow_waitlist;

-- 报名金额拆分：fee_cent 保留为「实付（折后）」，退款/对账仍按快照金额
ALTER TABLE registrations
  ADD COLUMN original_fee_cent INT UNSIGNED NOT NULL DEFAULT 0 AFTER fee_cent,
  ADD COLUMN discount_cent     INT UNSIGNED NOT NULL DEFAULT 0 AFTER original_fee_cent,
  ADD COLUMN coupon_id         BIGINT UNSIGNED DEFAULT NULL AFTER discount_cent;

-- 历史报名没有用券：原价 = 实付，优惠 0
UPDATE registrations SET original_fee_cent = fee_cent WHERE original_fee_cent = 0;
