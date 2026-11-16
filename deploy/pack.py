#!/usr/bin/env python3
"""
用 Python 打部署包，显式写入 Unix 权限位。

Windows 自带的 bsdtar 不保留 Unix 可执行位，解压到 Linux 后所有 .sh 都是 644，
用户执行 ./deploy.sh 会直接 Permission denied。

⚠️ 目录必须是 0755：缺 x 位时甚至连「进入该目录」都不允许，
nginx 以非 root 用户读 public/web 会直接 403，/admin/ 的 try_files 回退
不到 index.html 则触发内部重定向死循环 → 500。

  - 目录        -> 0755（必须含 x）
  - *.sh        -> 0755
  - 其它文件    -> 0644

用法：
    python deploy/pack.py <暂存目录> <输出 tar.gz>
其中暂存目录下应当就是 photo-club/。

⚠️ 归档根目录必须是 `photo-club/`，不能把暂存目录名带进去。
   早先的写法是 `tar.add(SRC, arcname=basename(SRC))`，暂存目录叫 .pack-staging，
   结果包里变成 `.pack-staging/photo-club/deploy/…`：
   用户在 /www/wwwroot 解压后文件落到 `.pack-staging/` 下，
   线上目录一个字节都没被覆盖 —— 表现就是「上传解压了但没生效」。
   现在固定只打包 photo-club/ 这一层，并在打包后自检归档路径。
"""
import os
import sys
import tarfile

SRC = sys.argv[1]      # 暂存目录，其下即 photo-club/
OUT = sys.argv[2]      # 输出 tar.gz

# 归档内的顶层目录名：部署脚本与文档一律按这个路径书写
TOP = 'photo-club'
top_path = os.path.join(SRC, TOP)


def norm(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    # 必须用 TarInfo.isdir()：info.name 是归档内路径，
    # 拿它去调 os.path.isdir() 永远为 False，会把目录误判成普通文件。
    if info.isdir():
        info.mode = 0o755
    elif info.name.endswith('.sh'):
        info.mode = 0o755
    else:
        info.mode = 0o644
    return info


if not os.path.isdir(top_path):
    sys.exit(f'暂存目录里找不到 {TOP}/：{top_path}（请先准备好打包内容）')

with tarfile.open(OUT, 'w:gz') as tar:
    # 只加 photo-club 这一层，arcname 固定成 photo-club
    tar.add(top_path, arcname=TOP, filter=norm)

# 自检：归档里所有条目都必须以 photo-club/ 开头，否则解压位置会错
with tarfile.open(OUT) as tar:
    bad = [m.name for m in tar.getmembers() if m.name != TOP and not m.name.startswith(TOP + '/')]
if bad:
    os.remove(OUT)
    sys.exit(f'打包自检失败：存在不在 {TOP}/ 下的条目，例如 {bad[:3]}')

print(f'OK {OUT} {os.path.getsize(OUT)} bytes')
