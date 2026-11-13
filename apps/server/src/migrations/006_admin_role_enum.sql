-- ============================================================================
-- 006：让角色与流水枚举跟代码对齐
--
-- 两个都是「代码加了新值、DDL 没跟上」的典型问题，会导致写入直接失败：
--   1. admin_roles.role 缺 ADMIN —— 后台新增的「管理员」角色根本插不进去，
--      表现就是账号建好了却没有任何角色，登录后被判定为非后台账号。
--   2. balance_transactions.biz_type 只有三种业务，后台手工加余额（导入/创建用户）
--      用的是 MANUAL_ADJUST，这里保持不变，但把注释写清楚，避免再写进不去。
-- ============================================================================

ALTER TABLE admin_roles
  MODIFY COLUMN role ENUM('MODEL','OPERATOR','FINANCE','ADMIN','SUPER_ADMIN') NOT NULL
  COMMENT '后台身份；ADMIN 为日常最高权限，SUPER_ADMIN 为运维账号';

-- 老库里如果存在因枚举不匹配被写坏的记录（role 为空字符串），直接清掉，
-- 这些记录本来就没有任何权限，留着只会在回显时显示成空。
DELETE FROM admin_roles WHERE role = '';
