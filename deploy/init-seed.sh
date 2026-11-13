#!/usr/bin/env bash
# 可选步骤：导入开发种子账号。默认 deploy.sh 不会导入任何账号。
# 密码取自 .env.production 的 SEED_PASSWORD（deploy.sh 已随机生成），并在容器内生成新的 bcrypt 哈希，
# 因此服务器上不会出现示例密码 Photo@12345。
# 可重复执行（种子 SQL 使用 ON DUPLICATE KEY UPDATE）。
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

[ -f .env.production ] || { echo "ERROR: 请先运行 ./deploy.sh"; exit 1; }
set -a
. ./.env.production
set +a
[ -n "${SEED_PASSWORD:-}" ] || { echo "ERROR: SEED_PASSWORD 未设置"; exit 1; }
[ "$SEED_PASSWORD" != "Photo@12345" ] || { echo "ERROR: 禁止使用示例密码"; exit 1; }

echo "==> 在容器内生成新密码的 bcrypt 哈希"
hash_value="$("${COMPOSE[@]}" run --rm --no-deps -e "SEED_PASSWORD=${SEED_PASSWORD}" server \
  node -e "const b=require('bcryptjs');console.log(b.hashSync(process.env.SEED_PASSWORD,12))" \
  2>/dev/null | tail -n1 | tr -d '\r')"
[ -n "$hash_value" ] || { echo "ERROR: 哈希生成失败"; exit 1; }

echo "==> 读取镜像内的种子模板"
"${COMPOSE[@]}" run --rm --no-deps server cat src/seeds/001_seed.sql 2>/dev/null > /tmp/photo_seed_raw.sql
if ! head -n1 /tmp/photo_seed_raw.sql | grep -q '^--'; then
  echo "ERROR: 种子模板读取异常"; exit 1
fi
sed "s|SET @hash = '[^']*';|SET @hash = '${hash_value}';|" /tmp/photo_seed_raw.sql > /tmp/photo_seed.sql

echo "==> 导入种子数据"
# --default-character-set=utf8mb4 必须显式指定，否则中文会以 latin1 发送导致双重编码乱码
"${COMPOSE[@]}" exec -T -e "MYSQL_PWD=${MYSQL_ROOT_PASSWORD}" mysql \
  mysql --default-character-set=utf8mb4 -uroot photo_club < /tmp/photo_seed.sql
rm -f /tmp/photo_seed_raw.sql /tmp/photo_seed.sql

echo ""
echo "OK: 8 个账号已导入，统一密码为 .env.production 中的 SEED_PASSWORD（请自行保存，脚本不会回显）"
echo "  后台账号: admin@photo.dev / op@photo.dev / fin@photo.dev"
echo "  会员测试: vip@photo.dev / svip@photo.dev"
echo "⚠️ 公网可达时请立刻轮换这些密码，并在腾讯云安全组把 8082 限制为仅你的 IP。"
