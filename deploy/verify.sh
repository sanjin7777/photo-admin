#!/usr/bin/env bash
# 部署后冒烟：健康检查、前台、/admin/ 后台、/api 反向代理。
# 也可单独执行： ./verify.sh
set -euo pipefail
WEB="http://127.0.0.1:8081"
ADMIN="http://127.0.0.1:8081/admin/"

echo "==> /api/v1/health（容器启动后 API 需要几秒，最多等待 40 秒）"
health=""
for _ in $(seq 1 20); do
  if health="$(curl -fsS --max-time 5 "$WEB/api/v1/health" 2>/dev/null)"; then break; fi
  sleep 2
done
if [ -z "$health" ]; then
  echo "FAIL: 健康检查不可用（502 或连接失败）"
  echo "排查三连："
  echo "  docker ps -a"
  echo "  docker logs --tail 50 photo-club-server"
  echo "  docker logs --tail 20 photo-club-nginx"
  exit 1
fi
printf '%s\n' "$health"
if ! printf '%s' "$health" | grep -q '"db":"up"'; then
  echo "FAIL: 数据库未连通（检查 docker logs photo-club-server）"; exit 1
fi

curl -fsS -o /dev/null --max-time 10 "$WEB/" || { echo "FAIL: 前台首页不可访问"; exit 1; }
curl -fsS -o /dev/null --max-time 10 "$ADMIN" || { echo "FAIL: /admin/ 后台不可访问"; exit 1; }

events="$(curl -fsS --max-time 10 "$WEB/api/v1/events?pageSize=1")"
if printf '%s' "$events" | grep -q '"code":4001'; then
  echo "FAIL: /api 反向代理未生效（返回 404）"; exit 1
fi

echo "OK: db=up / 前台 / /admin/ 后台 / API 反代 均正常"
echo "域名与 HTTPS 需在宝塔侧配置完成后，再用浏览器访问 https://www.catpaw.art/ 验证"
