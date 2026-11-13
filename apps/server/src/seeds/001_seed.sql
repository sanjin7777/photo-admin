-- ============================================================================
-- 演示种子数据（仅测试环境使用，禁止用于生产）
-- 账号标识：微信号（唯一）；统一密码由 init-seed.sh 按 SEED_PASSWORD 重新计算后替换 @hash。
-- 业务规则：仅 VIP / SVIP 拥有余额账户；普通用户报名走线下支付（payment_status=UNPAID）。
-- 时间均存 UTC（北京 = UTC+8）：如 15:00 北京时间 = 07:00 UTC。
-- 海报图片随前端产物放在 /posters/ 下，由 Nginx 同源提供。
-- ============================================================================

SET @hash = '$2a$12$1alsIuWsxt97QES2m5UKVOgG8.appXa8OWTl1uebtZikaIehnbX/6';
SET @now = '2026-11-09 00:00:00.000';

INSERT INTO users (id, wechat_id, nickname, phone, password_hash, status, session_version, created_at, updated_at) VALUES
  (1, 'admin_catpaw', '管理员',    NULL, @hash, 'ACTIVE', 1, @now, @now),
  (2, 'op_catpaw',    '运营',      NULL, @hash, 'ACTIVE', 1, @now, @now),
  (3, 'fin_catpaw',   '财务',      NULL, @hash, 'ACTIVE', 1, @now, @now),
  (4, 'model_deer',   '模特小鹿',  NULL, @hash, 'ACTIVE', 1, @now, @now),
  (5, 'vip_catpaw',   'VIP会员',   NULL, @hash, 'ACTIVE', 1, @now, @now),
  (6, 'svip_catpaw',  'SVIP会员',  NULL, @hash, 'ACTIVE', 1, @now, @now),
  (7, 'u1_catpaw',    '用户甲',    NULL, @hash, 'ACTIVE', 1, @now, @now),
  (8, 'u2_catpaw',    '用户乙',    NULL, @hash, 'ACTIVE', 1, @now, @now),
  (9, 'mgr_catpaw',   '管理员',    NULL, @hash, 'ACTIVE', 1, @now, @now)
ON DUPLICATE KEY UPDATE wechat_id = VALUES(wechat_id), nickname = VALUES(nickname);

INSERT INTO admin_roles (id, user_id, role, created_at) VALUES
  (1, 1, 'SUPER_ADMIN', @now), (2, 2, 'OPERATOR', @now),
  (3, 3, 'FINANCE', @now),     (4, 4, 'MODEL', @now),
  (5, 9, 'ADMIN', @now)
ON DUPLICATE KEY UPDATE role = VALUES(role);

INSERT INTO memberships (id, user_id, level, status, start_at, expire_at, source, granted_by, grant_reason, created_at, updated_at) VALUES
  (1, 5, 'VIP',  'ACTIVE', '2026-01-01 00:00:00.000', '2027-01-01 00:00:00.000', 'GRANT', 1, '种子数据', @now, @now),
  (2, 6, 'SVIP', 'ACTIVE', '2026-01-01 00:00:00.000', '2027-01-01 00:00:00.000', 'GRANT', 1, '种子数据', @now, @now)
ON DUPLICATE KEY UPDATE expire_at = VALUES(expire_at);

-- 只有会员有余额账户；普通用户（1/2/3/4/7/8）不建，余额 UI 不展示
INSERT INTO balance_accounts (user_id, available_cent, frozen_cent, version, updated_at) VALUES
  (5, 50000, 0, 0, @now), (6, 80000, 0, 0, @now)
ON DUPLICATE KEY UPDATE user_id = user_id;

INSERT INTO model_profiles (user_id, stage_name, height_cm, portfolio_url, portrait_auth_status, created_at, updated_at) VALUES
  (4, '犬了个牙', 168, NULL, 'GRANTED', @now, @now)
ON DUPLICATE KEY UPDATE stage_name = VALUES(stage_name);

-- 活动 1：公开场，3 个时段（北京 15:00-16:00 / 16:10-17:10 / 17:20-18:20）
INSERT INTO events
  (id, title, subtitle, description, cover_url, poster_urls, wardrobe_urls, venue, scene, notice,
   ratio_label, model_count, allow_proxy_shoot, private_booking_note, model_id,
   registration_open_at, registration_close_at, start_at, end_at, visibility,
   fee_cent, capacity, capacity_used, allow_coupon, refund_policy, status, created_at, updated_at)
