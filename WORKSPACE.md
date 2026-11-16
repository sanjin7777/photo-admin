# 开发工作区说明（E 盘 · 真实后端）

> 建立时间：2026-11-14　｜　对应提交：`a7bacd5 初始化：猫爪社摄影会报名系统`
> 工作区根目录：**`E:\workspace`**　｜　项目目录：**`E:\workspace\photo-admin`**
> 本项目已从 C 盘迁移至 E 盘，C 盘原目录已删除。

---

## 一、环境现状

| 项 | 值 |
|---|---|
| Node.js | v24.9.0（满足 `engines.node >= 20`） |
| pnpm | 9.12.0（与根 `package.json` 的 `packageManager` 一致） |
| pnpm store | `E:\workspace\.pnpm-store`（已从 C 盘迁出） |
| Docker Desktop | 4.99.0 / Engine 29.9.3（**WSL2 后端**） |
| WSL | 3.0.1.0，内核 6.18.40.1-1，默认版本 2 |
| MySQL | 8.0（容器 `photo-club-mysql`，端口 3306） |
| 数据库 | `photo_club`，**26 张表**，24 个迁移，**已导入生产数据** |
| 数据规模 | 26 用户 / 4 场次 / 18 报名 / 4 模特 / 4 投票活动 |
| 图片 | `apps/server/data/uploads/` 共 **64 个文件（17.1 MB）**，来自生产 |
| 运行模式 | **真实后端**（不再是 Mock） |

## 二、启动方式

```bash
# 1) 先确保 Docker 在运行（首次开机后需手动启动）
#    开始菜单 → Docker Desktop，或：
#    Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

# 2) 启动 MySQL 容器（数据在 Docker 卷里，关机后容器停止需重新 start）
docker start photo-club-mysql

# 3) 启动真实后端（端口 3000）
cd E:\workspace\photo-admin
pnpm dev:server

# 4) 前台 / 后台（各自独立终端）
pnpm dev:web      # http://localhost:5173/
pnpm dev:admin    # http://localhost:5174/admin/
```

> ⚠️ Vite 仅监听 `::1`（IPv6 回环），浏览器请用 `http://localhost:5173`，不要用 `127.0.0.1`。
> 非 Mock 模式下 Vite 会把 `/api` 和 `/uploads` 一起代理到 `http://127.0.0.1:3000`，所以**后端必须先起来**。

### 数据库维护命令

```bash
cd E:\workspace\photo-admin
pnpm --filter @photo/server migrate      # 应用迁移（幂等，已应用的会跳过）

# 进 MySQL 命令行
docker exec -it photo-club-mysql mysql -uphoto -pphoto_dev photo_club

# 查看容器日志
docker logs photo-club-mysql
```

## 三、演示账号

**真实数据库的种子密码统一为 `Photo@12345`**（注意：与 Mock 模式的 `mock123456` **不同**）。

| 微信号 | 昵称 | 角色 / 等级 | 用途 |
|---|---|---|---|
| `admin_catpaw` | 管理员 | SUPER_ADMIN | 运维视角（界面不体现） |
| `mgr_catpaw` | 管理员 | ADMIN | **后台业务全功能** |
| `op_catpaw` | 运营 | OPERATOR | 场次 / 模特 / 报名 / 投票 |
| `fin_catpaw` | 财务 | FINANCE | 退款 / 积分流水 / 调账 |
| `svip_catpaw` | SVIP会员 | SVIP | 会员场次、投票 |
| `vip_catpaw` | VIP会员 | VIP | 会员场次 |
| `u1_catpaw` / `u2_catpaw` | 用户甲/乙 | NONE | 普通用户 / 线下支付 |
| `model_deer` | 模特小鹿 | — | 模特档案绑定账号 |

## 三、账号

**本地数据库已用生产数据覆盖，账号密码就是生产环境的密码**（上面种子表的 `Photo@12345` 已被覆盖，仅归档备份里还有）。

- 生产账号的密码由线上 `deploy/.env.production` 的 `SEED_PASSWORD` 决定，如果改过就以下不适用。
- 已知一个通用哈希：`admin_catpaw` 等种子账号在生产端统一用同一个 bcrypt 串。
- **忘记密码时**，可在本地直接改：见下方「重置本地账号密码」。

### 重置本地账号密码

```powershell
# 生成新哈希（密码自定）
node -e "console.log(require('bcryptjs').hashSync('新密码',12))"

# 写回数据库
docker exec photo-club-mysql mysql -uphoto -pphoto_dev photo_club -e "UPDATE users SET password_hash='粘贴哈希' WHERE wechat_id='admin_catpaw';"
```

