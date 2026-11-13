#!/usr/bin/env bash
# ============================================================================
# 追加/修复「管理员(ADMIN)」角色账号 —— 幂等，可重复执行。
#
# 用于已经跑过 init-seed.sh 的环境：只想新增一个管理员账号，而不清空现有数据。
# 做法：复制运维账号账号的密码哈希，创建一个 mgr_catpaw 账号并授予 ADMIN 角色，
# 这样它的登录密码与运维账号一致（即 .env.production 里的 SEED_PASSWORD）。
#
# 也可以用 init-seed.sh 全量重导 —— 但那样会清空测试数据。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.production ]; then
  echo "ERROR: 缺少 .env.production，请先执行 ./deploy.sh"
  exit 1
fi

COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

echo "==> 写入 mgr_catpaw（ADMIN 角色）"
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot photo_club --default-character-set=utf8mb4' <<'SQL'
INSERT INTO users (wechat_id, nickname, password_hash, status, session_version, created_at, updated_at)
SELECT 'mgr_catpaw', '管理员', password_hash, 'ACTIVE', 1, NOW(3), NOW(3)
  FROM users WHERE wechat_id = 'admin_catpaw'
ON DUPLICATE KEY UPDATE nickname = VALUES(nickname);

INSERT INTO admin_roles (user_id, role, created_at)
SELECT id, 'ADMIN', NOW(3) FROM users WHERE wechat_id = 'mgr_catpaw'
ON DUPLICATE KEY UPDATE role = VALUES(role);

SELECT u.wechat_id AS 账号, r.role AS 角色
  FROM users u JOIN admin_roles r ON r.user_id = u.id
 ORDER BY u.id;
SQL

echo
echo "完成。用 mgr_catpaw 登录后台：密码与运维账号相同（.env.production 里的 SEED_PASSWORD）。"
echo "管理员能看到：场次、报名、投票、会员、财务；看不到：权限与治理（审计/权限日志/导出）。"
