#!/usr/bin/env bash
# ============================================================================
# 修复邀请码「备注」列乱码（可手动执行，不依赖重新部署）
#
# 用法：
#   ./fix-invite-note.sh        # 修复并显示结果
#
# 背景：
#   早期版本的 gen-invite-codes.sh 调用 mysql 客户端时没有指定
#   --default-character-set=utf8mb4，容器内 locale 为 C/POSIX，
#   客户端把 UTF-8 中文按 latin1（MySQL 的 latin1 实为 cp1252）解读，
#   服务端再按 utf8mb4 转存 → 双重编码乱码。
#
#   注意：原文「部署脚本生成」的 UTF-8 末字节 0x90 在 cp1252 中是未定义字符，
#   写入时已被替换成 '?'，原始信息永久丢失，**无法反解还原**。
#   因此这里不做反解：所有由部署脚本生成的备注原文都是固定字符串，
#   凡是「非空且不含中文」的备注一律改写为「部署脚本生成」。
#
# 前提：MySQL 容器在运行、迁移 008 已建好 invite_codes 表。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env.production ] || { echo "ERROR: 缺少 .env.production，请先运行 ./deploy.sh"; exit 1; }

COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

if ! "${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot photo_club -e "SELECT 1"' >/dev/null 2>&1; then
  echo "ERROR: 无法连接 MySQL 容器，请确认服务正在运行（docker ps）"
  exit 1
fi

echo "==> 修复前状态"
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club -e "
SELECT COUNT(*) AS 总数,
       SUM(CASE WHEN note IS NOT NULL AND note <> %s AND note NOT REGEXP %s THEN 1 ELSE 0 END) AS 待修复
  FROM invite_codes" ' "" "'[一-龥]'" 2>/dev/null || \
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club -e "
SELECT COUNT(*) AS total,
       SUM(CASE WHEN note IS NOT NULL AND note <> \"\" AND note NOT REGEXP \"[一-龥]\" THEN 1 ELSE 0 END) AS to_fix
  FROM invite_codes"'

echo "==> 执行修复（非中文备注统一改写为「部署脚本生成」）"
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club' <<'SQL'
UPDATE invite_codes
   SET note = CONVERT('部署脚本生成' USING utf8mb4)
 WHERE note IS NOT NULL
   AND note <> ''
   AND note NOT REGEXP '[一-龥]';
SQL

echo "==> 修复后状态（备注应显示为「部署脚本生成」）"
"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club -e "
SELECT code, status, note FROM invite_codes ORDER BY id LIMIT 8"'

echo ""
echo "OK: 乱码备注已修复，刷新后台「邀请码」页面即可看到正常中文。"
