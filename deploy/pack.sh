#!/usr/bin/env bash
# ============================================================================
# 重新生成部署压缩包 photo-club-deploy.tar.gz
#
# 每次改完代码、准备上传服务器前执行本脚本，避免「忘记更新压缩包」
# 导致线上仍跑旧代码（历史上已因此出现过迁移缺失、管理员账号失效等问题）。
#
# 会同步：Docker 构建上下文源码、前后端构建产物、部署脚本与配置。
# 产物结构：photo-club/deploy/...（解压后进入 deploy/ 执行 ./deploy.sh）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAGE="$ROOT/.pack-staging"
OUT="$ROOT/photo-club-deploy.tar.gz"

echo "==> 同步 Docker 构建上下文源码"
rm -rf deploy/context/apps/server/src deploy/context/packages/shared/src
cp -a apps/server/src deploy/context/apps/server/
cp -a packages/shared/src deploy/context/packages/shared/
cp -a apps/server/package.json apps/server/tsconfig.json deploy/context/apps/server/
cp -a packages/shared/package.json packages/shared/tsconfig.json deploy/context/packages/shared/
cp -a tsconfig.base.json deploy/context/

echo "==> 同步前后端构建产物"
rm -rf deploy/public/admin deploy/public/web
mkdir -p deploy/public/admin deploy/public/web
cp -a apps/admin/dist/. deploy/public/admin/
cp -a apps/web/dist/. deploy/public/web/

echo "==> 打包"
rm -rf "$STAGE"
mkdir -p "$STAGE/photo-club"
cp -a deploy "$STAGE/photo-club/"
# 生产环境文件含真实密钥，绝不入包；清库脚本产生的备份也不入包
rm -f "$STAGE/photo-club/deploy/.env.production"
rm -rf "$STAGE/photo-club/deploy/backups"
tar -czf "$OUT" -C "$STAGE" photo-club
rm -rf "$STAGE"

echo "已生成 $OUT"
echo "上传服务器后解压，进入 deploy/ 执行 ./deploy.sh"
