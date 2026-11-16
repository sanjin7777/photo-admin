-- ============================================================================
-- 026：时段级回避名单（SVIP 择邻）
--
-- 业务背景：
--   会员（尤其 SVIP）会提前报名占位，并希望某个具体的人**不要和自己报同一时段**。
--   注意范围是「时段（event_sessions）」而不是「整场」——不在同一时段就无所谓。
--
-- 设计取舍：
--   · 不做成"全局黑名单"：那会把某人标记成系统级的"不受欢迎"，
--     一旦泄露或误操作不可逆。这里记的是「某个 SVIP 对某个时段的一次偏好」，
--     解除容易，也不影响该用户报名其它时段。
--   · owner_user_id 记录「为谁设置」，owner 取消报名时该规则自动失效，
--     避免人已经不来、名单却还挂在上面继续拦人。
--   · 同一时段对同一个人只保留一条规则（uk_session_blocked），
--     多个 SVIP 提出同一诉求不会产生重复拦截。
--
-- 回滚：
--   DROP TABLE IF EXISTS session_avoid_rules;
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_avoid_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL COMMENT '生效的时段',
  owner_user_id BIGINT UNSIGNED NULL COMMENT '为哪位会员设置（受益方）；为空表示运营出于其它原因配置',
  blocked_user_id BIGINT UNSIGNED NOT NULL COMMENT '该时段不接受其报名的用户',
  note VARCHAR(200) NULL COMMENT '原因备注，仅运营可见',
  created_by BIGINT UNSIGNED NULL COMMENT '操作人',
  revoked_by BIGINT UNSIGNED NULL,
  revoked_at DATETIME(3) NULL COMMENT '软撤销：保留痕迹，不物理删除',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_session_blocked (session_id, blocked_user_id),
  KEY idx_blocked_user (blocked_user_id),
  KEY idx_owner (owner_user_id),
  KEY idx_session_alive (session_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='时段级回避名单（同一时段不接受某人报名）';

SELECT COUNT(*) AS table_ready FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_name = 'session_avoid_rules';
