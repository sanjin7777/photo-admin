#!/usr/bin/env bash
# ============================================================================
# 确保「管理员(ADMIN)」账号可用 —— 幂等，可反复执行。
#
# 解决的问题：
#   add-admin-role.sh 是复制运维账号的密码哈希，而运维账号密码是部署时随机生成的，
#   所以经常出现「账号建了但不知道密码」→ 登录失败。
#   本脚本直接把 mgr_catpaw 的密码重置为 .env.production 里的 SEED_PASSWORD，
#   并保证账号存在、状态正常、拥有 ADMIN 角色。
#
# 用法：
#   ./ensure-admin.sh              # 修复管理员账号并打印密码
#   ./ensure-admin.sh --super      # 顺带把运维账号 admin_catpaw 的密码也重置成同一个
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env.production
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: 缺少 $ENV_FILE，请先在 deploy 目录执行 ./deploy.sh"
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

if [ -z "${SEED_PASSWORD:-}" ]; then
  echo "ERROR: $ENV_FILE 里的 SEED_PASSWORD 为空，无法确定目标密码。"
  echo "       请先在其中填一个密码（至少 8 位），再重新执行本脚本。"
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml)

# 先试探容器是否可用（不同 compose 版本对 --status 支持不一致，直接用 exec 探测更稳）
if ! "${COMPOSE[@]}" exec -T server node -e "process.exit(0)" >/dev/null 2>&1; then
  echo "ERROR: server 容器不可用，请先执行 ./deploy.sh 启动服务"
  exit 1
fi

echo "==> 生成密码哈希（在 server 容器内用 bcryptjs，密码经 stdin 传入，不出现在命令行）"
HASH="$("${COMPOSE[@]}" exec -T server node -e "
  let s='';
  process.stdin.on('data', d => s += d);
  process.stdin.on('end', () => {
    const bcrypt = require('bcryptjs');
    process.stdout.write(bcrypt.hashSync(s.trim(), 12));
  });
" <<< "$SEED_PASSWORD")"

if [ -z "$HASH" ]; then
  echo "ERROR: 生成密码哈希失败，请检查 server 容器是否正常"
  exit 1
fi

# 组装 SQL：$HASH 里的 $ 不会被再次展开（变量展开结果不再递归解释）
SQL_FILE="$(mktemp)"
trap 'rm -f "$SQL_FILE"' EXIT
{
  echo "SET NAMES utf8mb4;"

  # 0) 自愈：老库的 admin_roles.role 枚举里可能没有 ADMIN（006 迁移没跑到时）
  echo "SET @col := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS"
  echo "  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_roles' AND COLUMN_NAME = 'role');"
  # 精确匹配枚举项 'ADMIN'：用 LIKE '%ADMIN%' 会被 SUPER_ADMIN 的子串骗过而跳过修复
  echo "SET @ddl := IF(@col LIKE '%''ADMIN''%', 'DO 0',"
  echo "  'ALTER TABLE admin_roles MODIFY COLUMN role ENUM(''MODEL'',''OPERATOR'',''FINANCE'',''ADMIN'',''SUPER_ADMIN'') NOT NULL');"
  echo "PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;"

  echo "START TRANSACTION;"
  # 清掉枚举不匹配时期留下的空角色脏记录
  echo "DELETE FROM admin_roles WHERE role = '';"

  # 1) 管理员账号：不存在则建，存在则重置密码与状态
  echo "INSERT INTO users (wechat_id, nickname, password_hash, status, session_version, created_at, updated_at)"
  echo "VALUES ('mgr_catpaw', '管理员', '$HASH', 'ACTIVE', 1, NOW(3), NOW(3))"
  echo "ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'ACTIVE', session_version = session_version + 1, updated_at = NOW(3);"

  # 2) 角色：确保有 ADMIN（不要动可能存在的其他角色）
  echo "INSERT INTO admin_roles (user_id, role, created_at)"
  echo "SELECT id, 'ADMIN', NOW(3) FROM users WHERE wechat_id = 'mgr_catpaw'"
  echo "ON DUPLICATE KEY UPDATE role = VALUES(role);"

  # 3) 可选：运维账号密码一并重置
  if [ "${1:-}" = "--super" ]; then
    echo "UPDATE users SET password_hash = '$HASH', status = 'ACTIVE', session_version = session_version + 1, updated_at = NOW(3) WHERE wechat_id = 'admin_catpaw';"
  fi

  echo "COMMIT;"

  # 4) 回显结果，便于确认
  echo "SELECT u.id AS 用户ID, u.wechat_id AS 账号, u.nickname AS 昵称, u.status AS 状态,"
  echo "       GROUP_CONCAT(r.role) AS 角色"
  echo "  FROM users u LEFT JOIN admin_roles r ON r.user_id = u.id"
  echo " WHERE u.wechat_id IN ('mgr_catpaw','admin_catpaw')"
  echo " GROUP BY u.id, u.wechat_id, u.nickname, u.status;"
} > "$SQL_FILE"

echo "==> 写入数据库"
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot photo_club --default-character-set=utf8mb4' < "$SQL_FILE"

echo
echo "完成。用下面的账号登录后台 /admin/："
echo "  账号：mgr_catpaw"
echo "  密码：$SEED_PASSWORD"
if [ "${1:-}" = "--super" ]; then
  echo "  运维账号 admin_catpaw 的密码也已重置为同一串。"
fi
echo
echo "登录后管理员可以看到：场次、模特、报名、投票、用户、财务、权限与治理。"
echo
echo "⚠️ 如果账号密码正确、登录后却被弹回「无权限」，说明 server 镜像还是旧版本："
echo "   旧版的后端不认识 ADMIN 角色，会把它从后台角色里过滤掉。"
echo "   请在 deploy 目录执行 ./deploy.sh 重建镜像后再试。"
