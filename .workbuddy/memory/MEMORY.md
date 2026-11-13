# 项目长期约定 · 猫爪社摄影会报名系统

## 工程结构
- Monorepo：`packages/shared`（契约单一来源：schema / enums / labels / endpoints / capabilities / roles / errors）、`apps/server`（Express + TS + MySQL2）、`apps/admin`（Vue3，Vite base=/admin/）、`apps/web`（Vue3 前台）、`mock`（Vite 中间件接管 /api/v1）、`scripts`（verify.mjs / verify-routes.ts）、`deploy`（Docker Compose + Nginx + 迁移/种子/部署脚本）。
- 部署方式：**服务器本地磁盘部署**，保持 `deploy.sh` + `docker-compose.prod.yml` 流程不变；`deploy/context` 与 `deploy/public` 是打包产物，**每次改完代码准备上传前必须执行 `./deploy/pack.sh`** 重新生成 `photo-club-deploy.tar.gz`（用户曾因忘记更新压缩包导致线上跑旧代码）。`deploy/.pack` 是陈旧影子副本，不要在其中执行部署。
- 新增 `deploy/gen-invite-codes.sh`（生成邀请码）与 `deploy/pack.sh`（同步源码/构建产物并打包）；`deploy.sh` 在检测到无邀请码时自动生成 20 个。
- 迁移编号：`001`~`008` 已存在（007 多名额与删模特 visibility、008 邀请码）。新增迁移继续顺延，DDL 变更尽量带 information_schema 条件判断。

## 用户工作习惯
- 沟通用中文，喜欢详细的技术/工程拆解与代码级解释。
- **先只读分析、再动代码**：实现前先给结构梳理、调用链与方案，确认后再进入编码。
- 界面上不允许漏英文枚举；提示文案一律中文。
- 界面风格：列表优先 + 弹窗新建/编辑，移动端弹窗需自适应。

## 产品决策（2026-11-10 09:43，优先级高于旧审查报告）
1. **不体现超级管理员痕迹**：`SUPER_ADMIN` 角色在数据层保留（运维用，独占系统区四项能力、不进用户列表、不可后台创建），但所有用户可见文案、菜单、提示、种子昵称、部署脚本回显都不得出现「超级管理员 / 超管」，统一称「管理员」。
2. **不做调账双人复核阻断**：后台常只有一名 ADMIN，允许其自申请自批准人工调账，仅保留 `requested_by` / `reviewed_by` 审计留痕。旧报告 P0 第 3 条已撤回。
3. **报名支持一账号多名额**（2026-11-10 10:15 补充）：连场、包场、带朋友（同一场两个名额）是真实场景，**必须一次请求同时报多个名额**，不能分次下单。实现：同一事务内生成 N 条独立报名记录（每条 = 1 个名额，可单独取消/退款），共享同一幂等键；去掉 `uk_event_user` 与无条件查重；整批容量原子扣减、余额按 N 校验、累计活跃名额上限 20；幂等键按 userId 隔离。
4. **邀请码注册**：前台注册必填邀请码，一码只能用一次，由管理员在后台生成（单次 1–50，默认不设有效期）；管理员代注册（/admin/users）与 Excel 导入不消耗邀请码；种子管理员无需码。**邀请码必须同时写入 `users.invite_code_id`**（用户 10:15 明确要求），与 `invite_codes.used_by` 双向可查，后台用户列表展示「邀请码」列。新表预留 `source` / `parent_user_id` / `reward_cent`，为后期「用户端生成邀请码 + 奖励」留扩展（当前不实现）。注册事务必须 `SELECT ... FOR UPDATE` + 条件 UPDATE 保证原子性。
5. **移除 `model_profiles.visibility`**；`events.visibility`（场次按会员等级可见）是核心业务字段，**绝不删除**。
6. **OFFERED 在活动开始时过期**：截止时间为 `min(now+30min, event.start_at)`，需定时/惰性回收并释放预留容量。
7. 其余全局审查 60 项按 `code-review-report.html` 的四批路线图执行。

## 关键交付物
- `code-review-report.html`（工作区根目录）：全局只读审查报告，P0/P1/P2/P3 共 60 项 + 第八节「用户决策与新增需求」（逐字原文、逐条落地设计、待拍板点）。
- 待拍板：多名额实现方式 A（单条带 seats）/ B（多条独立，推荐）；邀请码是否设有效期、单次上限、首部署初始数量。

## 高复发故障根因（改动时留意）
- `validateQuery` 用 Zod `parsed.data` 覆盖 `req.query`，未声明键被 strip → 列表筛选静默失效；新增列表路由必须定义 extend schema 并在 SQL 加 WHERE。
- Nginx 全局 `client_max_body_size 2m` 与后端 5MB / 前端 10MB 冲突；阈值需统一到单一常量。
- `ensure-admin.sh` 曾用 `LIKE '%ADMIN%'` 被 `SUPER_ADMIN` 子串骗过，导致 ADMIN 枚举未补齐、role 存成空串（历史「管理员登录失败」根因），需精确匹配。
- `biz_type` 在 DDL / shared labels / admin labels / mock 四处易漂移，DDL 实际值为 `REGISTRATION / REFUND / MANUAL_ADJUST`。
- 余额变更应统一走 `applyLedgerEntry`（FOR UPDATE + version + 唯一流水键），Excel 导入曾直接 UPDATE `balance_accounts` 绕过账本。