## 四、质量校验

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 4 个工作区包全部通过 |
| `pnpm verify` | ✅ 48 组契约断言通过；DDL 20 表 / 种子 8 表一致 |
| 真实后端 `/api/v1/health` | ✅ 200，`{"status":"ok","db":"up"}` |
| 生产数据导入 | ✅ 26 表 / 26 用户 / 4 场次 / 18 报名，中文正常 |
| 图片可访问性 | ✅ 数据库引用的 19 个文件全部 200 |

## 五、为跑通工作区所做的修正

### 5.1 依赖修正（**按用户要求保留**，未改业务代码）

1. **`@types/multer`**（`apps/server/package.json`）
   `multer@2.5.0` 自身不带类型声明，`tsc` 报 `TS7016`。补 `@types/multer@^2.0.0`。

2. **`esbuild`**（根 `package.json` + `scripts/verify.mjs`）
   `verify.mjs` 原硬编码 `require('packages/shared/node_modules/esbuild')`，该路径只在 pnpm **扁平提升**布局下存在。已改为**逐级回退**解析，并在根 devDependencies 显式声明 `esbuild@^0.21.5`。

3. **`/uploads` 代理**（`apps/web/vite.config.ts` + `apps/admin/vite.config.ts`）
   原配置只代理 `/api`，**没有 `/uploads`**。生产由 Nginx 直接读磁盘提供图片，所以线上没暴露；
   本地 dev 下上传的图片会落到 SPA 的 `index.html`，页面全部裂图。
   已给两端 proxy 补上 `/uploads` → `http://127.0.0.1:3000`。

> `pnpm-lock.yaml` 随之有约 700 行重排（`resolution`/`snapshots` 结构，依赖版本未变）。

### 5.2 系统环境（非仓库改动）

- 启用 Windows 功能：`Microsoft-Windows-Subsystem-Linux`、`VirtualMachinePlatform`、`Microsoft-Hyper-V-All`（需重启生效）。
- `wsl --update` 安装 WSL2 内核。
- 安装 Docker Desktop 并将当前用户加入 `docker-users` 组。
- **配置国内镜像加速器** —— 直连 Docker Hub 超时，已写入 `C:\Users\sanjin\.docker\daemon.json`：
  `docker.1panel.live`、`docker.1ms.run`、`docker.m.daocloud.io`、`docker.xuanyuan.me`。
- 创建 `apps/server/.env`（从 `.env.example` 复制，连本机 `127.0.0.1:3306`）。

## 六、已知问题与限制

### ⚠️ Docker 数据仍在 C 盘（约 2.8GB）

尝试把 Docker 的 WSL 磁盘迁到 E 盘**失败并已回滚**。原因：

- Docker Desktop 4.99 没有暴露磁盘镜像路径设置，`diskImage` 类键不被支持；
- 改用目录联接（junction）重定向 `%LOCALAPPDATA%\Docker\wsl` 后，WSL 拒绝加载：
  `无法遍历该路径，因为它包含不受信任的装入点 (0x800701c0)`。

当前状态：**已回滚到 C 盘原位置，Docker 与数据均正常**。

如果确实要迁移，可行路径是（未执行，供决策）：
1. Docker Desktop 设置界面 → Resources → Advanced → **Disk image location**（图形界面提供该选项，命令行没有）；
2. 或改用原生 `mysql` 安装在 E 盘、不用 Docker。

> 项目本身（含 `node_modules`、pnpm store）已全部在 E 盘，C 盘仅剩 Docker 自身的 2.8GB 数据盘 + 3.9GB 程序文件。

### 其他

- 关机重启后 Docker Desktop 不会自动启动（`AutoStart: false`），需手动启动再 `docker start photo-club-mysql`。
- `setup-backend.ps1` 是首次建库时用的自动化脚本，日常已不需要，保留作参考。

## 七、生产数据同步记录（2026-11-14）

| 项 | 说明 |
|---|---|
| 数据来源 | 宝塔 `124.223.112.161:33377` → `/www/wwwroot/photo-club` |
| 导出方式 | 服务器端 `mysqldump`（`--single-transaction --no-tablespaces`） |
| 导入后规模 | 26 表 / 26 用户 / 4 场次 / 18 报名 / 4 模特 / 4 投票 / 24 迁移 |
| 兼容性 | 生产 `schema_migrations` = 24，与本地代码版本**完全对齐**，无需补跑迁移 |
| 图片 | `uploads.tar.gz`（17.1 MB，64 文件）解压至 `apps/server/data/uploads/` |
| 数据库引用 | 19 个 `/uploads/` 文件，**全部命中** |
| 本地回滚点 | `E:\workspace\db-backup\local-before-import-20261114-132701.sql`（导入前 9 用户 / 2 场次） |

