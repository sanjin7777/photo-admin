#!/usr/bin/env bash
# ============================================================================
# ⚠️ 危险：清空本项目 photo_club 的业务数据（保留表结构与 schema_migrations）。
#
# 仅用于测试环境重建，例如历史乱码数据需要重新导入种子。
# 安全闸门（缺一不可）：
#   1) 必须在交互式终端执行，且手工输入 「PURGE photo_club」才继续；
#      非 TTY（管道 / CI / 定时任务）直接拒绝，避免误触发。
#   2) 清空前用 mysqldump 自动备份到 deploy/backups/，备份为空则中止。
#   3) 只 TRUNCATE 下面列出的表，不触碰服务器上其它项目或数据库。
#
# 旧文件名 reset-test-data.sh 会让人误以为只是清测试数据，已重命名并加固。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

TABLES="votes vote_options vote_campaigns refund_orders balance_transactions balance_adjustments
registrations event_prices event_sessions events notifications idempotency_keys refresh_sessions
audit_logs permission_logs memberships model_profiles balance_accounts admin_roles users"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "用法：./purge-business-data.sh   （交互式确认后清空 photo_club 业务数据，并先自动备份）"
  exit 0
fi

echo "将要清空 photo_club 的以下表（表结构保留）："
for t in $TABLES; do echo "  - $t"; done
echo ""

# 强制交互：禁止通过管道或 CI 传入确认串
if [ ! -t 0 ]; then
  echo "ERROR: 该脚本必须在交互式终端执行（禁止用 echo/管道/CI 传入确认）。" >&2
  exit 1
fi

CONFIRM=""
read -r -p "确认清空请输入 PURGE photo_club（其它输入直接放弃）： " CONFIRM
if [ "$CONFIRM" != "PURGE photo_club" ]; then
  echo "已取消，未做任何修改。"
  exit 0
fi

set -a
. ./.env.production
set +a

if [ -z "${MYSQL_ROOT_PASSWORD:-}" ]; then
  echo "ERROR: .env.production 缺少 MYSQL_ROOT_PASSWORD，已中止。" >&2
  exit 1
fi

mkdir -p backups
BACKUP="backups/photo-club-before-purge-$(date +%Y%m%d-%H%M%S).sql"
echo "==> 清空前备份到 $BACKUP"
"${COMPOSE[@]}" exec -T -e "MYSQL_PWD=${MYSQL_ROOT_PASSWORD}" mysql \
  mysqldump --single-transaction --quick --default-character-set=utf8mb4 \
  -uroot photo_club > "$BACKUP"
if [ ! -s "$BACKUP" ]; then
  rm -f "$BACKUP"
  echo "ERROR: 备份文件为空，已中止，未清空任何数据。" >&2
  exit 1
fi
echo "    备份完成（$(du -h "$BACKUP" | cut -f1)）"

echo "==> 正在清空业务数据…"
SQL="SET FOREIGN_KEY_CHECKS=0;"
for t in $TABLES; do SQL="$SQL TRUNCATE TABLE $t;"; done
SQL="$SQL SET FOREIGN_KEY_CHECKS=1;"

"${COMPOSE[@]}" exec -T -e "MYSQL_PWD=${MYSQL_ROOT_PASSWORD}" mysql \
  mysql --default-character-set=utf8mb4 -uroot photo_club -e "$SQL"

echo "==> 已清空。备份文件：$BACKUP"
echo "    重新导入种子： ./init-seed.sh"
