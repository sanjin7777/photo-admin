#!/usr/bin/env bash
# ============================================================================
# 生成注册邀请码（幂等可重复执行，已存在的码不会重复插入）
#
# 用法：
#   ./gen-invite-codes.sh          # 默认生成 20 个
#   ./gen-invite-codes.sh 50       # 生成 50 个（单次上限）
#
# 生成的码不含 0/O/1/I，长期有效；请复制输出交给需要注册的用户。
# 前提：已完成 deploy.sh（迁移 008 建表、server 与 mysql 容器在运行）。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

COUNT="${1:-20}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 50 ]; then
  echo "ERROR: 数量需为 1-50 之间的整数" >&2
  exit 1
fi

COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

# 用 server 容器里的 node + crypto 生成高熵码（exec 不会混入 compose 的创建日志）
CODES="$("${COMPOSE[@]}" exec -T server node -e '
const crypto = require("crypto");
const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const n = Number(process.argv[1]) || 20;
const out = [];
for (let i = 0; i < n; i++) {
  out.push(Array.from(crypto.randomBytes(12), (b) => alpha[b % alpha.length]).join(""));
}
process.stdout.write(out.join(" "));
' "$COUNT" 2>/dev/null)"

if [ -z "$CODES" ]; then
  echo "ERROR: 未能生成邀请码，请确认 server 容器正在运行（docker compose ps）" >&2
  exit 1
fi

SELECTS=""
for code in $CODES; do
  [ -n "$SELECTS" ] && SELECTS="$SELECTS UNION ALL "
  SELECTS="${SELECTS}SELECT '${code}' AS code"
done

"${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club' <<SQL
INSERT INTO invite_codes (code, created_by, note, created_at, updated_at)
SELECT c.code,
       (SELECT id FROM users WHERE wechat_id = 'mgr_catpaw' LIMIT 1),
       '部署脚本生成', NOW(3), NOW(3)
  FROM (${SELECTS}) c
 WHERE NOT EXISTS (SELECT 1 FROM invite_codes ic WHERE ic.code = c.code);
SQL

echo "已生成 ${COUNT} 个邀请码（长期有效，一码一次）："
echo ""
for code in $CODES; do echo "  ${code}"; done
echo ""
echo "请把以上邀请码交给需要注册的用户；也可在后台「邀请码」页面继续生成或作废。"