VALUES
  (1, 'Cat''s paw 猫爪摄影会 · 办公室景', '犬了个牙 · 4V1', '办公室主题棚拍，含妆造与灯光。',
   '/posters/poster-catspaw.jpg',
   '["/posters/poster-catspaw.jpg","/posters/poster-housekeeping.jpg"]', '[]',
   '如懿映画', '办公室景',
   '开始前 24 小时可免费取消；迟到超过 15 分钟视为放弃，费用不退。拍摄含基础调色，精修另议。',
   '4V1', 1, 1, '单人包场请联系客服', 4,
   '2026-11-01 00:00:00.000', '2026-12-14 15:59:59.000',
   '2026-12-15 07:00:00.000', '2026-12-15 10:20:00.000', 'PUBLIC',
   18900, 12, 0, 1, '{"freeCancelBeforeHours": 24, "feeRatio": 0}', 'REGISTRATION_OPEN', @now, @now)
ON DUPLICATE KEY UPDATE title = VALUES(title), cover_url = VALUES(cover_url), subtitle = VALUES(subtitle);

-- 活动 2：SVIP 专场（对应海报 328 / 308 / 288，北京 19:00-20:00）
INSERT INTO events
  (id, title, subtitle, description, cover_url, poster_urls, wardrobe_urls, venue, scene, notice,
   ratio_label, model_count, allow_proxy_shoot, private_booking_note, model_id,
   registration_open_at, registration_close_at, start_at, end_at, visibility,
   fee_cent, capacity, capacity_used, allow_coupon, refund_policy, status, created_at, updated_at)
VALUES
  (2, '艾莲乔兔女郎 · SVIP 专场', '幼安因困 · 1V4', '兔女郎主题夜场，含场景布置与道具。',
   '/posters/poster-housekeeping.jpg',
   '["/posters/poster-housekeeping.jpg"]', '[]',
   '如懿映画', '夜场酒吧景',
   'SVIP 专场仅对有效 SVIP 会员开放；开始前 24 小时可取消，逾期收取 10% 手续费。',
   '1V4', 1, 1, '单人包场请联系客服', 4,
   '2026-11-01 00:00:00.000', '2026-12-17 15:59:59.000',
   '2026-12-18 11:00:00.000', '2026-12-18 12:00:00.000', 'SVIP',
   32800, 4, 0, 1, '{"freeCancelBeforeHours": 24, "feeRatio": 0.1}', 'REGISTRATION_OPEN', @now, @now)
ON DUPLICATE KEY UPDATE title = VALUES(title), cover_url = VALUES(cover_url), subtitle = VALUES(subtitle);

-- 时段：容量以时段为准
INSERT INTO event_sessions (id, event_id, label, start_at, end_at, capacity, capacity_used, status, sort_no, created_at, updated_at) VALUES
  (1, 1, '第一场', '2026-12-15 07:00:00.000', '2026-12-15 08:00:00.000', 4, 0, 'OPEN', 0, @now, @now),
  (2, 1, '第二场', '2026-12-15 08:10:00.000', '2026-12-15 09:10:00.000', 4, 0, 'OPEN', 1, @now, @now),
  (3, 1, '第三场', '2026-12-15 09:20:00.000', '2026-12-15 10:20:00.000', 4, 0, 'OPEN', 2, @now, @now),
  (4, 2, '夜场',   '2026-12-18 11:00:00.000', '2026-12-18 12:00:00.000', 4, 0, 'OPEN', 0, @now, @now)
ON DUPLICATE KEY UPDATE label = VALUES(label), start_at = VALUES(start_at), end_at = VALUES(end_at);

-- 分档价格：PUBLIC 为非会员价
INSERT INTO event_prices (id, event_id, level, price_cent, unit_label, created_at) VALUES
  (1, 1, 'PUBLIC', 18900, '场', @now),
  (2, 1, 'VIP',    16900, '场', @now),
  (3, 1, 'SVIP',   14900, '场', @now),
  (4, 2, 'PUBLIC', 32800, '场', @now),
  (5, 2, 'VIP',    30800, '场', @now),
  (6, 2, 'SVIP',   28800, '场', @now)
ON DUPLICATE KEY UPDATE price_cent = VALUES(price_cent);

-- 登录示例（密码为 SEED_PASSWORD）：
--   curl -X POST https://www.catpaw.art/api/v1/auth/login \
--     -H 'content-type: application/json' -d '{"wechatId":"svip_catpaw","password":"你的密码"}'
