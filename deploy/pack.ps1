#!/usr/bin/env pwsh
# ============================================================================
# 重新生成部署压缩包 photo-club-deploy.tar.gz（Windows 原生版）
#
# 与 pack.sh 做同样的事，只是不依赖 Git Bash —— 本机没装 bash 时直接跑这个：
#   powershell -ExecutionPolicy Bypass -File deploy/pack.ps1
#
# 会同步：Docker 构建上下文源码、前后端构建产物、部署脚本与配置。
# 产物结构：photo-club/deploy/...（解压后进入 deploy/ 执行 ./deploy.sh）
#
# 注意：**不会**自动跑前端构建。打包前请先执行 `pnpm build`，
# 否则 dist 是旧的，线上跑的还是上一次的前端（脚本会检查 dist 是否存在）。
#
# ⚠️ 归档必须保留 Unix 权限位：
# Windows 自带的 bsdtar 会把 .sh 打成 666，解压到 Linux 后 `./deploy.sh`
# 直接 Permission denied。因此这里优先交给 deploy/pack.py 写权限位
# （目录与 .sh 一律 0755，其余 0644），它同时会自检归档根目录是 photo-club/。
# ============================================================================
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path
$stage = Join-Path $root '.pack-staging'
$out = Join-Path $root 'photo-club-deploy.tar.gz'

# 构建产物必须存在，否则打出来的包上线会白屏
foreach ($app in @('web', 'admin')) {
  if (-not (Test-Path (Join-Path $root "apps/$app/dist/index.html"))) {
    throw "缺少 apps/$app/dist，请先执行：pnpm build"
  }
}

Write-Host '==> 同步 Docker 构建上下文源码'
Remove-Item -Recurse -Force 'deploy/context/apps/server/src', 'deploy/context/packages/shared/src' -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force 'apps/server/src' 'deploy/context/apps/server/'
Copy-Item -Recurse -Force 'packages/shared/src' 'deploy/context/packages/shared/'
Copy-Item -Force 'apps/server/package.json', 'apps/server/tsconfig.json' 'deploy/context/apps/server/'
Copy-Item -Force 'packages/shared/package.json', 'packages/shared/tsconfig.json' 'deploy/context/packages/shared/'
Copy-Item -Force 'tsconfig.base.json' 'deploy/context/'

Write-Host '==> 同步前后端构建产物'
Remove-Item -Recurse -Force 'deploy/public/admin', 'deploy/public/web' -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force 'deploy/public/admin', 'deploy/public/web' | Out-Null
Copy-Item -Recurse -Force 'apps/admin/dist/*' 'deploy/public/admin/'
Copy-Item -Recurse -Force 'apps/web/dist/*' 'deploy/public/web/'

Write-Host '==> 打包'
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'photo-club') | Out-Null
Copy-Item -Recurse -Force 'deploy' (Join-Path $stage 'photo-club/')
# 生产环境文件含真实密钥，绝不入包；清库脚本产生的备份也不入包
Remove-Item -Force (Join-Path $stage 'photo-club/deploy/.env.production') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $stage 'photo-club/deploy/backups') -ErrorAction SilentlyContinue

if (Test-Path $out) { Remove-Item -Force $out }

# 首选 pack.py：显式写 0755/0644，并自检归档根目录
# PowerShell 5.1 不支持 ?? 运算符，这里用两步查
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if ($python) {
  & $python.Source 'deploy/pack.py' $stage $out
  if ($LASTEXITCODE -ne 0) { throw "pack.py 打包失败（exit $LASTEXITCODE）" }
} else {
  # 没有 Python 时退回 Git 自带的 GNU tar（它按 Git Bash 的权限位写归档，
  # .sh 仍是 0755）；**不要**用 Windows 自带的那个 tar，那会丢执行位。
  $gnuTar = 'D:\Git\usr\bin\tar.exe'
  if (-not (Test-Path $gnuTar)) {
    throw '需要 Python 或 Git 的 GNU tar 来保留 Unix 权限位；请安装 Python 后重跑，或改用 Git Bash 执行 deploy/pack.sh'
  }
  & $gnuTar -czf $out -C $stage photo-club
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（exit $LASTEXITCODE）" }
  Write-Host '（已用 Git GNU tar 打包；安装 Python 后会自动改用 pack.py）'
}

Remove-Item -Recurse -Force $stage

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "已生成 $out（$size MB）"
Write-Host '上传服务器后解压，进入 deploy/ 执行 ./deploy.sh'
