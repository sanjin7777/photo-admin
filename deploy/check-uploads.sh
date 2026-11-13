#!/usr/bin/env bash
# ============================================================================
# 图片上传链路诊断（只读，不修改任何数据）
#
# 用法：
#   ./check-uploads.sh
#
# 背景：
#   后台场次列表里，新上传的封面裂图（显示破图图标），
#   但种子数据里的 /posters/*.jpg 正常显示。
#   说明 Nginx 整体静态托管没问题，问题局限在 /uploads/ 这条路径。
#   本脚本逐段验证「数据库路径 → 宿主机文件 → 容器内文件 → HTTP 响应」，
#   定位到底断在哪一环。
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"

COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)
MYSQL_Q() {
  "${COMPOSE[@]}" exec -T mysql sh -c "MYSQL_PWD=\$MYSQL_ROOT_PASSWORD mysql -uroot --default-character-set=utf8mb4 photo_club -N -B -e \"$1\"" 2>/dev/null
}

echo "=============================================================="
echo " 1) 容器状态"
echo "=============================================================="
"${COMPOSE[@]}" ps 2>/dev/null | sed 's/^/  /'

echo
echo "  ★ 关键判读：容器年龄"
echo "    nginx 若明显比 server 旧 → nginx 配置改动没生效（compose 跳过了重建），"
echo "    这就是「改了 nginx.conf 但图片仍裂图」的最常见原因。"
"${COMPOSE[@]}" ps --format '{{.Name}}\t{{.CreatedAt}}' 2>/dev/null | sed 's/^/    /' || \
  "${COMPOSE[@]}" ps 2>/dev/null | sed 's/^/    /'

echo
echo "=============================================================="
echo " 1b) nginx 当前是否加载了新版 /uploads/ 配置"
echo "=============================================================="
newcfg="$("${COMPOSE[@]}" exec -T nginx nginx -T 2>/dev/null | grep -c "@uploads_via_api" || true)"
if [ "${newcfg:-0}" -ge 1 ]; then
  echo "  ✔ 已加载新版配置（磁盘直读 + 反代兜底）"
else
  echo "  ✘ 未加载新版配置 —— nginx 容器需要重建！执行："
  echo "      docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate nginx"
fi

echo
echo "=============================================================="
echo " 2) 数据库里存的图片路径（最近 8 条）"
echo "=============================================================="
rows="$(MYSQL_Q "SELECT id, cover_url FROM events WHERE cover_url IS NOT NULL AND cover_url <> '' ORDER BY id DESC LIMIT 8")"
if [ -z "$rows" ]; then
  echo "  （events 表里没有 cover_url）"
else
  echo "$rows" | sed 's/^/  /'
fi

echo
echo "  invite_codes 备注样本（判断乱码是否修好）:"
MYSQL_Q "SELECT code, note FROM invite_codes ORDER BY id LIMIT 5" 2>/dev/null | sed 's/^/    /' || echo "    (读取失败)"

echo
echo "=============================================================="
echo " 3) 取一条 /uploads/ 路径做后续验证"
echo "=============================================================="
sample="$(MYSQL_Q "SELECT cover_url FROM events WHERE cover_url LIKE '/uploads/%' ORDER BY id DESC LIMIT 1" 2>/dev/null || true)"
if [ -z "$sample" ]; then
  sample="$(MYSQL_Q "SELECT url FROM invite_codes ORDER BY id DESC LIMIT 1" 2>/dev/null || true)"
fi
if [ -z "$sample" ]; then
  echo "  库里没有 /uploads/ 开头的路径，跳过文件与 HTTP 检查。"
  echo "  → 若上面的 cover_url 是 /posters/ 开头，说明用户还没上传过图片到本环境。"
else
  echo "  样本路径: $sample"
  rel="${sample#/}"          # 去掉前导 /
  echo
  echo "  3a) 宿主机 deploy/data/uploads 下是否存在:"
  if [ -f "data/uploads/$rel" ]; then
    echo "      ✔ 存在  data/uploads/$rel"
    ls -l "data/uploads/$rel" | sed 's/^/        /'
  else
    echo "      ✘ 不存在  data/uploads/$rel"
    echo "        uploads 目录实际内容:"
    find data/uploads -type f 2>/dev/null | head -8 | sed 's/^/          /'
    find data/uploads -type f 2>/dev/null | wc -l | sed 's/^/          共计文件数: /'
  fi

  echo
  echo "  3b) server 容器内是否能读到（Express 就托管这个目录）:"
  "${COMPOSE[@]}" exec -T server sh -c "ls -l /app/apps/server/data/uploads/$rel" 2>&1 | sed 's/^/      /'

  echo
  echo "  3c) nginx 容器内是否能读到（新增的磁盘直读路径）:"
  "${COMPOSE[@]}" exec -T nginx sh -c "ls -l /usr/share/nginx/uploads/$rel" 2>&1 | sed 's/^/      /'

  echo
  echo "=============================================================="
  echo " 4) HTTP 实测（经容器 nginx，127.0.0.1:8081）"
  echo "=============================================================="
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:8081$sample" 2>/dev/null)"
  ctype="$(curl -s -o /dev/null -w '%{content_type}' --max-time 8 "http://127.0.0.1:8081$sample" 2>/dev/null)"
  size="$(curl -s -o /dev/null -w '%{size_download}' --max-time 8 "http://127.0.0.1:8081$sample" 2>/dev/null)"
  echo "  状态码: ${code:-无响应}"
  echo "  Content-Type: ${ctype:-无}"
  echo "  字节数: ${size:-无}"
  case "$code" in
    200) echo "  ✔ 容器 nginx 正常返回该图片" ;;
    404) echo "  ✘ 404：nginx 没找到文件。重点检查 3a/3b/3c 与 nginx.conf 的 /uploads/ 配置" ;;
    200*) echo "  ? 状态异常" ;;
    *)   echo "  ✘ 未取到响应：容器或端口不通，先看上面的容器状态与 docker logs photo-club-nginx" ;;
  esac
fi

echo
echo "=============================================================="
echo " 5) nginx 当前生效的 /uploads/ 配置（确认配置已加载）"
echo "=============================================================="
"${COMPOSE[@]}" exec -T nginx nginx -T 2>/dev/null | grep -A 8 "location /uploads" | sed 's/^/  /' || echo "  （未取到）"

echo
echo "=============================================================="
echo " 6) 磁盘直读所需的卷挂载是否存在"
echo "=============================================================="
"${COMPOSE[@]}" exec -T nginx sh -c "ls -ld /usr/share/nginx/uploads 2>&1" | sed 's/^/  /'
echo "  若上面报 'No such file or directory' → nginx 容器没有挂载 uploads 目录，"
echo "  说明 docker-compose.prod.yml 的改动未生效，需要强制重建容器。"

echo
echo "=============================================================="
echo " 7) 对比：一个种子静态图（正常）"
echo "=============================================================="
code2="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:8081/posters/poster-catspaw.jpg" 2>/dev/null)"
echo "  /posters/poster-catspaw.jpg → ${code2:-无响应}"
echo "  若 /posters/ 是 200 而 /uploads/ 是 404 → 确认问题只在 /uploads/ 这条路径。"

echo
echo "诊断结束。请把以上完整输出发回，便于精确定位。"