### 遗留事项

- ⚠️ `E:\prod-backup.sql`（229.7 KB）**含全部真实用户数据**（微信号、密码哈希、订单）。确认无误后建议删除：
  ```powershell
  Remove-Item 'E:\prod-backup.sql' -Force
  ```
- 下载的 `uploads.tar.gz` 与临时解压目录已清理。图片已入 git 忽略的 `data/` 目录，不会被误提交。

## 八、数据治理记录（2026-11-14 14:08）

生产数据导入后，按「测试数据 + 场次与报名」范围清除了测试痕迹。

### 已删除

| 项目 | 数量 | 说明 |
|---|---|---|
| 优惠券 | 1 | `测试优惠券`（8 折，发给 test333） |
| 邀请码 | 36 | **仅未使用的**；4 个已被真实用户使用的保留 |
| 投票活动 | 1 | 「月亮服装投票」及其 3 个方案、1 张选票 |
| 场次 | 4 | 含 9 个时段、12 条档位价 |
| 报名 | 18 | 涉及 7 个真实会员、13,330 元流水 |
| 退款单 | 7 | — |
| 积分流水 | 11 | 仅 `REGISTRATION` / `REFUND` 业务流水 |
| 幂等键 | 8 | 与报名强相关 |
| 刷新会话 | 180 | 登录态，清后需重新登录 |

### 保留

| 项目 | 数量 |
|---|---|
| 用户 | 26（9 个种子账号 + 17 个真实会员） |
| 会员资格 | 20 |
| 积分账户 | 16 |
| 积分流水 | 22（**MANUAL_ADJUST 13 条 + BONUS 9 条**，即会员开通赠送与赠送积分） |
| 模特档案 | 4 |
| 场景库 | 11 |
| 投票活动 | 3（11.21 水母 / 11.21 白电波 / 11.22 双人） |
| 邀请码（已使用） | 4 |
| 用户协议同意 | 28 |
| 审计日志 | 316 |
| 应用设置 | 2（海报二维码 / 网站二维码） |

### 资金处理（重要）

删除报名时，其对应的积分流水含 **FREEZE（冻结）** 记录。若直接删流水，`balance_accounts` 会留下无法解释的孤立冻结额。脚本做了**解冻回冲**：

| 用户 | 处理前 | 处理后 |
|---|---|---|
| `svip_catpaw`（种子） | 可用 36,300 / 冻结 43,700 | 可用 80,000 / 冻结 0 |
| `langkemuzi`（白乌鸦，真实） | 可用 306,000 / 冻结 194,000 | 可用 500,000 / 冻结 0 |

`vip_catpaw`(50,000) 与 `svip_catpaw`(80,000) 的余额来自**种子初始化**、本就没有流水，属历史遗留，如需归零可手动处理。

### 一致性校验（全部通过）

- 孤儿数据：报名 / 时段 / 档位价 / 退款 / 选票 / 邀请码引用 —— **均为 0**
- 钱包与流水勾稽：余额不为 0 但无流水的仅 5/6 两个种子账号（预期内）

### 回滚

```powershell
Get-Content 'E:\workspace\db-backup\before-governance-20261114-140746.sql' -Raw |
  docker exec -i photo-club-mysql mysql -uphoto -pphoto_dev photo_club
```

治理脚本保留在 `E:\workspace\governance.sql`（可复现、可审阅）。

## 九、数据治理记录（第二轮 · 2026-11-14 14:14）

按用户指示「积分和流水也全部清空，test333 账号也移除」执行。

### 已删除

| 项目 | 数量 | 说明 |
|---|---|---|
| `test333` 账号 | 1 | 连同其会员资格、积分账户、邀请码、协议同意记录一并清除 |
| 积分流水 | 21 | `MANUAL_ADJUST` 13 条 + `BONUS` 9 条（test333 的 1 条已随账号删除） |
| 调账记录 | 0 | 此前已随流水清空 |
| 积分余额 | 15 个账户 | **全部置 0**（账户行保留，会员身份不变） |

### 保留

| 项目 | 数量 |
|---|---|
| 用户 | 25（9 种子 + 16 真实会员） |
| 会员资格 | 19（VIP/SVIP 身份完整保留） |
| 积分账户 | 15（余额均为 0） |
| 模特档案 / 场景库 | 4 / 11 |
| 投票活动 / 方案 / 选票 | 3 / 21 / 16 |
| 邀请码 | 3（均已被真实用户使用） |
| 用户协议同意 | 26 |
| 审计日志 | 316 |

