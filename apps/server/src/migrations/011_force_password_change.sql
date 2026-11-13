-- ---------------------------------------------------------------------------
-- Excel 导入账号首次登录强制改密
--
-- 背景：导入账号由运营发放一次性临时口令，共享/硬编码口令一旦外泄即为越权入口。
-- 标记为 1 的账号登录后只能访问 /me、/me/capabilities、/me/password、/auth/logout，
-- 改密成功后清零（见 modules/auth/service.ts changePassword）。
--
-- 回滚：
--   ALTER TABLE users DROP COLUMN must_change_password;
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1=导入账号首次登录必须先改密' AFTER locked_until;
