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
"""
import os
import sys
import tarfile

SRC = sys.argv[1]      # 暂存目录，其下即 photo-club/
OUT = sys.argv[2]      # 输出 tar.gz


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


with tarfile.open(OUT, 'w:gz') as tar:
    tar.add(SRC, arcname=os.path.basename(SRC.rstrip('/\\')), filter=norm)

print(f'OK {OUT} {os.path.getsize(OUT)} bytes')
