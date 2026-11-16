#!/usr/bin/env bash
# 摄影会报名系统 · 一键部署（IP 内网测试版）
# 在服务器上的 deploy/ 目录执行： ./deploy.sh
#
# 设计原则：只启动新容器、只创建新数据库/数据卷，不停止、不删除、不重置任何已有服务或数据。
# 前置：已安装 Docker + Docker Compose 插件；已把整个 deploy 目录上传到服务器。
set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# 自愈：压缩包可能来自 Windows，tar 不一定保留 Unix 权限位。
#   · .sh 缺 x  → 直接 ./deploy.sh 会 Permission denied
#   · 目录缺 x  → nginx 进不去 public/web，表现为首页 403、/admin/ 500
# 这里统一补一遍，用户用 bash deploy.sh 起步也能自愈。
# ---------------------------------------------------------------------------
find . -type d -exec chmod 755 {} + 2>/dev/null || true
chmod +x ./*.sh 2>/dev/null || true

# Compose 默认只读 .env；必须显式指定 --env-file，否则 ${...} 插值全部为空
COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

command -v docker >/dev/null 2>&1 || { echo "ERROR: 未找到 docker，请先在宝塔安装 Docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: 缺少 docker compose 插件（需要 Compose v2）"; exit 1; }

if [ ! -f .env.production ]; then
  cp .env.production.example .env.production
  echo "已生成 .env.production"
fi
chmod 600 .env.production

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    cat /proc/sys/kernel/random/uuid | tr -d '-'
  fi
}

ensure_key() {
  local key="$1" val
  val="$(grep -E "^${key}=" .env.production | head -n1 | cut -d= -f2- || true)"
  if [ -z "$val" ]; then
    val="$(gen_secret)"
    if grep -qE "^${key}=" .env.production; then
      # 旧版 .env 里已有这一行但值为空
      sed -i "s|^${key}=.*|${key}=${val}|" .env.production
    else
      # 旧版 .env 完全没有这一行（新增变量时必须追加，否则 docker compose 会一直告警且传空值）
      printf '\n%s=%s\n' "$key" "$val" >> .env.production
    fi
    echo "  ${key} 已自动生成"
  fi
}
echo "==> 检查并补齐密钥"
for key in MYSQL_ROOT_PASSWORD MYSQL_PASSWORD JWT_ACCESS_SECRET SEED_PASSWORD; do ensure_key "$key"; done

# 上传目录必须在容器启动前存在，否则 Docker 会建成 root 拥有的空目录导致写入失败
mkdir -p data/uploads
chmod 755 data/uploads
# nginx 容器以非 root 用户读取 uploads 目录提供图片，
# 子目录与文件也必须对其可读，否则页面上图片裂图但文件明明在服务器上。
find data/uploads -type d -exec chmod 755 {} + 2>/dev/null || true
find data/uploads -type f -exec chmod 644 {} + 2>/dev/null || true

# 从旧版升级上来的 .env.production 没有 PUBLIC_ORIGIN；缺失会让 CORS/CSRF 白名单为空，
# 导致所有带 Origin 的写请求被 403。这里自动补默认值，避免手改。
origin="$(grep -E '^PUBLIC_ORIGIN=' .env.production | head -n1 | cut -d= -f2- || true)"
if [ -z "$origin" ]; then
  if grep -q '^PUBLIC_ORIGIN=' .env.production; then
    sed -i 's|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://www.catpaw.art|' .env.production
  else
    echo 'PUBLIC_ORIGIN=https://www.catpaw.art' >> .env.production
  fi
  echo "  PUBLIC_ORIGIN 已补为 https://www.catpaw.art"
fi

ip="$(grep -E '^SERVER_IP=' .env.production | head -n1 | cut -d= -f2- || true)"
if [ -z "$ip" ]; then
  ip="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  if [ -z "$ip" ]; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  if [ -z "$ip" ]; then echo "ERROR: 无法探测 SERVER_IP，请在 .env.production 手动填写"; exit 1; fi
  sed -i "s|^SERVER_IP=.*|SERVER_IP=${ip}|" .env.production
  echo "  SERVER_IP 探测为 ${ip}"
fi

[ -f public/web/index.html ] || { echo "ERROR: 缺少 public/web/index.html（请先构建前端产物）"; exit 1; }
[ -f public/admin/index.html ] || { echo "ERROR: 缺少 public/admin/index.html"; exit 1; }

set -a
. ./.env.production
set +a
if [ "$JWT_ACCESS_SECRET" = "dev-only-access-secret-change-me-32chars-min" ]; then
  echo "ERROR: JWT_ACCESS_SECRET 仍是示例值"; exit 1
fi

echo "==> 构建后端镜像"
"${COMPOSE[@]}" build server

echo "==> 启动独立 MySQL（数据卷 photo_club_mysql_data，不影响已有数据库）"
"${COMPOSE[@]}" up -d mysql

echo "==> 等待 MySQL 健康检查通过"
mysql_cid="$("${COMPOSE[@]}" ps -q mysql)"
state="starting"
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$mysql_cid" 2>/dev/null || echo starting)"
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "$state" = "healthy" ] || { echo "ERROR: MySQL 未就绪，请检查 docker logs photo-club-mysql"; exit 1; }

echo "==> 执行初始迁移（幂等，已执行版本自动跳过）"
# 迁移失败必须中断部署：否则脚本会带着「迁移没跑」的状态继续往下走，
# 用户看到的是「改了却没效果」，极难定位。
if ! "${COMPOSE[@]}" run --rm --no-deps server node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json src/db/migrate.ts; then
  echo "ERROR: 数据库迁移失败，部署已中止。请检查上面的错误输出。"
  echo "       修复后重新执行 ./deploy.sh 即可（迁移按文件名登记，已成功的不会重跑）。"
  exit 1
fi

echo "==> 启动 API 与 Nginx"
# --force-recreate 必须有：改了 nginx.conf / docker-compose.prod.yml 后，
# docker compose 会认为「配置没变」而跳过重建，导致新配置永不生效
# （历史故障：nginx 容器比 server 旧 17 小时，/uploads/ 新配置完全没生效 → 图片裂图）。
"${COMPOSE[@]}" up -d --force-recreate server nginx

# 自检：确认 nginx 容器确实是本次重建的，且新配置已加载
echo "==> 自检 nginx 配置是否已生效"
nginx_cfg="$("${COMPOSE[@]}" exec -T nginx nginx -T 2>/dev/null | grep -c "location @uploads_via_api" || true)"
if [ "${nginx_cfg:-0}" -ge 1 ]; then
  echo "  ✔ nginx 已加载新版 /uploads/ 配置（磁盘直读 + 反代兜底）"
else
  echo "  WARN: nginx 未加载新版 /uploads/ 配置，请检查是否重建成功。"
  echo "        可手动执行： docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate nginx"
fi

echo "==> 检查初始邀请码（无码时自动生成 20 个，供管理员发放）"
invite_total="$("${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot -N -B photo_club -e "SELECT COUNT(*) FROM invite_codes"' 2>/dev/null || echo 0)"
invite_total="$(echo "${invite_total:-0}" | tr -d '[:space:]')"
if [ "$invite_total" = "0" ]; then
  ./gen-invite-codes.sh 20 || echo "  WARN: 邀请码自动生成失败，部署完成后请手动执行 ./gen-invite-codes.sh"
else
  echo "  已有 ${invite_total} 个邀请码，跳过自动生成"
fi

echo "==> 修复邀请码备注乱码（历史库遗留的编码问题）"
./fix-invite-note.sh || echo "  WARN: 乱码修复失败，可稍后手动执行 ./fix-invite-note.sh"

echo "==> 部署后验证"
./verify.sh

echo ""
echo "部署完成（容器侧已就绪）："
echo "  宝塔反代目标   http://127.0.0.1:8081"
echo "  容器内自检     ./verify.sh"
echo "  图片链路诊断   ./check-uploads.sh"
echo ""
echo "下一步：域名与 HTTPS 需在宝塔面板完成"
echo "  1) DNS 把 www.catpaw.art 解析到本机公网 IP"
echo "  2) 宝塔添加站点 www.catpaw.art → SSL 申请 Let's Encrypt → 开启强制 HTTPS"
echo "  3) 该站点添加反向代理：目标 URL http://127.0.0.1:8081（整站代理）"
echo "  完成后访问 ${PUBLIC_ORIGIN}/ 与 ${PUBLIC_ORIGIN}/admin/"
echo "  需要测试账号时执行 ./init-seed.sh（密码为 .env.production 中的 SEED_PASSWORD）"
echo "  需要「管理员(ADMIN)」账号时执行 ./ensure-admin.sh（幂等，会重置密码并打印账号）"
echo "  需要更多注册邀请码时执行 ./gen-invite-codes.sh 20（后台「邀请码」页也可生成）"
echo "防火墙放行 80 / 443；8081 与 3307 已仅绑定 127.0.0.1，切勿对公网开放。"