### 数据现状总览

```
events               0    ← 已清空
registrations        0    ← 已清空
refund_orders        0    ← 已清空
coupons              0    ← 已清空
balance_transactions 0    ← 已清空
balance_adjustments  0    ← 已清空
users               25
memberships         19
balance_accounts    15    ← 余额全 0
model_profiles       4
scenes              11
vote_campaigns       3
audit_logs         316
schema_migrations   24
```

### 一致性校验（11 项全部通过）

会员资格 / 积分账户 / 后台角色 / 协议同意 / 邀请码引用 / 流水账户 / 模特绑定 / 投票方案 / 选票 —— **孤儿数据均为 0**，非零余额账户为 **0**。

### 回滚点

| 备份 | 时点 | 内容 |
|---|---|---|
| `before-governance-20261114-140746.sql` | 第一轮治理前 | 含 4 场次 / 18 报名 / 33 流水 |
| `before-points-purge-20261114-141403.sql` | 第二轮治理前 | 含 22 流水 / 16 账户余额 / test333 |

```powershell
Get-Content 'E:\workspace\db-backup\before-points-purge-20261114-141403.sql' -Raw |
  docker exec -i photo-club-mysql mysql -uphoto -pphoto_dev photo_club
```

治理脚本：`E:\workspace\governance.sql`、`E:\workspace\governance-2-points.sql`。

## 十、去商业化改造（2026-11-14）

### 背景

站点备案为**个人主体（湘ICP备2026012181号-2）**，而原设计含付费会员、积分 1:1 锚定人民币且可退还、明码标价与退款流程，存在被认定为「经营性互联网信息服务」的风险（个人主体无法申请 ICP 许可证）。改造目标：**去掉全部货币语义，保留内部权益账本**。

### 改造后的计量口径

| 原概念 | 现概念 | 说明 |
|---|---|---|
| 金额（元） | **积分** | 唯一计量单位，站点内不出现 `¥` 与「元」 |
| 报名 | **登记** | 登记即占位，线上不收款 |
| 报名成功 | **生成票根** | 票根含核销编号，到场凭此核销 |
| 优惠券 | **权益券** | 仍是折扣/减免，但以积分计，无货币含义 |
| 退款 | **退回积分** | 取消登记后积分按规则回充 |
| 财务 | **积分与权益** | 退款审核改为取消审核 |

### 关键设计决定

1. **积分不构成预付储值**：不可购买、不可提现、不可转让、不可兑现、不设退还机制。原 `ProfileView` 里「可按 1 积分 = 1 元线下退还」的表述**已删除**——这是本次改造最重要的一处。
2. **数据库结构未改**：`fee_cent` / `event_prices.price_cent` 等列保留，现仅作积分台账的存储单位（1 积分 = 100 单位，保留两位小数精度）。历史数据完整，无需迁移。
3. **无在线支付**：全库无任何支付网关集成（已核查）。
4. **会员等级保留**：VIP/SVIP 定义为「资格等级」，只决定可见场次、登记门槛与投票权，与付费无关。

### 代码改动

| 端 | 主要改动 |
|---|---|
| `packages/shared` | 新增 `refund.ts`（前后端共用退点计算）；`points.ts` / `labels` 去除货币口径 |
| `apps/web` | 场次卡片/详情/我的登记/个人中心全部改为积分展示；新增 **票根页** `/tickets/:id`；协议与隐私政策重写去商业化表述 |
| `apps/admin` | `yuan()` 移除，统一 `points()`；场次价格改为「标准/VIP/SVIP 积分」；优惠券去金额；财务页改为「积分与权益」；驾驶舱与海报导出去除 `¥` |
| `apps/server` | `refundAmountOf` 上收到 shared 单一实现；`registrations/:id` 补 join 场次标题与时段（供票根使用） |

### 票根

新增 `apps/web/src/views/TicketView.vue`：
- 上部：场次 / 时段 / 时间 / 场地 / 模特
- 撕线：两侧半圆缺口 + 虚线
- 下部：**6 位核销编号**（可点击复制）+ 到场提示
- 已取消/已失效的票根会明确标注失效

### 校验

```
pnpm typecheck  → 4 个包通过
pnpm verify     → 48 组断言通过（更新了 4 条与新口径相关的断言）
admin/web build → 均成功
端到端冒烟      → 登记成功 → 票根可读（场次/时段/场地/编号齐全）
```

> 遗留：后台仍有 `refund_orders` 表与退款审核接口（UI 已改为「取消审核」，不再提「退款」）。若后续要彻底删除资金模块，可做第二阶段清理。
