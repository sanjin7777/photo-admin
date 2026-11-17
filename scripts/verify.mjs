/**
 * 模块 6 静态 + 纯逻辑验收（不需要 MySQL）。
 * 运行：node scripts/verify.mjs（或 pnpm verify）
 *
 * 覆盖：账本余额计算、报名校验链、退款/取消规则、投票窗口、
 * 状态机迁移、DDL/种子表一致性、双端路由能力名与 shared 声明一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// esbuild 在 CI（pnpm 扁平提升）下位于 packages/shared/node_modules，
// 但本地 pnpm isolated 链接方式会把它放在 .pnpm 里，这里按优先级依次回退。
const ESBUILD_CANDIDATES = [
  path.join(ROOT, 'packages/shared/node_modules/esbuild'),
  path.join(ROOT, 'node_modules/esbuild'),
  'esbuild',
];
const esbuild = (() => {
  for (const candidate of ESBUILD_CANDIDATES) {
    try {
      return require(candidate);
    } catch {
      // 继续尝试下一个位置
    }
  }
  throw new Error('找不到 esbuild：请先在项目根目录执行 pnpm install');
})();

const sharedEntry = path.join(ROOT, 'packages/shared/src/index.ts');
const policyEntry = path.join(ROOT, 'apps/server/src/domain/policy.ts');
const cookieEntry = path.join(ROOT, 'apps/server/src/utils/cookies.ts');
const sessionEntry = path.join(ROOT, 'packages/shared/src/session/index.ts');

const bundle = await esbuild.build({
  stdin: {
    contents: `export * from ${JSON.stringify(sharedEntry)};\nexport * from ${JSON.stringify(policyEntry)};\nexport * from ${JSON.stringify(cookieEntry)};\nexport * from ${JSON.stringify(sessionEntry)};`,
    resolveDir: ROOT,
    sourcefile: 'verify-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  alias: { '@photo/shared': sharedEntry },
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, require);
const S = mod.exports;

// ---- 1) 账本：冻结 / 结算 / 释放 / 入账 / 出账，余额不足一律拒绝 ----
assert.deepEqual(S.computeBalanceAfter('FREEZE', 10000, 50000, 0), { availableCent: 40000, frozenCent: 10000, direction: 'FREEZE' });
assert.equal(S.computeBalanceAfter('FREEZE', 60000, 50000, 0), null);
assert.deepEqual(S.computeBalanceAfter('SETTLE', 10000, 40000, 10000), { availableCent: 40000, frozenCent: 0, direction: 'OUT' });
assert.deepEqual(S.computeBalanceAfter('UNFREEZE', 10000, 40000, 10000), { availableCent: 50000, frozenCent: 0, direction: 'UNFREEZE' });
assert.deepEqual(S.computeBalanceAfter('CREDIT', 5000, 0, 0), { availableCent: 5000, frozenCent: 0, direction: 'IN' });
assert.equal(S.computeBalanceAfter('DEBIT', 1, 0, 0), null);
assert.equal(S.computeBalanceAfter('FREEZE', 0, 10, 0), null);

// ---- 2) 报名校验链顺序：状态 → 可见性 → 余额 → 容量 ----
const now = new Date('2026-11-09T00:00:00.000Z');
const baseEvent = {
  status: 'REGISTRATION_OPEN', visibility: 'VIP',
  registrationOpenAt: '2026-11-01T00:00:00.000Z', registrationCloseAt: '2026-12-14T15:59:59.000Z',
};
const baseSession = {
  status: 'OPEN', startAt: '2026-12-15T07:00:00.000Z', endAt: '2026-12-15T08:00:00.000Z',
  capacity: 2, capacityUsed: 0,
};
const decide = (over = {}) => S.decideRegistration({
  event: { ...baseEvent, ...(over.event ?? {}) },
  session: { ...baseSession, ...(over.session ?? {}) },
  level: over.level ?? 'SVIP',
  priceCent: over.priceCent ?? 10000,
  hasBalance: over.hasBalance ?? true,
  availableCent: over.availableCent ?? 50000,
  now,
});
assert.equal(decide().ok, true);
assert.equal(decide({ event: { status: 'DRAFT' } }).reasonCode, S.BIZ_CODES.EVENT_NOT_OPEN);
assert.equal(decide({ session: { status: 'CLOSED' } }).reasonCode, S.BIZ_CODES.EVENT_NOT_OPEN);
assert.equal(decide({ level: 'NONE' }).reasonCode, S.BIZ_CODES.LEVEL_INSUFFICIENT);
assert.equal(decide({ availableCent: 5000 }).reasonCode, S.BIZ_CODES.BALANCE_INSUFFICIENT);
// 非会员不做余额校验，但等级可见性仍然生效
assert.equal(decide({ level: 'NONE', hasBalance: false, availableCent: 0 }).reasonCode, S.BIZ_CODES.LEVEL_INSUFFICIENT);
assert.equal(decide({ level: 'NONE', hasBalance: false, availableCent: 0, event: { visibility: 'PUBLIC' } }).ok, true);
// 候补已下线：满员一律直接拒绝，不存在任何「进入队列」的分支
assert.equal(decide({ session: { capacityUsed: 2 } }).reasonCode, S.BIZ_CODES.EVENT_FULL);
assert.equal(decide({ session: { capacityUsed: 1 } }).ok, true);
// 会员取价：SVIP 缺档回退 VIP，再回退公开价
assert.equal(S.pickPrice([{ level: 'PUBLIC', priceCent: 18900 }, { level: 'VIP', priceCent: 16900 }], 'SVIP'), 16900);
assert.equal(S.pickPrice([{ level: 'PUBLIC', priceCent: 18900 }], 'VIP'), 18900);

// ---- 3) 取消 / 退款 / 投票规则 ----
assert.equal(S.canCancel(24, '2026-12-20 10:00:00.000', now), true);
assert.equal(S.canCancel(24, '2026-11-09 12:00:00.000', now), false);
assert.equal(S.refundAmountOf(10000, 0), 10000);
assert.equal(S.refundAmountOf(10000, 0.1), 9000);
assert.equal(S.voteWindowOpen('2026-11-01 00:00:00.000', '2026-12-01 00:00:00.000', now), true);
assert.equal(S.voteWindowOpen('2026-12-02 00:00:00.000', '2026-12-05 00:00:00.000', now), false);

// ---- 4) 状态机 ----
assert.equal(S.canTransition(S.REGISTRATION_TRANSITIONS, 'WAITLISTED', 'EXPIRED'), true);
// 候补下线后历史行不得再回到活跃流程
assert.equal(S.canTransition(S.REGISTRATION_TRANSITIONS, 'WAITLISTED', 'OFFERED'), false);
assert.equal(S.canTransition(S.REGISTRATION_TRANSITIONS, 'OFFERED', 'CONFIRMED'), false);
assert.equal(S.canTransition(S.REGISTRATION_TRANSITIONS, 'REFUNDED', 'CONFIRMED'), false);
assert.equal(S.canTransition(S.REFUND_TRANSITIONS, 'REQUESTED', 'APPROVED'), true);
assert.throws(() => S.assertTransition(S.EVENT_TRANSITIONS, 'FINISHED', 'ONGOING'));
assert.equal(S.httpStatusFor(S.BIZ_CODES.LEVEL_INSUFFICIENT), 403);

// ---- 5) DDL ↔ 种子数据一致性 ----
const ddl = read('apps/server/src/migrations/001_init.sql')
  + read('apps/server/src/migrations/002_wechat_sessions_pricing.sql');
const tables = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
assert.equal(tables.length, 20, 'DDL 表数量（001 + 002）');
const seed = read('apps/server/src/seeds/001_seed.sql');
const seedTables = [...new Set([...seed.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]))];
for (const t of seedTables) assert.ok(tables.includes(t), `种子引用了不存在的表: ${t}`);
assert.ok(seed.includes('$2a$12$'), '种子应包含 bcrypt 哈希');

// ---- 6) 双端路由 capability 名称与 shared 声明一致 ----
const declared = new Set(S.CAPABILITIES);
for (const p of ['apps/web/src/router/index.ts', 'apps/admin/src/router/index.ts']) {
  const src = read(p);
  const used = [...src.matchAll(/'([a-z]+:[a-z:+-]+)'/g)].map((m) => m[1]);
  for (const c of used) assert.ok(declared.has(c), `${p} 使用了未声明的 capability: ${c}`);
}

// ---- 7) 登录态与全局错误提示回归（本次修复的两个 bug）----
const webSession = read('apps/web/src/stores/session.ts');
const adminSession = read('apps/admin/src/stores/session.ts');
for (const [name, src] of [['web', webSession], ['admin', adminSession]]) {
  const bodyOf = (fn) =>
    src.match(new RegExp(`function ${fn}\\(\\)[^{]*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
  assert.ok(bodyOf('logout').includes('tokens.clear()'), `${name}: logout 才应清 token`);
  assert.ok(!bodyOf('resetState').includes('tokens.clear()'), `${name}: resetState 不能清 token`);
  assert.ok(src.includes('const reset = resetState;'), `${name}: 旧 reset 调用点须保持安全语义`);
}
for (const p of ['apps/web/src/views/LoginView.vue', 'apps/admin/src/views/LoginView.vue']) {
  const src = read(p);
  assert.ok(src.includes('session.resetState()'), `${p}: 登录后应只重置状态`);
  assert.ok(!src.includes('session.reset();'), `${p}: 不应再调用会清 token 的 reset`);
  assert.ok(src.includes('catch'), `${p}: 登录失败须中断流程`);
}
// 退出登录已从个人中心移到设置页（/settings），断言跟着走
for (const p of ['apps/web/src/views/SettingsView.vue', 'apps/admin/src/layouts/AdminLayout.vue']) {
  assert.ok(read(p).includes('session.logout()'), `${p}: 退出登录须清凭证`);
}
const httpClient = read('packages/shared/src/api/http.ts');
assert.ok(httpClient.includes('onError?: (error: AppError) => void'), 'HttpClientOptions 缺少 onError');
assert.ok(httpClient.includes('options.onError?.(appError)'), '请求失败未触发统一错误钩子');
for (const p of ['apps/web/src/api/index.ts', 'apps/admin/src/api/index.ts']) {
  assert.ok(read(p).includes('onError:'), `${p}: 未注入统一错误提示`);
}
assert.ok(read('apps/web/src/stores/ui.ts').includes('showToast'), '前台提示未用 Vant Toast');
assert.ok(read('apps/admin/src/stores/ui.ts').includes('ElMessage'), '后台提示未用 ElMessage');

// ---- 8) 方案 A：HttpOnly Cookie + 单域名 HTTPS / CSP ----
// Cookie 解析的运行时验证（不依赖 DB）
const fakeReq = { header: (name) => name === 'cookie' ? 'other=1; pc_access=abc%20def; pc_refresh=r1' : undefined };
assert.equal(S.readCookie(fakeReq, 'pc_access'), 'abc def', '应能解析并解码 access cookie');
assert.equal(S.readCookie(fakeReq, 'pc_refresh'), 'r1');
assert.equal(S.readCookie(fakeReq, 'missing'), null);
assert.equal(S.ACCESS_COOKIE, 'pc_access');
assert.equal(S.REFRESH_COOKIE, 'pc_refresh');
const domainTypes = read('packages/shared/src/types/domain.ts');
assert.ok(!domainTypes.includes('accessToken: string'), '登录响应体不应再含 accessToken');
assert.ok(!domainTypes.includes('refreshToken: string'), '刷新响应体不应再含 refreshToken');
const cookieUtil = read('apps/server/src/utils/cookies.ts');
assert.ok(cookieUtil.includes('ACCESS_COOKIE') && cookieUtil.includes('REFRESH_COOKIE'));
const authService = read('apps/server/src/modules/auth/service.ts');
assert.ok(authService.includes('setAuthCookies') && authService.includes('httpOnly: true'));
assert.ok(authService.includes('clearAuthCookies'));
const authGuard = read('apps/server/src/middleware/auth.ts');
assert.ok(authGuard.includes('readCookie(req, ACCESS_COOKIE)'), '认证中间件须读 access cookie');
assert.ok(read('apps/server/src/app.ts').includes('allowedOrigins'), '须有 Origin/CSRF 白名单校验');
for (const p of ['apps/web/src/api/index.ts', 'apps/admin/src/api/index.ts']) {
  const src = read(p);
  assert.ok(src.includes('withCredentials: true'), `${p}: 须携带 Cookie`);
  assert.ok(src.includes('getAccessToken: () => null'), `${p}: 前端不得再注入 Bearer`);
  assert.ok(!src.includes('localStorage.setItem(ACCESS_KEY)'), `${p}: 不得再存 token`);
}
const nginxConf = read('deploy/nginx.conf');
assert.ok(nginxConf.includes('location /admin/'), 'Nginx 须分发后台子路径');
assert.ok(nginxConf.includes('Content-Security-Policy'), 'Nginx 须下发 CSP');
const compose = read('deploy/docker-compose.prod.yml');
assert.ok(compose.includes('CORS_ORIGINS: ${PUBLIC_ORIGIN}'), 'CORS 应指向正式域名');
assert.ok(compose.includes('127.0.0.1:8081:8081'), '8081 应仅绑定本机');
assert.ok(read('deploy/.env.production.example').includes('PUBLIC_ORIGIN=https://www.catpaw.art'));
assert.ok(read('apps/admin/vite.config.ts').includes("base: '/admin/'"), '后台构建 base 须为 /admin/');
assert.ok(read('apps/admin/src/router/index.ts').includes('import.meta.env.BASE_URL'), '后台路由须使用 base');

// ---- 9) 角色与权限边界（超级管理员独占审计/权限日志/导出） ----
const roles = S.BACKEND_ROLES;
assert.ok(roles.includes('ADMIN'), '须新增 ADMIN 角色');
assert.equal(roles.length, 5, '后台角色应为 5 个');
assert.ok(S.CAPABILITIES.includes('admin:permission:log:read'), '须新增权限日志能力');

const capsOfRole = (r) => new Set(S.BACKEND_ROLE_CAPABILITIES[r]);
// 超管独占：只在 SUPER_ADMIN 的能力表里出现
for (const cap of S.SUPER_ADMIN_ONLY_CAPABILITIES) {
  for (const r of roles) {
    if (r === 'SUPER_ADMIN') {
      assert.ok(capsOfRole(r).has(cap), `超管应具备 ${cap}`);
    } else {
      assert.ok(!capsOfRole(r).has(cap), `${r} 不应具备 ${cap}`);
    }
  }
}
// 管理员只管业务：系统区四项（审计/权限日志/导出/系统配置）一律不给
const adminCaps = capsOfRole('ADMIN');
for (const cap of ['admin:audit:read', 'admin:permission:log:read', 'admin:export', 'admin:system:config']) {
  assert.ok(!adminCaps.has(cap), `管理员不应具备系统能力 ${cap}`);
}
assert.ok(capsOfRole('SUPER_ADMIN').has('admin:system:config'), '超管应具备系统配置');
assert.ok(read('apps/admin/src/router/index.ts').includes("capabilities: ['admin:audit:read']"), '系统区菜单须按审计能力收口');
for (const cap of ['admin:membership:grant', 'admin:membership:revoke', 'admin:refund:review',
  'admin:user:reset-password', 'admin:vote:write', 'admin:event:write']) {
  assert.ok(adminCaps.has(cap), `管理员应具备 ${cap}`);
}
// 运营：不碰钱与会员
const opCaps = capsOfRole('OPERATOR');
for (const cap of ['admin:refund:review', 'admin:membership:grant', 'admin:export', 'admin:audit:read']) {
  assert.ok(!opCaps.has(cap), `运营不应具备 ${cap}`);
}
assert.ok(opCaps.has('admin:vote:write'), '运营应能管投票');
// 财务：只管钱，导出已上收
const finCaps = capsOfRole('FINANCE');
assert.ok(finCaps.has('admin:refund:review'), '财务应能审核退款');
assert.ok(!finCaps.has('admin:export'), '财务不应再具备导出');
// 能力合并结果与角色表一致（含多角色并集）
const merged = S.capabilitiesFor({ authenticated: true, level: 'NONE', backendRoles: ['ADMIN', 'SUPER_ADMIN'] });
assert.ok(merged.has('admin:export'), '多角色叠加应取并集');
const capsSvipP = S.capabilitiesFor({ authenticated: true, level: 'SVIP', backendRoles: [] });
assert.ok(capsSvipP.has('vote:cast'), 'SVIP 应有投票能力（前台入口据此显示）');
assert.ok(capsSvipP.has('vote:result:read'), 'SVIP 应能查看投票结果');
const capsVipP = S.capabilitiesFor({ authenticated: true, level: 'VIP', backendRoles: [] });
assert.ok(!capsVipP.has('vote:cast'), 'VIP 不应有投票能力');
assert.ok(!capsVipP.has('vote:result:read'), 'VIP 不应能查看投票结果');
const capsNoneP = S.capabilitiesFor({ authenticated: true, level: 'NONE', backendRoles: [] });
assert.ok(!capsNoneP.has('vote:result:read'), '普通用户不应能查看投票结果');
assert.ok(read('apps/server/src/modules/votes.module.ts').includes("requireCapabilities('vote:result:read')"),
  '投票结果接口须按 vote:result:read 判权');

// ---- 10) 会员导入与本地 Mock 的落地检查 ----
const importModule = read('apps/server/src/modules/member-import.ts');
assert.ok(importModule.includes("requireCapabilities('admin:membership:grant')"), '导入接口须按会员授予能力判权');
assert.ok(importModule.includes('import/preview') && importModule.includes('import/commit'), '须有 preview/commit 两阶段');
assert.ok(importModule.includes('utf8mb4') || importModule.includes('cellDates'), '须处理 Excel 日期');
assert.ok(read('apps/server/src/migrations/001_init.sql').includes('image_url'), '投票选项须有图片列');
for (const p of ['apps/web/vite.config.ts', 'apps/admin/vite.config.ts']) {
  assert.ok(read(p).includes('mockApiPlugin'), `${p}: 须接入 Mock 插件`);
}
assert.ok(read('mock/index.ts').includes("'/api/v1'"), 'Mock 须接管 /api/v1');
assert.ok(read('apps/web/src/views/VoteListView.vue').includes('SVIP'), '前台须有投票列表页');
assert.ok(read('apps/web/src/layouts/WebLayout.vue').includes("session.can('vote:cast')"), '前台导航须按能力显示投票入口');

// ---- 11) 本轮修复回归：场次可恢复、重复取消幂等、超管不进用户列表 ----
assert.ok(S.EVENT_TRANSITIONS.CANCELLED.includes('REGISTRATION_OPEN'), '已取消场次应可恢复为报名中');
assert.ok(!S.ASSIGNABLE_BACKEND_ROLES.includes('SUPER_ADMIN'), '后台不可授予 SUPER_ADMIN');
assert.equal(S.ASSIGNABLE_BACKEND_ROLES.length, 4, '可授予角色应为 4 个');
assert.ok(read('apps/server/src/modules/admin.module.ts').includes("x.role = 'SUPER_ADMIN'"), '用户列表须排除超管');
assert.ok(read('apps/server/src/modules/registrations.module.ts').includes('settled'), '重复取消须幂等');
assert.ok(read('apps/server/src/modules/events.module.ts').includes('/:id/restore'), '须有场次恢复接口');
// 状态迁移的报错必须是中文，不能把枚举漏到界面上
let transitionMsg = '';
try {
  S.assertTransition(S.REGISTRATION_TRANSITIONS, 'REFUND_PENDING', 'REFUND_PENDING');
} catch (e) {
  transitionMsg = e.message;
}
assert.ok(transitionMsg.length > 0, '自迁移应被拒绝');
assert.ok(!/REFUND_PENDING/.test(transitionMsg), `状态迁移报错不得含英文枚举，实际：${transitionMsg}`);
assert.ok(/退款中/.test(transitionMsg), '状态迁移报错应使用中文标签');
assert.equal(S.labelOf('REFUND_PENDING'), '退款中', 'labelOf 须返回中文');
for (const p of ['apps/admin/src/views/RegistrationsView.vue', 'apps/admin/src/views/FinanceView.vue']) {
  assert.ok(!read(p).includes('移动端已做卡片化降级'), `${p}: 不应再写死 PC 端提示`);
  assert.ok(!read(p).includes('slice(0, 10)'), `${p}: 操作按钮不应堆在表格下方`);
}

// ---- 12) 详情页三块图区：场地照片与模特照片，以及模特档案独立建档 ----
const ddl5 = read('apps/server/src/migrations/005_event_venue_model_photos.sql');
assert.ok(ddl5.includes('venue_urls'), '需为场次增加场地照片列');
assert.ok(ddl5.includes('photo_urls'), '需为模特增加照片列');
assert.ok(read('packages/shared/src/schemas/event.ts').includes('venueUrls'), '场次 schema 须含 venueUrls');
assert.ok(read('packages/shared/src/schemas/model.ts').includes('photoUrls'), '模特 schema 须含 photoUrls');
const dtoSrc = read('apps/server/src/domain/dto.ts');
assert.ok(dtoSrc.includes('venueUrls: asUrlArray'), '场次 DTO 须映射场地照片');
assert.ok(dtoSrc.includes('photoUrls: jsonArrayOf'), '模特 DTO 须映射模特照片');
const detailSrc = read('apps/web/src/views/EventDetailView.vue');
for (const t of ['模特照片', '服装照片', '场地照片']) {
  assert.ok(detailSrc.includes(t), `详情页须有「${t}」图区`);
}
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('form.venuePhotos'), '后台须能上传场地照片');
assert.ok(read('apps/admin/src/views/ModelsView.vue').includes('form.photos'), '后台须能上传模特照片');
const ddl4 = read('apps/server/src/migrations/004_model_profile_independent.sql');
assert.ok(ddl4.includes('AUTO_INCREMENT'), '模特档案须有独立自增主键');
assert.ok(ddl4.includes('ADD UNIQUE KEY uk_user_id'), 'user_id 须改为可空唯一');

// ---- 13) 报名时段冲突：服务端拦截 + 前台二次确认 ----
assert.equal(S.BIZ_CODES.SCHEDULE_CONFLICT, 4017, '须有冲突业务码');
assert.equal(S.messageFor(S.BIZ_CODES.SCHEDULE_CONFLICT), '该时段与你已报名的场次时间冲突', '冲突提示须中文');
const regSrc = read('apps/server/src/modules/registrations.module.ts');
assert.ok(regSrc.includes('BIZ_CODES.SCHEDULE_CONFLICT'), '报名创建须检测时段冲突');
assert.ok(/s\.start_at < \? AND s\.end_at > \?/.test(regSrc), '冲突判定须用区间重叠而不是相等');
assert.ok(regSrc.includes('ignoreConflict'), '须支持用户确认后继续报名');
assert.ok(read('apps/web/src/views/EventDetailView.vue').includes('仍要报名'), '前台须有二次确认按钮');
assert.ok(read('apps/web/src/api/index.ts').includes('BIZ_CODES.SCHEDULE_CONFLICT'), '冲突错误不应弹全局 toast');

// ---- 14) 枚举与代码对齐（写入失败类问题的守门断言） ----
const ddl1 = read('apps/server/src/migrations/001_init.sql');
assert.ok(/role\s+ENUM\([^)]*'ADMIN'/.test(ddl1), '001 的 admin_roles.role 必须包含 ADMIN');
const ddl6 = read('apps/server/src/migrations/006_admin_role_enum.sql');
assert.ok(ddl6.includes("'ADMIN'"), '006 迁移须为老库补 ADMIN 枚举值');
assert.equal(S.BACKEND_ROLES.length, 5, '后台角色应为 5 个');
// 流水 biz_type 只能用 DDL 里定义的四种
const importSrc = read('apps/server/src/modules/member-import.ts');
const adminSrc = read('apps/server/src/modules/admin.module.ts');
const ALLOWED_BIZ_TYPES = ['REGISTRATION', 'REFUND', 'MANUAL_ADJUST', 'BONUS'];
for (const [name, src] of [['member-import', importSrc], ['admin.module', adminSrc]]) {
  // 只看 bizType 实参 / biz_type 条件里的字面值；账本操作枚举（op: 'CREDIT' 等）不是 biz_type
  const values = [
    ...src.matchAll(/bizType:\s*'([A-Z_]+)'/g),
    ...src.matchAll(/biz_type\s*=\s*'([A-Z_]+)'/g),
  ].map((m) => m[1]);
  const bad = values.filter((v) => !ALLOWED_BIZ_TYPES.includes(v));
  assert.ok(bad.length === 0, `${name}: 不得写入 DDL 未定义的 biz_type（${bad.join(',')}）`);
}

// 审计动作每个枚举值都必须有中文标签，否则表格里会直接显示英文
const labelSrc = read('apps/admin/src/utils/labels.ts');
const missingLabels = S.AUDIT_ACTIONS.filter((a) => !new RegExp(`\\b${a}:`).test(labelSrc));
assert.equal(missingLabels.length, 0, `以下审计动作缺少中文标签：${missingLabels.join(',')}`);

// validateQuery 会整体覆盖 req.query，筛选参数必须写进 schema，否则静默失效
assert.ok(S.adminUserListQuerySchema.shape.keyword, '用户列表查询 schema 须声明 keyword');
assert.ok(S.adminUserListQuerySchema.shape.level, '用户列表查询 schema 须声明 level');
assert.ok(
  /get\('\/users'[\s\S]{0,160}validateQuery\(adminUserListQuerySchema\)/.test(adminSrc),
  '用户列表路由须用带筛选参数的 schema，不能用 pageQuerySchema',
);
// 模板下载链接必须带 /api/v1 前缀，否则会打开不存在的 SPA 路由（页面空白）
assert.ok(
  /templateUrl:\s*`\$\{API_BASE_PATH\}/.test(read('packages/shared/src/api/client.ts')),
  '模板下载地址须拼上 API_BASE_PATH',
);

// ---- 15) 用户决策落地：邀请码 / 多名额 / 无超管痕迹 / 删模特 visibility / OFFERED 过期 ----
const ddl7 = read('apps/server/src/migrations/007_multi_seat_and_model_visibility.sql');
const ddl8 = read('apps/server/src/migrations/008_invite_codes.sql');
assert.ok(ddl7.includes('DROP INDEX uk_event_user'), '007 须放开一账号多名额');
assert.ok(ddl7.includes('DROP INDEX uk_reg_idempotency_key'), '007 须允许一次请求多条报名共享幂等键');
assert.ok(ddl7.includes('DROP COLUMN visibility'), '007 须移除模特 visibility 列');
assert.ok(ddl8.includes('CREATE TABLE IF NOT EXISTS invite_codes'), '008 须建邀请码表');
assert.ok(ddl8.includes('invite_code_id'), '008 须把邀请码来源写入 users 表');
for (const col of ['source', 'parent_user_id', 'reward_cent']) {
  assert.ok(ddl8.includes(col), `邀请码表须为后期奖励功能预留 ${col}`);
}

assert.equal(S.BIZ_CODES.INVITE_CODE_INVALID, 4018, '须有邀请码无效业务码');
assert.equal(S.messageFor(S.BIZ_CODES.INVITE_CODE_USED), '该邀请码已被使用', '邀请码提示须中文');
const regBase = { wechatId: 'catpaw01', password: 'pass1234', nickname: '测试用户' };
assert.ok(!S.registerSchema.safeParse(regBase).success, '注册必须携带邀请码');
assert.ok(!S.registerSchema.safeParse({ ...regBase, inviteCode: 'catpaw26ab' }).success, '注册必须勾选同意协议');
const regParsed = S.registerSchema.safeParse({ ...regBase, inviteCode: 'catpaw26ab', agreed: true });
assert.ok(regParsed.success, '合法邀请码应通过注册校验');
assert.equal(regParsed.data.inviteCode, 'CATPAW26AB', '邀请码须统一转大写');
const authSvc = read('apps/server/src/modules/auth/service.ts');
assert.ok(authSvc.includes('FOR UPDATE') && authSvc.includes("status = 'UNUSED'"), '邀请码消费须行锁 + 条件 UPDATE');
assert.ok(authSvc.includes('invite_code_id'), '注册须把邀请码 ID 写入 users');
assert.ok(S.CAPABILITIES.includes('admin:invite:read') && S.CAPABILITIES.includes('admin:invite:write'), '须声明邀请码能力');
assert.ok(S.BACKEND_ROLE_CAPABILITIES.ADMIN.includes('admin:invite:write'), '管理员须能生成邀请码');
assert.ok(S.inviteCodeListQuerySchema.shape.status, '邀请码列表筛选参数须写进 schema');
const epSrc = read('packages/shared/src/api/endpoints.ts');
assert.ok(epSrc.includes('inviteCodes:') && epSrc.includes('inviteCodeRevoke:'), '须声明邀请码端点');

assert.equal(S.registrationCreateSchema.parse({ eventId: '1', sessionId: '2' }).seats, 1, '报名默认 1 个名额');
assert.equal(S.registrationCreateSchema.parse({ eventId: '1', sessionId: '2', seats: 3 }).seats, 3, '须支持一次报名多个名额');
assert.ok(!S.registrationCreateSchema.safeParse({ eventId: '1', sessionId: '2', seats: 11 }).success, '单次报名须有上限');
assert.ok(regSrc.includes('for (let i = 0; i < seats; i += 1)'), '报名须在同一事务内循环生成 N 条记录');
assert.ok(regSrc.includes('scopedIdempotencyKey'), '幂等键须按用户隔离');
assert.ok(regSrc.includes('priceCent * seats'), '余额校验须覆盖整批');
const detailWeb = read('apps/web/src/views/EventDetailView.vue');
assert.ok(detailWeb.includes('seats: seats.value'), '前台须提交人数');
assert.ok(detailWeb.includes('submitKey.value'), '前台须复用稳定幂等键');

// 用户可见处不得出现「超级管理员 / 超管」；数据层枚举 SUPER_ADMIN 保留
for (const p of [
  'apps/admin/src/views/LoginView.vue',
  'apps/admin/src/views/MembersView.vue',
  'apps/admin/src/views/GovernanceView.vue',
  'apps/admin/src/router/index.ts',
  'apps/server/src/seeds/001_seed.sql',
  'packages/shared/src/labels.ts',
  'packages/shared/src/roles.ts',
  'mock/data.ts', 'mock/index.ts',
  'deploy/ensure-admin.sh', 'deploy/add-admin-role.sh',
]) {
  assert.ok(!/超级管理员|超管/.test(read(p)), `${p}: 界面与脚本不得出现超管字样`);
}
assert.equal(S.labelOf('SUPER_ADMIN'), '管理员', '运维账号的界面标签须与普通管理员一致');

assert.ok(!S.modelProfileUpsertSchema.shape.visibility, '模特 schema 不得再有 visibility');
const dtoAll = read('apps/server/src/domain/dto.ts');
const modelDtoStart = dtoAll.indexOf('export function modelDtoOf');
const modelDtoEnd = dtoAll.indexOf('export function', modelDtoStart + 10);
const modelDtoSrc = dtoAll.slice(modelDtoStart, modelDtoEnd > 0 ? modelDtoEnd : undefined);
assert.ok(modelDtoStart >= 0 && !modelDtoSrc.includes('visibility'), '模特 DTO 不得再映射 visibility');
assert.ok(dtoAll.includes('visibility: r.visibility'), '场次 DTO 仍须保留 visibility');
assert.ok(read('packages/shared/src/schemas/event.ts').includes('visibilitySchema'), '场次可见性必须保留');

// 候补已整体下线：递补确认、后台指定递补、过期回收、队列序号全部不得残留
assert.ok(!/^  pub\.post\('\/:id\/confirm-offer'/m.test(regSrc), 'confirm-offer 路由不得存在');
assert.ok(!/^  admin\.post\('\/:id\/force-offer'/m.test(regSrc), 'force-offer 路由不得存在');
assert.ok(!regSrc.includes('promoteNextWaitlisted'), '递补提升逻辑须删除');
assert.ok(!regSrc.includes('expireStaleOffers'), '过期递补回收须删除');
assert.ok(!regSrc.includes('WAITLIST_DISABLED'), '候补停用错误码已退役');
assert.ok(!regSrc.includes('nextWaitSeq'), '候补队列序号生成须删除');
assert.ok(!regSrc.includes('wait_seq'), '报名 INSERT 不得再写 wait_seq');
assert.ok(regSrc.includes('if (remaining < seats) {'), '名额不足须直接拒绝，不得再生成候补记录');

/* ---------- 第 16 组：手机号字段已从注册与用户资料移除 ---------- */
const authSchemaSrc = read('packages/shared/src/schemas/auth.ts');
assert.ok(!/phone:\s*phoneSchema/.test(authSchemaSrc), '注册 / 新建 / 编辑用户的 schema 不得再采集手机号');
assert.ok(!/export const phoneSchema/.test(authSchemaSrc), '手机号 schema 已废弃，不应再导出');
assert.ok(!/phoneMasked/.test(read('packages/shared/src/types/domain.ts')), 'UserDto 不得再返回手机号脱敏值');
for (const p of [
  'apps/web/src/views/LoginView.vue',
  'apps/admin/src/views/MembersView.vue',
]) {
  assert.ok(!/手机号/.test(read(p)), `${p}: 界面不得再出现手机号字段`);
}
const authServiceSrc = read('apps/server/src/modules/auth/service.ts');
/** 去掉注释再匹配，避免说明性文字触发误报 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const registerFnStart = authServiceSrc.indexOf('export async function register');
const registerFnSrc = stripComments(authServiceSrc.slice(registerFnStart));
assert.ok(!/phone/.test(registerFnSrc), '注册事务不得再写入手机号');
assert.ok(!/phone/.test(stripComments(read('apps/server/src/modules/admin.module.ts'))),
  '后台新建 / 编辑用户不得再写入手机号');
const memberImportSrc = read('apps/server/src/modules/member-import.ts');
assert.ok(!/phone:/.test(memberImportSrc), 'Excel 导入链路不得再处理手机号');

/* ---------- 第 17 组：会员授予按微信号定位 + 支持金额入账 ---------- */
const grantShape = S.membershipGrantBaseSchema.shape;
assert.ok(grantShape.wechatId, '授予会员须用微信号定位用户');
assert.ok(!grantShape.userId, '授予会员不应再要求 userId');
assert.ok(grantShape.amountYuan !== undefined, '授予会员须支持同步入账金额');
assert.ok(grantShape.expireAt.isOptional(), '授予会员的有效期须可选（不传 = 永久）');
const memSrc = read('apps/server/src/modules/memberships.module.ts');
assert.ok(memSrc.includes('applyLedgerEntry'), '授予会员的入账必须走账本，不得直改余额');
assert.ok(memSrc.includes('MANUAL_ADJUST'), '入账流水须使用 MANUAL_ADJUST 业务类型');

/* ---------- 第 18 组：图片上传不再被 Nginx 体积限制卡死 ---------- */
const nginxSrc = read('deploy/nginx.conf');
assert.ok(/location \/api\/ \{[\s\S]*?client_max_body_size 20m/.test(nginxSrc),
  'location /api/ 须放宽 client_max_body_size，否则图片上传会被 413 拒绝');
const uploadsBlock = (nginxSrc.match(/location \/uploads\/ \{[^}]*\}/) ?? [''])[0];
assert.ok(uploadsBlock.includes('try_files $uri @uploads_via_api'),
  '/uploads/ 须在磁盘直读失败时回退到反代兜底，两条路任一可用即可显示');
assert.ok(!uploadsBlock.includes('proxy_pass'),
  '/uploads/ 不应再走反代，避免反代链不通时页面裂图');
assert.ok(/data\/uploads:\/usr\/share\/nginx\/uploads:ro/.test(read('deploy/docker-compose.prod.yml')),
  'nginx 容器须挂载 uploads 目录以直接提供图片');

/* ---------- 第 19 组：邀请码脚本字符集与乱码修复迁移 ---------- */
const genCodes = read('deploy/gen-invite-codes.sh');
assert.ok(genCodes.includes('--default-character-set=utf8mb4'),
  'gen-invite-codes.sh 须显式指定字符集，否则中文备注会双重编码成乱码');
const fix009 = read('apps/server/src/migrations/009_fix_invite_code_note_mojibake.sql');
const fix010 = read('apps/server/src/migrations/010_refix_invite_code_note.sql');
assert.ok(fix010.includes('invite_codes'), '须有 010 迁移修复已入库的乱码备注');
// 反解方案原理上不可行：原文末字节 0x90 在 cp1252 中未定义，写入时已丢失
assert.ok(!fix010.includes('CONVERT(CAST(CONVERT('), '010 迁移不得再使用已证明不可行的反解 SQL');
assert.ok(fix010.includes('NOT REGEXP'), '010 迁移须用「不含中文」判定乱码');
assert.ok(read('deploy/fix-invite-note.sh').includes('部署脚本生成'),
  '须提供可手动执行的乱码修复脚本');

/* ---------- 第 20 组：图片诊断脚本存在且 nginx 有双路兜底 ---------- */
assert.ok(read('deploy/check-uploads.sh').includes('location /uploads'), '须提供图片链路诊断脚本');
const uploadsBlock2 = (nginxSrc.match(/location \/uploads\/ \{[^}]*\}/) ?? [''])[0];
assert.ok(uploadsBlock2.includes('try_files $uri @uploads_via_api'),
  '/uploads/ 须在磁盘直读失败时回退到反代，两条路任一可用即可显示');
assert.ok(nginxSrc.includes('location @uploads_via_api'), '须定义 /uploads/ 的反代兜底 location');

/* ---------- 第 21 组：编辑场次弹窗回填真实值 + 只提交变更字段（P0-1 / P2-26） ---------- */
const eventsView = read('apps/admin/src/views/EventsView.vue');
// 退款规则不得再写死在提交载荷里（打开即覆盖 = 资损）
assert.ok(!eventsView.includes('refundPolicy: { freeCancelBeforeHours: 24, feeRatio: 0 }'),
  '编辑/新建提交载荷不得写死退款规则，否则打开弹窗不改直接保存会把退款费率清零');
assert.ok(eventsView.includes('refundPolicy: { freeCancelBeforeHours: Number(f.refundFreeHours), feeRatio: Number(f.refundFeeRatio) }'),
  '退款规则须取自表单输入');
// 编辑态须回填库中原值
assert.ok(eventsView.includes('refundFreeHours: e.refundPolicy.freeCancelBeforeHours'), '编辑弹窗须回填免费取消提前量原值');
assert.ok(eventsView.includes('refundFeeRatio: e.refundPolicy.feeRatio'), '编辑弹窗须回填退款费率原值');
// 保存时只提交变更字段（与打开时快照逐字段比对）
assert.ok(eventsView.includes('pristine'), '编辑态须保存打开时的表单快照用于差量比对');
assert.ok(eventsView.includes('JSON.stringify(value) !== JSON.stringify'), '保存须逐字段比对，仅提交变更字段');
// 弹窗须暴露退款规则的编辑入口
assert.ok(eventsView.includes('>退款规则<'), '弹窗须有退款规则编辑区');
// 退款费率须可编辑：已统一到 Element Plus 的 el-input-number，不再用原生 v-model.number
assert.ok(
  eventsView.includes('v-model="form.refundFeeRatio"') || eventsView.includes('v-model.number="form.refundFeeRatio"'),
  '退款费率须可编辑',
);
// 候补已下线：表单、回填、载荷三处都不得再出现候补开关
assert.ok(!eventsView.includes('allowWaitlist'), '候补开关已随功能下线，不得残留在表单/回填/载荷中');
assert.ok(!eventsView.includes('v-model="form.allowWaitlist"'), '候补开关不得再出现');

/* ---------- 第 22 组：调账一步化 + 微信号定位 / 重置密码 / 运营财务不再 3001 ---------- */
// 调账：一步入账，复核能力、端点、路由全部移除
assert.ok(!S.CAPABILITIES.includes('admin:balance:adjust:approve'), '调账已一步化，不应再有复核能力');
assert.ok(!epSrc.includes('balanceAdjustApprove'), '调账复核端点须删除');
assert.ok(!/approveAdjustment/.test(read('packages/shared/src/api/client.ts')), '前端不得再保留复核调账方法');
const adjustSchemaSrc = read('packages/shared/src/schemas/finance.ts');
assert.ok(adjustSchemaSrc.includes('wechatId'), '调账须用微信号定位用户');
assert.ok(!adjustSchemaSrc.includes('userId'), '调账载荷不得再出现 userId');
const balanceSrc = read('apps/server/src/modules/balance.module.ts');
assert.ok(!balanceSrc.includes('/balance/adjustments/:id/approve'), '调账复核路由须删除');
assert.ok(balanceSrc.includes("'APPLIED'"), '调账提交即置为 APPLIED 并入账');
assert.ok(balanceSrc.includes('applyLedgerEntry'), '调账必须走账本，不得直改余额');
assert.ok(balanceSrc.includes('wechat_id'), '调账须按微信号查用户');

// 重置密码：仅 ADMIN / SUPER_ADMIN 有该能力
assert.ok(S.AUDIT_ACTIONS.includes('USER_PASSWORD_RESET'), '重置密码须有审计动作');
assert.equal(S.labelOf('USER_PASSWORD_RESET'), '重置密码', '审计动作须有中文标签');
for (const r of ['ADMIN', 'SUPER_ADMIN']) {
  assert.ok(capsOfRole(r).has('admin:user:reset-password'), `${r} 应能重置密码`);
}
for (const r of ['OPERATOR', 'FINANCE', 'MODEL']) {
  assert.ok(!capsOfRole(r).has('admin:user:reset-password'), `${r} 不应能重置密码`);
}
const adminModuleSrc = read('apps/server/src/modules/admin.module.ts');
assert.ok(adminModuleSrc.includes('/users/reset-password'), '须有重置密码接口');
assert.ok(adminModuleSrc.includes("requireCapabilities('admin:user:reset-password')"), '重置密码接口须按能力判权');
assert.ok(adminModuleSrc.includes('session_version = session_version + 1'), '重置密码须递增 session_version 让旧会话失效');
assert.ok(adminModuleSrc.includes('hashPassword'), '临时密码须经 bcrypt 哈希后入库');
const membersView = read('apps/admin/src/views/MembersView.vue');
assert.ok(membersView.includes("session.can('admin:user:reset-password')"), '用户列表重置密码按钮须按能力显示');
assert.ok(membersView.includes('temporaryPassword'), '临时密码须一次性展示');
// 弹窗写「XXX 的临时密码」时要显示人名，只有账号串认不出是谁
assert.ok(adminModuleSrc.includes("SELECT id, nickname FROM users WHERE wechat_id = ?")
  || adminModuleSrc.includes("sendOk(res, { wechatId: p.wechatId, nickname, temporaryPassword })"),
  '重置密码须回传昵称，弹窗要显示人名');
assert.ok(membersView.includes('personLabel(resetResult.nickname, resetResult.wechatId)'),
  '临时密码弹窗须以昵称显示被打码的账号');

// 运营/财务进概览、模特管理不再 3001：特权接口按能力调用
const dashSrc = read('apps/admin/src/views/DashboardView.vue');
assert.ok(dashSrc.includes("session.can('admin:event:write')"), '概览须按能力调用场次统计');
assert.ok(dashSrc.includes("session.can('admin:registration:write')"), '概览须按能力调用报名统计');
assert.ok(dashSrc.includes("session.can('admin:refund:review')"), '概览须按能力调用退款统计');
const modelsSrc = read('apps/admin/src/views/ModelsView.vue');
assert.ok(modelsSrc.includes("session.can('admin:membership:grant')"), '模特管理须按能力决定是否拉用户列表');
assert.ok(modelsSrc.includes('boundWechatId'), '模特列表须用服务端下发的绑定微信号');
const eventsModuleSrc = read('apps/server/src/modules/events.module.ts');
assert.ok(eventsModuleSrc.includes('LEFT JOIN users u ON u.id = mp.user_id'), '模特后台列表须 join users 带出绑定微信号');
assert.ok(read('apps/server/src/domain/dto.ts').includes('bound_wechat_id'), '模特 DTO 须映射 bound_wechat_id');

/* ---------- 第 23 组：用户端改密 / 导入账号强制改密 / 清库脚本加固 / 导入走账本 / P1 小项 ---------- */
// 契约：改密 schema、端点、DTO 字段、业务码与审计动作
assert.ok(read('packages/shared/src/schemas/auth.ts').includes('changePasswordSchema'), '须有本人改密 schema');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes("password: '/me/password'"),
  '改密端点须放在 /me 下（access token 过期时可走 refresh 重放）');
assert.ok(read('packages/shared/src/types/domain.ts').includes('mustChangePassword'), 'UserDto 须下发 mustChangePassword');
assert.equal(S.BIZ_CODES.PASSWORD_CHANGE_REQUIRED, 2007, '须有强制改密业务码');
assert.equal(S.BIZ_CODE_MESSAGES[S.BIZ_CODES.PASSWORD_CHANGE_REQUIRED], '请先修改初始密码', '强制改密须有中文提示');
assert.ok(S.AUDIT_ACTIONS.includes('USER_PASSWORD_CHANGE'), '本人改密须有审计动作');
assert.equal(S.labelOf('USER_PASSWORD_CHANGE'), '修改密码', '本人改密须有中文标签');

// 迁移：新增 must_change_password，并写明回滚
const ddl11 = read('apps/server/src/migrations/011_force_password_change.sql');
assert.ok(ddl11.includes('must_change_password'), '011 迁移须新增 must_change_password');
assert.ok(ddl11.includes('DROP COLUMN must_change_password'), '011 迁移须写明回滚 SQL');

// 服务端：身份装载 / 强制改密守卫 / 改密接口 / 导入标记
const identitySrc = read('apps/server/src/db/identity.ts');
assert.ok(identitySrc.includes('must_change_password'), '身份装载须读取 must_change_password');
const authMwSrc = read('apps/server/src/middleware/auth.ts');
assert.ok(authMwSrc.includes('PASSWORD_CHANGE_WHITELIST'), '认证中间件须有强制改密白名单');
assert.ok(authMwSrc.includes('PASSWORD_CHANGE_REQUIRED'), '未改密的导入账号调业务接口须被拦截');
const pwdServiceSrc = read('apps/server/src/modules/auth/service.ts');
assert.ok(pwdServiceSrc.includes('export async function changePassword'), '须有本人改密服务');
assert.ok(pwdServiceSrc.includes('must_change_password = 0'), '改密成功须清除强制改密标记');
assert.ok(pwdServiceSrc.includes('USER_PASSWORD_CHANGE'), '改密须写审计日志');
assert.ok(read('apps/server/src/modules/me/routes.ts').includes("'/password'"), '须挂载 POST /me/password');
assert.ok(!importModule.includes('IMPORT_DEFAULT_PASSWORD'), '导入不得再使用共享硬编码初始密码');
assert.ok(importModule.includes('must_change_password'), '导入新建账号须标记强制改密');
assert.ok(importModule.includes('applyLedgerEntry'), '导入余额必须走账本');
assert.ok(!/UPDATE balance_accounts SET available_cent = \?/.test(importModule), '导入不得再直改余额');
assert.ok(importModule.includes('credentials'), '导入结果须按账号返回临时口令');

// 前端：强制改密路由 + 改密页 + 个人中心入口
const webRouterSrc = read('apps/web/src/router/index.ts');
assert.ok(webRouterSrc.includes("path: '/password'"), '前台须有修改密码路由');
assert.ok(webRouterSrc.includes('mustChangePassword'), '路由守卫须拦截未改密的导入账号');
const changePwdView = read('apps/web/src/views/ChangePasswordView.vue');
assert.ok(changePwdView.includes('api.auth.changePassword'), '改密页须调用本人改密接口');
assert.ok(read('apps/web/src/views/SettingsView.vue').includes('to="/password"'), '设置页须有修改密码入口');
assert.ok(read('apps/admin/src/views/MembersView.vue').includes('result.credentials'), '导入结果须展示逐账号临时口令');

// P0-2：清库脚本重命名 + 交互确认 + 自动备份；旧脚本不再存在
assert.ok(!fs.existsSync(path.join(ROOT, 'deploy/reset-test-data.sh')), '危险的 reset-test-data.sh 须已移除');
const purgeScript = read('deploy/purge-business-data.sh');
assert.ok(purgeScript.includes('PURGE photo_club'), '清库脚本须要求手工输入确认串');
assert.ok(purgeScript.includes("if [ ! -t 0 ]"), '清库脚本须拒绝非交互执行');
assert.ok(purgeScript.includes('mysqldump'), '清库前须自动备份');
assert.ok(purgeScript.includes('备份文件为空'), '备份失败须中止清库');

// P0-3 / P1-7：对账方向与账本枚举一致
const ledgerSrc = read('apps/server/src/domain/ledger.ts');
assert.ok(!ledgerSrc.includes("'DEBIT'"), "对账 SQL 不得引用不存在的 'DEBIT' 方向");
assert.ok(ledgerSrc.includes("direction IN ('FREEZE','OUT')"), "对账扣减方向须为 OUT");

// P1 小项
assert.ok(read('apps/web/src/views/LoginView.vue').includes('safeRedirect'), '前台登录 redirect 须做站内白名单');
assert.ok(read('apps/admin/src/views/LoginView.vue').includes('safeRedirect'), '后台登录 redirect 须做站内白名单');
assert.ok(read('apps/web/src/views/SettingsView.vue').includes('退出失败'), '前台登出失败须提示且不清本地态');
assert.ok(read('apps/admin/src/layouts/AdminLayout.vue').includes('退出失败'), '后台登出失败须提示且不清本地态');
for (const p of ['apps/web/src/stores/session.ts', 'apps/admin/src/stores/session.ts']) {
  assert.ok(!/finally\s*\{\s*loaded\.value = true/.test(read(p)), `${p}: hydrate 失败不得置 loaded=true`);
}
assert.ok(read('deploy/ensure-admin.sh').includes("LIKE '%''ADMIN''%'"),
  '管理员自愈脚本须精确匹配 ADMIN 枚举值，不能用 LIKE %ADMIN% 被 SUPER_ADMIN 骗过');
const envSrc = read('apps/server/src/config/env.ts');
assert.ok(envSrc.includes('DEV_ACCESS_SECRET'), '生产环境须识别仓库内的开发默认密钥');
assert.ok(envSrc.includes('不得使用仓库内的开发默认'), '生产环境使用开发默认密钥须拒绝启动');

/* ---------- 第 24 组：退款驳回/重新申请、场次取消退款、协议白名单、限流上限、投票开放、状态回填、补丁校验、实扣金额 ---------- */
// P1-4：驳回退款把名额还回 event_sessions（而非已废弃的 events.capacity_used），并防超卖
// 代拍不占名额，回补时同样要跳过（kind <> 'PROXY'）
assert.ok(balanceSrc.includes("capacity_used = capacity_used + 1 WHERE id = ? AND kind <> 'PROXY' AND capacity_used < capacity"),
  '驳回退款须在容量未满时把名额还回 event_sessions（跳过代拍）');
assert.ok(!balanceSrc.includes('UPDATE events SET capacity_used'),
  '驳回退款不得再改 events.capacity_used（该列无处扣减，会凭空放大名额）');
assert.ok(balanceSrc.includes('BIZ_CODES.EVENT_FULL'), '名额已被占满时驳回须明确报错而不是静默超卖');
// 锁序：先报名单后退款单，与取消/场次取消一致，避免交叉死锁
const regLockAt = balanceSrc.indexOf('FROM registrations WHERE id = ? FOR UPDATE');
const refundLockAt = balanceSrc.indexOf('FROM refund_orders WHERE id = ? FOR UPDATE');
assert.ok(regLockAt > 0 && refundLockAt > regLockAt, '审核退款须先锁报名单再锁退款单，避免与取消流程交叉死锁');

// P1-5：退款单 registration_id 去唯一键，允许驳回后重新申请
const ddl12 = read('apps/server/src/migrations/012_refund_reapply.sql');
assert.ok(ddl12.includes('DROP INDEX uk_registration'), '012 迁移须删除 refund_orders 的 uk_registration 唯一键');
assert.ok(ddl12.includes('ADD KEY idx_registration'), '012 迁移须补普通索引保证按报名单查询');
assert.ok(ddl12.includes('ADD UNIQUE KEY uk_registration'), '012 迁移须写明回滚 SQL');

// P1-6：场次取消对已确认报名全额退款并解冻，不再让资金滞留
assert.ok(eventsModuleSrc.includes('applyLedgerEntry'), '场次取消须走账本退款/解冻');
assert.ok(/op: 'UNFREEZE'/.test(eventsModuleSrc), '场次取消对已冻结余额须 UNFREEZE 全额退回');
assert.ok(eventsModuleSrc.includes('场次取消，全额退款'), '场次取消的退款单须带可读备注');
assert.ok(eventsModuleSrc.includes("status = 'REFUNDED'"), '场次取消须把报名单置为 REFUNDED');
assert.ok(eventsModuleSrc.includes('capacity_used = capacity_used - 1'), '场次取消须释放已确认报名的名额');

// P1-13：社交/作品集链接只允许 http(s)，渲染侧再兜底一次
const modelSchemaSrc = read('packages/shared/src/schemas/model.ts');
assert.ok(modelSchemaSrc.includes('httpUrlSchema'), '社交链接须抽出 http(s) 校验');
assert.ok(modelSchemaSrc.includes('仅支持 http/https 链接'), '非 http(s) 链接须被拒绝');
assert.ok(modelSchemaSrc.includes('portfolioUrl: httpUrlSchema'), '作品集链接同样须限 http(s)');
const detailRound4 = read('apps/web/src/views/EventDetailView.vue');
assert.ok(detailRound4.includes('safeUrl: /^https?:\\/\\//i.test(s.url ?? \'\')'), '前台渲染须对历史脏数据再做一次协议白名单');
assert.ok(detailRound4.includes(':href="s.safeUrl"'), '社交链接须绑定过滤后的地址');

// P1-14：内存限流器有容量上限与 TTL，避免被随机 key 打爆
const limiterSrc = read('apps/server/src/domain/rate-limit.ts');
assert.ok(limiterSrc.includes('DEFAULT_MAX_ENTRIES'), '限流器须有默认容量上限');
assert.ok(limiterSrc.includes('DEFAULT_TTL_MS'), '限流器须有默认过期时间');
assert.ok(limiterSrc.includes('maxEntries') && limiterSrc.includes('ttlMs'), '限流器须支持 maxEntries / ttlMs 配置');
assert.ok(limiterSrc.includes('buckets.size > maxEntries'), '超出容量须淘汰旧桶');

// P1-15：投票草稿开放（后端已有 open，补前端入口）
assert.ok(epSrc.includes('voteOpen'), 'shared 端点须补投票开放');
assert.ok(read('packages/shared/src/api/client.ts').includes('ENDPOINTS.admin.voteOpen(id)'), '客户端须有开放投票方法');
assert.ok(read('apps/admin/src/views/VotesView.vue').includes('开放投票'), '后台投票列表须有开放按钮');
assert.ok(read('apps/server/src/modules/votes.module.ts').includes("status = 'OPEN'"), '服务端开放须把草稿置为 OPEN');
assert.ok(read('mock/index.ts').includes('/open$/.test(path)'), 'mock 须镜像投票开放端点');

// P1-17：biz_type 标签单一来源
assert.ok(!read('apps/admin/src/utils/labels.ts').includes('BIZ_TYPE'), '后台不得再维护本地 biz_type 字典');
assert.ok(read('apps/web/src/views/PointsView.vue').includes('labelOf(t.bizType)'), '前台流水类型须走共享标签');
assert.ok(read('apps/admin/src/views/FinanceView.vue').includes('labelOf(t.bizType)'), '后台流水类型须走共享标签');
assert.ok(!/REGISTRATION.*报名|bizLabel/.test(read('apps/web/src/views/ProfileView.vue')), '前台不得再保留本地类型映射');

// P1-18：用户列表下发真实状态，编辑弹窗回填，避免保存时把冻结用户悄悄解冻
assert.ok(read('packages/shared/src/types/domain.ts').includes("status: 'ACTIVE' | 'FROZEN'"), '用户列表 DTO 须带 status');
assert.ok(adminModuleSrc.includes('u.status'), '用户列表 SQL 须带出 status');
assert.ok(membersView.includes('editForm.status = u.status'), '编辑弹窗须回填真实状态，不得写死 ACTIVE');
assert.ok(!/editForm\.status = 'ACTIVE'/.test(membersView), '编辑弹窗不得写死 ACTIVE');

// P1-20：patchEvent 须合并库中原值再校验时间链，并拒绝被静默忽略的派生字段
assert.ok(eventsModuleSrc.includes('由时段与价格自动推导'), 'patch 传 capacity/feeCent 等派生字段须明确报错');
// 时段与价格必须能分开提交：只想改金额 / 只想改时间都不该被拦
assert.ok(!eventsModuleSrc.includes('修改时段必须同时提交分档价格'), '不得再强制时段与价格一起提交');
assert.ok(eventsModuleSrc.includes('const wantsSessions = Array.isArray(patch.sessions)'),
  'patch 须分别判断是否提交了时段');
assert.ok(eventsModuleSrc.includes('const wantsPrices = Array.isArray(patch.prices)'),
  'patch 须分别判断是否提交了价格');
assert.ok(eventsModuleSrc.includes('syncSessions: wantsSessions, syncPrices: wantsPrices'),
  '只提交一侧时另一侧的表不得被改动');
assert.ok(eventsModuleSrc.includes('if (syncPrices)'), '未提交价格时不得删除 event_prices');
assert.ok(eventsModuleSrc.includes('if (syncSessions)'), '未提交时段时不得删除 event_sessions');
assert.ok(eventsModuleSrc.includes('报名截止不能晚于时段'), 'patch 须用合并后的报名窗口校验时段');
assert.ok(eventsModuleSrc.includes('const chain = patch.sessions'), 'patch 未改时段时须以库中原值参与校验');

// P1-23：成功提示展示服务端实际消耗的积分（已去货币化，页面只出现积分不出现金额）
assert.ok(detailRound4.includes('消耗 ${pts(charged)}'), '登记成功须展示服务端实际消耗积分');
assert.ok(detailRound4.includes('以服务端逐条 feeCent 为准'), '预估值旁须提示以服务端结算为准');

// 本轮：投票可不关联场次 / 流水显示微信号 / 报名列表回填场次名与时段
assert.ok(read('apps/server/src/migrations/013_vote_campaign_optional_event.sql').includes('event_id BIGINT UNSIGNED NULL'),
  '投票须允许不关联场次（event_id 可空）');
assert.ok(read('packages/shared/src/schemas/vote.ts').includes('eventId: idSchema.nullish()'), '投票创建 schema 的 eventId 须可空');
assert.ok(read('apps/server/src/modules/votes.module.ts').includes('p.eventId ?? null'), '新建投票须把未填场次写成 NULL');
assert.ok(!read('apps/admin/src/views/VotesView.vue').includes('关联场次'), '后台新建投票不应再展示关联场次字段');
assert.ok(read('packages/shared/src/schemas/vote.ts').includes('voteImageUrlSchema'), '投票方案图须允许站内上传路径');
assert.ok(!read('packages/shared/src/schemas/vote.ts').includes('z.string().url().max(512)'), '方案图校验不得只接受绝对 URL');
assert.ok(read('packages/shared/src/types/domain.ts').includes('accountWechatId: string | null'), '余额流水 DTO 须带账户微信号');
assert.ok(read('apps/server/src/modules/balance.module.ts').includes('account_wechat_id'), '后台余额流水须 join 出微信号');
assert.ok(read('apps/admin/src/utils/labels.ts').includes('冻结（预扣）'), '流水方向须给出冻结语义说明');
assert.ok(read('apps/server/src/modules/registrations.module.ts').includes('AS event_title'), '报名列表须 join 场次名称');
assert.ok(read('apps/server/src/modules/registrations.module.ts').includes('AS session_label'), '报名列表须 join 时段名称');
assert.ok(read('apps/admin/src/views/RegistrationsView.vue').includes('r.eventTitle'), '后台报名列表须优先展示场次名称');
assert.ok(read('apps/web/src/views/MyRegistrationsView.vue').includes('r.eventTitle'), '用户端报名列表须优先展示场次名称');

// 本轮：场次海报导出（1080×1620 Canvas + 固定二维码配置）
assert.ok(read('apps/server/src/migrations/014_app_settings.sql').includes('poster_qr_url'), '海报二维码须有持久化配置');
assert.ok(read('apps/server/src/modules/index.ts').includes('mountPosterSettings'), '服务端须挂载海报配置路由');
assert.ok(read('apps/server/src/modules/settings.ts').includes("requireCapabilities('admin:event:write')"), '海报配置须校验运营权限');
assert.ok(read('packages/shared/src/schemas/settings.ts').includes('qrImageUrlSchema'), '二维码地址须允许站内上传路径');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes('/admin/settings/poster'), 'shared 端点须含海报配置');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('1080') && read('apps/admin/src/utils/poster.ts').includes('1620'), '海报须为 1080×1620 竖版');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('toBlob'), '海报须导出 PNG 文件');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('wardrobeUrls?.[0]'), '海报须叠加当日服装图');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('venueUrls?.[0]'), '海报须叠加场地照片');
// 标题排版：字号自动下探 + 优先在 ·／空格处断行，避免「猫爪社摄影 / 会·白电波」这种词内断开
assert.ok(read('apps/admin/src/utils/poster.ts').includes('BREAK_TOKENS'), '海报标题须优先在分隔符处断行');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('TITLE_SIZES'), '海报标题字号须可自动下探以容纳完整词组');
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('exportEventPoster'), '场次列表须接入导出海报');
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('海报二维码'), '后台须提供固定二维码配置入口');
assert.ok(read('mock/index.ts').includes('/admin/settings/poster'), 'mock 须镜像海报配置端点');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('site-qr.png'), '海报须叠加内置网站二维码');
assert.ok(read('apps/server/src/modules/settings.ts').includes('mountPublicSettings'), '服务端须提供公开设置路由');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes('/settings/public'), 'shared 端点须含公开设置');
assert.ok(read('packages/shared/src/types/domain.ts').includes('serviceQrUrl'), '公开设置 DTO 须含客服二维码');
assert.ok(read('mock/index.ts').includes("path === '/settings/public'"), 'mock 须镜像公开设置端点');
assert.ok(read('apps/web/src/views/EventDetailView.vue').includes('api.settings.public'), '报名页须拉取客服二维码');
assert.ok(read('apps/web/src/views/EventDetailView.vue').includes('serviceQrUrl'), '报名页须展示客服二维码');
assert.ok(read('packages/shared/src/schemas/settings.ts').includes('siteQrUrl'), '海报配置须支持网站二维码');
assert.ok(read('apps/server/src/modules/settings.ts').includes('site_qr_url'), '网站二维码须持久化到 app_settings');
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('siteQrDraft'), '后台须提供网站二维码上传入口');
assert.ok(read('apps/admin/src/utils/poster.ts').includes('siteQrUrl || SITE_QR_SRC'), '网站二维码未配置时须回退内置默认图');

/* ---------- 第 25 组：场次带报名可编辑 + 新建草稿发布；投票查看/修改/实时明细 ---------- */
// 时段以 id 做 upsert：编辑时改时间/加场/减场不得再删光重插（会孤儿化报名）
const sessionWithId = S.sessionInputSchema.safeParse({
  id: '1', label: '第一场', startAt: '2026-12-01T10:00:00.000Z', endAt: '2026-12-01T11:00:00.000Z', capacity: 4,
});
assert.ok(sessionWithId.success && sessionWithId.data.id === '1', '时段输入须允许带 id 走更新');
assert.ok(S.sessionInputSchema.safeParse({
  label: '第一场', startAt: '2026-12-01T10:00:00.000Z', endAt: '2026-12-01T11:00:00.000Z', capacity: 4,
}).success, '不带 id 的时段须按新增处理');
assert.ok(eventsModuleSrc.includes('async function syncRelations'), '编辑场次须用 syncRelations 按时段 id 增量同步');
const patchBlock = eventsModuleSrc.slice(
  eventsModuleSrc.indexOf('async function patchEvent'),
  eventsModuleSrc.indexOf('export function mountEvents'),
);
assert.ok(/syncRelations\(\s*conn,\s*id,/.test(patchBlock),
  'patchEvent 配了 sessions 时必须走 syncRelations，而不是先删后插');
assert.ok(/syncSessions: wantsSessions, syncPrices: wantsPrices/.test(patchBlock),
  'syncRelations 须按提交情况分别同步时段与价格');
assert.ok(/FROM event_sessions WHERE event_id = \? ORDER BY sort_no ASC[\s\S]*?FOR UPDATE/.test(patchBlock),
  '同步时段前须锁住该场次全部时段，避免与报名写入交叉');
assert.ok(eventsModuleSrc.includes('还有 ${cnt} 人报名，不能删除'), '删除仍有报名的时段须整单拒绝并给出人数');
assert.ok(eventsModuleSrc.includes('容量不能小于 ${used}'), '容量小于已报名人数须拒绝');
assert.ok(eventsModuleSrc.includes('BIZ_CODES.CAPACITY_BELOW_USED'), '容量不足须用专用错误码');
assert.ok(!/该场次已有报名|存在报名.*不能修改/.test(eventsModuleSrc), '不得再因存在报名而整场禁止修改');

// 新建落草稿 + 显式发布；草稿对前台不可见
assert.ok(S.EVENT_TRANSITIONS.DRAFT.includes('REGISTRATION_OPEN'), '草稿发布须能一步进入可报名状态');
assert.ok(S.EVENT_TRANSITIONS.DRAFT.includes('CANCELLED'), '草稿应可取消');
assert.ok(eventsModuleSrc.includes("'DRAFT'"), '新建场次须落 DRAFT');
assert.ok(eventsModuleSrc.includes("admin.post('/:id/publish'"), '须提供草稿发布接口');
assert.ok(eventsModuleSrc.includes("status = 'REGISTRATION_OPEN'"), '发布须直接进入报名中（无定时器会翻 PUBLISHED）');
assert.ok(eventsModuleSrc.includes("status <> 'DRAFT'"), '前台列表/详情/模特场次须过滤草稿');
assert.ok(epSrc.includes('eventPublish'), 'shared 端点须含场次发布');
assert.ok(read('packages/shared/src/api/client.ts').includes('ENDPOINTS.admin.eventPublish(id)'), '客户端须有场次发布方法');
assert.ok(eventsView.includes('场次已保存为草稿'), '新建成功须提示草稿与发布入口');
assert.ok(eventsView.includes('publishEvent'), '后台场次列表须有发布操作');
assert.ok(!eventsView.includes(':disabled="hasRegistrations"'), '不得再按报名人数禁用时段编辑');
assert.ok(eventsView.includes('有报名的时段不能删除'), '编辑弹窗须提示带报名时段的约束');
assert.ok(!eventsView.includes('delete patch.sessions'), '编辑保存不得再跳过时段提交');

// 投票：列表票数/最近投票、修改（有票方案不可删）、实时明细
assert.ok(read('packages/shared/src/types/domain.ts').includes('AdminVoteCampaignDto'), '后台投票列表 DTO 须带票数与最近投票时间');
assert.ok(read('packages/shared/src/types/domain.ts').includes('VoteLiveDto'), '须有实时投票 DTO');
assert.ok(read('packages/shared/src/types/domain.ts').includes('VoteVoterDto'), '实时明细须含投票人');
assert.ok(epSrc.includes('voteLive'), 'shared 端点须含实时投票');
assert.ok(read('packages/shared/src/api/client.ts').includes('ENDPOINTS.admin.voteLive(id)'), '客户端须有实时投票方法');
const votesModuleSrc = read('apps/server/src/modules/votes.module.ts');
assert.ok(votesModuleSrc.includes("admin.get('/:id/live'"), '服务端须有实时投票接口');
assert.ok(votesModuleSrc.includes('wechat_id'), '实时明细须带微信号');
assert.ok(votesModuleSrc.includes('已有 ${cnt} 票，不能删除'), '已有票的方案不得删除');
assert.ok(votesModuleSrc.includes('VOTE_CONFIG_CHANGE'), '投票修改须写审计');
assert.ok(!votesModuleSrc.includes('suppressed: true'), '后台实时数据不做小样本抑制');
const votesViewSrc = read('apps/admin/src/views/VotesView.vue');
assert.ok(votesViewSrc.includes('openEdit'), '投票列表须有修改入口');
assert.ok(votesViewSrc.includes('saveEdit'), '投票修改须可保存');
assert.ok(votesViewSrc.includes('实时投票情况'), '投票列表须有实时情况入口');
assert.ok(votesViewSrc.includes('setInterval'), '实时面板须自动刷新');
assert.ok(votesViewSrc.includes('c.totalVotes'), '列表须展示总票数');
assert.ok(votesViewSrc.includes('live.lastVotedAt'), '实时面板须展示最近投票时间');
assert.ok(votesViewSrc.includes('voters'), '实时面板须展示投票人明细');
assert.ok(read('packages/shared/src/schemas/vote.ts').includes('id: idSchema.optional()'), '投票方案输入须允许带 id 走更新');
assert.ok(read('mock/index.ts').includes('/live$'), 'mock 须镜像实时投票端点');
assert.ok(read('mock/index.ts').includes('票，不能删除'), 'mock 须镜像有票方案不可删规则');

/* ---------- 第 26 组：海报左上角标题可配置（留空回退现有默认文案） ---------- */
const posterSettingsSchema = read('packages/shared/src/schemas/settings.ts');
assert.ok(posterSettingsSchema.includes('brandTitle'), '海报配置 schema 须支持标题');
assert.ok(posterSettingsSchema.includes('海报标题至少 2 个字符'), '标题过短须拒绝');
assert.ok(read('packages/shared/src/types/domain.ts').includes('brandTitle: string | null'), '海报配置 DTO 须下发标题');
const settingsSrc = read('apps/server/src/modules/settings.ts');
assert.ok(settingsSrc.includes('poster_brand_title'), '标题须持久化到 app_settings');
assert.ok(settingsSrc.includes('brandTitle: map.get(BRAND_TITLE_KEY)'), '读取海报配置须带标题');
assert.ok(settingsSrc.includes('writeSetting(BRAND_TITLE_KEY, brandTitle)'), '保存海报配置须写入标题');
const posterSrc = read('apps/admin/src/utils/poster.ts');
assert.ok(posterSrc.includes('export const DEFAULT_BRAND_TITLE'), '海报须有默认标题常量');
assert.ok(posterSrc.includes("CAT'S PAW · 猫爪摄影会"), '默认标题须保持现有文案');
assert.ok(posterSrc.includes('drawBrandBlock(ctx, block, brandTitle)'), '海报须使用配置标题');
assert.ok(posterSrc.includes('brandTitle: string | null = null'), '导出函数须接收标题参数');
assert.ok(eventsView.includes('brandTitleDraft'), '后台须提供标题输入');
assert.ok(eventsView.includes('DEFAULT_BRAND_TITLE'), '后台须提示默认标题');
assert.ok(eventsView.includes('siteQrUrl: siteQrUrl.value'), '导出须传入网站二维码');
assert.ok(read('mock/index.ts').includes('brandTitle: POSTER_SETTINGS.brandTitle'), 'mock 须镜像标题配置');
assert.ok(S.posterSettingsUpdateSchema.safeParse({ qrUrl: null, brandTitle: '我的摄影会' }).success, '合法标题须通过校验');
assert.ok(!S.posterSettingsUpdateSchema.safeParse({ qrUrl: null, brandTitle: '猫' }).success, '单字标题须被拒绝');
assert.ok(S.posterSettingsUpdateSchema.parse({ qrUrl: null, brandTitle: '' }).brandTitle === null, '空标题须归一为默认');

/* ---------- 海报设计器（低代码版式）：拖拽排版 + 版式持久化 ---------- */
const posterLayoutSrc = read('packages/shared/src/schemas/poster.ts');
assert.ok(posterLayoutSrc.includes('POSTER_CANVAS'), '版式须定义 1080×1620 画布常量');
assert.ok(posterLayoutSrc.includes('width: 1080') && posterLayoutSrc.includes('height: 1620'), '画布尺寸须与导出 PNG 一致');
assert.ok(posterLayoutSrc.includes("'stage2'"), '版式须支持第二模特图区块');
assert.ok(posterLayoutSrc.includes("'wardrobe'") && posterLayoutSrc.includes("'venue'"), '版式须含服装与场地区块');
assert.ok(posterLayoutSrc.includes('posterLayoutSchema'), '版式须有 zod schema 统一校验');
assert.ok(posterLayoutSrc.includes('posterPresetOf'), '版式须提供预设（经典/双人/通栏）');
// 预设必须包含服装与场地，否则又会出现「导出没带图和衣服图」
const classicPreset = posterLayoutSrc.slice(
  posterLayoutSrc.indexOf('const CLASSIC'),
  posterLayoutSrc.indexOf('const DUO'),
);
assert.ok(classicPreset.includes("mk('wardrobe'") && classicPreset.includes("mk('venue'"),
  '经典预设须含服装与场地区块');
const duoPreset = posterLayoutSrc.slice(
  posterLayoutSrc.indexOf('const DUO'),
  posterLayoutSrc.indexOf('const COMPACT'),
);
assert.ok(duoPreset.includes("mk('wardrobe'") && duoPreset.includes("mk('venue'"),
  '双人预设也须含服装与场地区块（此前 duo 丢图）');
assert.ok(duoPreset.includes("mk('stage2'"), '双人预设须含第二模特图');
assert.ok(posterLayoutSrc.includes('nextBlockId'), '新增区块须自动分配不冲突 id');

// 持久化：版式单独存一个键，保存设计器不得清掉二维码
const settingsSrc2 = read('apps/server/src/modules/settings.ts');
assert.ok(settingsSrc2.includes('LAYOUT_KEY'), '版式须单独持久化');
assert.ok(settingsSrc2.includes("'poster_layout'"), '版式存储键须为 poster_layout');
assert.ok(settingsSrc2.includes('parseLayout'), '读取版式须容错解析');
assert.ok(settingsSrc2.includes('poster_layout'), '版式须落 app_settings');
assert.ok(settingsSrc2.includes("/layout"), '版式须有独立读写端点，避免覆盖二维码');
assert.ok(read('packages/shared/src/schemas/settings.ts').includes('posterLayoutUpdateSchema'),
  '版式保存须有专用 schema');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes('/admin/settings/poster/layout'),
  'shared 端点须含版式接口');
assert.ok(read('packages/shared/src/api/client.ts').includes('posterLayout'), 'API 客户端须提供版式读写');

// 渲染器：区块化后仍须带上服装 / 场地 / 两枚二维码
const renderSrc = read('apps/admin/src/utils/poster.ts');
assert.ok(renderSrc.includes('renderPoster'), '海报须有统一的区块渲染入口');
assert.ok(renderSrc.includes('wardrobeUrls?.[0]'), '海报须加载当日服装图');
assert.ok(renderSrc.includes('venueUrls?.[0]'), '海报须加载场地照片');
assert.ok(renderSrc.includes("case 'wardrobe'") && renderSrc.includes("case 'venue'"),
  '渲染器须绘制服装与场地区块');
assert.ok(renderSrc.includes("case 'qrSite'"), '渲染器须支持网站二维码区块');
assert.ok(renderSrc.includes('block.imageUrl'), '区块须支持替换图片源');
assert.ok(renderSrc.includes('.filter((b) => b.visible)'), '隐藏区块不得出现在导出图里');
assert.ok(renderSrc.includes('presetLayout'), '导出须能回退到预设版式');

// 设计器交互
const designerSrc = read('apps/admin/src/components/PosterDesigner.vue');
assert.ok(designerSrc.includes('beginDrag'), '设计器须支持拖拽区块');
assert.ok(designerSrc.includes('resize-se') && designerSrc.includes('resize-nw'), '设计器须支持四角缩放');
assert.ok(designerSrc.includes('ArrowLeft'), '设计器须支持方向键微调');
assert.ok(designerSrc.includes('renderPoster'), '设计器预览须复用真实渲染器（所见即所得）');
assert.ok(designerSrc.includes('posterLayoutSchema.safeParse'), '保存前须按同一 schema 自检');
assert.ok(designerSrc.includes('duplicateBlock'), '设计器须支持复制区块');
assert.ok(designerSrc.includes('toFront') && designerSrc.includes('toBack'), '设计器须支持置顶/置底');
assert.ok(designerSrc.includes('addBlock'), '设计器须支持添加区块');
// 画布与热区必须同尺度：高度交给 aspect-ratio，宽度量准，否则框和内容会错位/拉伸
assert.ok(designerSrc.includes('aspect-ratio: 1080 / 1620'), '画布容器须用 aspect-ratio 锁定比例，避免图片被拉伸');
assert.ok(/max-width: calc\(\(100vh - \d+px\) \* 0\.6667\)/.test(designerSrc), '画布须按视口高度限制宽度，保证整张一屏可见');
assert.ok(designerSrc.includes('watch(stageEl'), '须在画布元素出现后测量宽度（v-if 渲染时机）');
assert.ok(designerSrc.includes('if (w > 0) stageW.value = w'), '量到 0 时不得覆盖已有缩放比');
// 预览必须画在模板里那个固定 canvas 上，不能替换 DOM 节点（替换会丢 scoped 样式，导致内容不跟框动）
assert.ok(designerSrc.includes('ctx.drawImage(rendered, 0, 0)'), '预览须把渲染结果画到固定 canvas，而不是更换节点');
assert.ok(!designerSrc.includes('replaceChild'), '不得用 replaceChild 替换预览 canvas');
// 点击层必须与画面一致：热区按 z 排序，跳过的区块不拦截点击
assert.ok(designerSrc.includes('v-for="b in hitOrderBlocks"'), '热区须按 z 顺序渲染（否则点到的和看到的不是同一个）');
assert.ok(designerSrc.includes('const hitOrderBlocks = orderedBlocks'), '热区顺序须等同渲染顺序');
assert.ok(designerSrc.includes('is-skipped'), '本场不绘制的区块须标记为跳过');
assert.ok(designerSrc.includes("'is-skipped': skippedInRender.has(b.id)"), '跳过状态须反映到热区样式上');
assert.ok(designerSrc.includes('skippedInRender'), '须计算「本场不绘制的区块」并禁用其点击');
assert.ok(designerSrc.includes('onDiagnostics'), '渲染器须回报实际跳过的区块，供设计器对齐点击层');
assert.ok(renderSrc.includes('onDiagnostics?.({ skippedIds'), '渲染器须在结束时回报跳过清单');
// 重叠时能选到下层区块
assert.ok(designerSrc.includes('onHotspotClick'), '点击须走统一的选中逻辑');
assert.ok(designerSrc.includes('ev.altKey'), '须支持 Alt+点击在重叠区块间循环选中');
// 拖动对齐辅助线
assert.ok(designerSrc.includes('guides'), '设计器须有对齐辅助线');
assert.ok(designerSrc.includes('collectSnapTargets'), '须收集其它区块的边缘/中线作为吸附目标');
assert.ok(designerSrc.includes('snapAnchors'), '须把区块锚点吸附到参考线');
assert.ok(designerSrc.includes('poster-guide'), '须有辅助线的渲染节点');
assert.ok(designerSrc.includes('guides.value = { vertical: [], horizontal: [] }'), '松手后须清掉辅助线');
assert.ok(eventsView.includes('PosterDesigner'), '场次页须接入海报设计器');
assert.ok(eventsView.includes('openDesigner'), '导出弹窗须提供设计器入口');

// 区块之间不得互相压字：宽高都要参与排版计算
assert.ok(renderSrc.includes('availH'), '标题须按区块可用高度退字号');
assert.ok(renderSrc.includes('const clipped = '), '文字区块须限制在自己的矩形内绘制');
assert.ok(renderSrc.includes("case 'wardrobe': return '当日服装'"), '服装图须带「当日服装」角标');
assert.ok(renderSrc.includes("case 'venue': return '场地照片'"), '场地图须带「场地照片」角标');

/* ---------- 第 27 组：前台场次拆「猫爪 / 玉竹」+ 报名截止只读分组 ---------- */
const webEventsView = read('apps/web/src/views/EventsView.vue');
const webEventCard = read('apps/web/src/components/EventCard.vue');
assert.ok(webEventsView.includes("{ key: 'cat', label: '猫爪'"), '前台须有「猫爪」Tab');
assert.ok(webEventsView.includes("{ key: 'jade', label: '玉竹'"), '前台须有「玉竹」Tab');
assert.ok(webEventsView.includes("e.visibility === 'PUBLIC'"), '猫爪须只含公开场次');
assert.ok(webEventsView.includes("e.visibility !== 'PUBLIC'"), '玉竹须含会员场次（VIP + SVIP）');
assert.ok(webEventsView.includes("session.level !== 'NONE'"), '普通会员不得看到玉竹入口');
assert.ok(!webEventsView.includes('仅对相应会员可见'), '不得再强调会员专属场的可见性');
assert.ok(webEventsView.includes('isRegistrationClosed'), '须按报名截止时间区分场次');
assert.ok(webEventsView.includes('e.registrationCloseAt'), '截止判断须用报名截止时间');
assert.ok(webEventsView.includes('报名已截止'), '报名截止场次须单独分组展示');
assert.ok(webEventsView.includes('仅供查看'), '截止分组须提示只读');
assert.ok(/<EventCard[^>]*:event="event" closed/.test(webEventsView), '截止场次卡片须传 closed 只读标记');
assert.ok(webEventCard.includes('closed?: boolean'), '卡片须支持只读截止态');
assert.ok(webEventCard.includes("closed ? 'div' : 'RouterLink'"), '截止场次整卡不可点击、不进详情');
assert.ok(webEventCard.includes('报名已截止'), '截止场次须展示截止状态而非「查看详情」');

/* ---------- 第 28 组：优惠券（发放/场次开关/逐席核销/退款退券） ---------- */
const couponSchemaSrc = read('packages/shared/src/schemas/coupon.ts');
const couponsModuleSrc = read('apps/server/src/modules/coupons.module.ts');
const migrationsSrc = read('apps/server/src/migrations/015_coupons.sql');
const registrationModuleSrc = read('apps/server/src/modules/registrations.module.ts');
const webEventDetail = read('apps/web/src/views/EventDetailView.vue');
const adminCouponsView = read('apps/admin/src/views/CouponsView.vue');

// 份额：折扣在最终价基础上打，立减不越过原价，可减到 0
// 注意 discountBp 是「实付比例」：85 折 = 8500bp = 实付 85%，减免额 = 18900 × 15% = 2835
// （曾把 18900 × 85% = 16065 当成减免额，导致 8 折券只收原价 20%）
assert.equal(S.couponDiscountOf({ type: 'DISCOUNT', discountBp: 8500 }, 18900), 2835, '折扣券须按最终价打 85 折（返回减免额）');
assert.equal(S.couponDiscountOf({ type: 'DISCOUNT', discountBp: 8500, maxDiscountCent: 2000 }, 18900), 2000, '折扣券须受封顶限制');
assert.equal(S.couponDiscountOf({ type: 'DISCOUNT', discountBp: 10000 }, 18900), 0, '10 折即无减免');
assert.equal(S.couponDiscountOf({ type: 'DISCOUNT', discountBp: 8000 }, 14900), 2980, '8 折：149 积分应减 29.8');
assert.equal(S.couponDiscountOf({ type: 'AMOUNT', amountCent: 5000 }, 3000), 3000, '立减券不得超过原价');
assert.equal(S.couponDiscountOf({ type: 'AMOUNT', amountCent: 5000 }, 5000), 5000, '立减可减到 0 元');

// 发券契约：类型互斥、门槛/封顶可留空、批量 1–50
const oneCoupon = {
  wechatIds: ['svip_catpaw'], title: '全场 85 折', type: 'DISCOUNT', discountBp: 8500,
};
assert.ok(S.adminCouponIssueSchema.safeParse(oneCoupon).success, '合法折扣券须通过校验');
assert.ok(!S.adminCouponIssueSchema.safeParse({ ...oneCoupon, amountCent: 1000 }).success, '折扣券不得同时填立减金额');
assert.ok(!S.adminCouponIssueSchema.safeParse({ ...oneCoupon, type: 'AMOUNT' }).success, '立减券不得带折扣比例');
assert.ok(!S.adminCouponIssueSchema.safeParse({ ...oneCoupon, wechatIds: [] }).success, '发券微信号不得为空');
assert.ok(!S.adminCouponIssueSchema.safeParse({ ...oneCoupon, title: '券' }).success, '券名过短须拒绝');
assert.ok(S.adminCouponIssueSchema.safeParse({
  wechatIds: ['a', 'b'], title: '满 150 减 50', type: 'AMOUNT', amountCent: 5000, minSpendCent: 15000,
}).success, '立减券 + 门槛须通过校验');

// 报名契约：券数不得多于名额；未选券默认空数组
const regSeats = (over) => S.registrationCreateSchema.safeParse({ eventId: '1', sessionId: '11', seats: 1, ...over });
assert.ok(regSeats({ couponIds: [] }).success, '不选券须可提交');
assert.ok(!regSeats({ seats: 2, couponIds: ['1', '2', '3'] }).success, '券数超过名额须拒绝');
assert.ok(!regSeats({ couponIds: ['1', '1'] }).success, '重复券须拒绝');

// 服务端：开关、逐席占用、条件核销、退款/取消退券、动态过期
assert.ok(couponsModuleSrc.includes("mine.get('/'"), '须提供我的优惠券接口');
assert.ok(couponsModuleSrc.includes('releaseCouponOf'), '须提供退券方法');
assert.ok(couponsModuleSrc.includes('expires_at <= NOW(3)'), '过期须按时间动态判定');
assert.ok(couponSchemaSrc.includes('优惠券数量不能超过报名名额数') || read('packages/shared/src/schemas/event.ts').includes('优惠券数量不能超过报名名额数'), '券数与名额须双向校验');
assert.ok(registrationModuleSrc.includes('if (!event.allow_coupon) throw new AppError(BIZ_CODES.COUPON_NOT_ALLOWED)'), '场次关券须拦新报名');
assert.ok(registrationModuleSrc.includes('FOR UPDATE'), '取券须加行锁防并发重复核销');
assert.ok(/UPDATE coupons SET status = 'USED'[\s\S]*?AND status = 'UNUSED'/.test(registrationModuleSrc), '核销须带状态条件更新');
assert.ok(registrationModuleSrc.includes('original_fee_cent'), '报名须记录原价用于展示折扣');
assert.ok(read('apps/server/src/modules/balance.module.ts').includes('await releaseCouponOf(conn, String(reg.id))'), '退款通过后须退券');
assert.ok(read('apps/server/src/modules/events.module.ts').includes('await releaseCouponOf(conn, regId)'), '场次取消须退券');
assert.ok(S.BIZ_CODES.COUPON_INVALID === 4022 && S.BIZ_CODES.COUPON_NOT_ALLOWED === 4023, '券错误码须稳定');
assert.ok(S.COUPON_STATUSES.includes('EXPIRED') && !S.COUPON_STATUSES.includes('USED_UP'), '券状态枚举须含动态过期');

// 迁移与回滚
assert.ok(migrationsSrc.includes('CREATE TABLE IF NOT EXISTS coupons'), '须新建 coupons 表');
assert.ok(migrationsSrc.includes('allow_coupon TINYINT(1) NOT NULL DEFAULT 1'), '场次须有券开关且默认允许');
assert.ok(migrationsSrc.includes('original_fee_cent') && migrationsSrc.includes('discount_cent'), '报名须落原价与折扣快照');
assert.ok(migrationsSrc.includes('回滚'), '迁移须写明回滚思路');

// 双端界面
assert.ok(webEventDetail.includes('api.coupons.mine()'), '报名弹窗须加载我的优惠券');
assert.ok(webEventDetail.includes('每个名额只能用 1 张券') || webEventDetail.includes('每个名额仅可使用 1 张优惠券'), '须提示一名额一张券');
assert.ok(webEventDetail.includes('本场次不可使用优惠券'), '场次关券须在前台提示');
assert.ok(webEventDetail.includes('基准积分') && webEventDetail.includes('本次消耗'), '确认弹窗须拆分基准积分与券后消耗');
assert.ok(read('apps/web/src/views/ProfileView.vue').includes('我的优惠券'), '个人中心须可查看优惠券');
assert.ok(read('apps/web/src/views/MyRegistrationsView.vue').includes('discountCent'), '我的报名须展示折后信息');
assert.ok(eventsView.includes('allowCoupon'), '后台场次编辑须有券开关');
assert.ok(adminCouponsView.includes('生成') || adminCouponsView.includes('发放'), '后台须可发券');
assert.ok(adminCouponsView.includes('DISCOUNT') && adminCouponsView.includes('AMOUNT'), '后台须支持折扣券与立减券');
assert.ok(read('apps/admin/src/router/index.ts').includes("path: 'coupons'"), '后台须有优惠券路由');
assert.ok(read('apps/admin/src/views/RegistrationsView.vue').includes('originalFeeCent'), '后台报名列表须展示原价与折扣');
assert.ok(read('mock/index.ts').includes("path === '/me/coupons'"), 'mock 须镜像我的优惠券');
assert.ok(read('mock/index.ts').includes("path === '/admin/coupons'"), 'mock 须镜像后台优惠券接口');
assert.ok(read('mock/index.ts').includes('allowCoupon === false'), 'mock 报名须校验场次券开关');
assert.ok(read('mock/data.ts').includes('allowCoupon: true'), 'mock 场次须带券开关');

// ---- 30) 积分化与协议同意留痕 ----
// 1 积分 = 1 元；账本仍按分存储，展示换算不得丢精度
assert.equal(S.CENT_PER_POINT, 100, '1 积分须等于 1 元');
assert.equal(S.pointsOf(29800), 298, '298 元须显示为 298 积分');
assert.equal(S.formatPoints(24850), '248.5', '非整数积分须保留小数');
assert.equal(S.pointsToCent(248.5), 24850, '积分录入须准确换算回分');
assert.equal(S.messageFor(S.BIZ_CODES.BALANCE_INSUFFICIENT), '积分不足', '余额不足提示须改为积分不足');

const legalSrc = read('packages/shared/src/legal.ts');
assert.ok(/LEGAL_VERSION = '\d{4}-\d{2}-\d{2}'/.test(legalSrc), '须定义协议版本号');
assert.ok(!S.consentAcceptSchema.safeParse({}).success, '同意接口须拒绝空请求');
assert.ok(S.consentAcceptSchema.safeParse({ agreed: true }).success, '同意接口须接受明确勾选');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes('consents:'), '须声明同意状态端点');

const consentMigration = read('apps/server/src/migrations/016_user_consents.sql');
assert.ok(consentMigration.includes('CREATE TABLE IF NOT EXISTS user_consents'), '须新建同意留痕表');
assert.ok(consentMigration.includes('UNIQUE KEY uk_user_type_version'), '同一版本同意须唯一');
assert.ok(consentMigration.includes('回滚'), '迁移须写明回滚思路');
assert.ok(read('apps/server/src/modules/index.ts').includes('mountConsents(app)'), '同意模块须挂载');
const consentsModuleSrc = read('apps/server/src/modules/consents.module.ts');
assert.ok(consentsModuleSrc.includes('/me/consents') && consentsModuleSrc.includes('validateBody(consentAcceptSchema)'), '同意接口须校验明确勾选');
const authSvcSrc = read('apps/server/src/modules/auth/service.ts');
assert.ok(authSvcSrc.includes('INSERT IGNORE INTO user_consents'), '注册须写入同意留痕');

assert.ok(read('apps/web/src/router/index.ts').includes("path: '/terms'") && read('apps/web/src/router/index.ts').includes("path: '/privacy'"), '前台须有协议与隐私页路由');
assert.ok(read('apps/web/src/views/LoginView.vue').includes('agreed'), '注册须有同意勾选');
assert.ok(read('apps/web/src/components/ConsentGate.vue').includes('api.consents.accept()'), '存量用户须能补勾同意');
assert.ok(read('apps/web/src/layouts/WebLayout.vue').includes('湘ICP备2026012181号-2'), '页脚须展示备案号');
assert.ok(read('apps/web/index.html').includes('noindex'), '前台须禁止搜索引擎收录');
assert.ok(read('apps/web/public/robots.txt').includes('Disallow: /'), 'robots 须全站禁止收录');
assert.ok(read('apps/admin/src/utils/labels.ts').includes("BALANCE_ADJUST: '积分调账'"), '后台审计文案须改为积分');
assert.ok(read('mock/index.ts').includes("path === '/me/consents'"), 'mock 须镜像同意接口');
assert.ok(read('mock/index.ts').includes("body.agreed !== true"), 'mock 注册须校验同意勾选');

/* ---------- 第 31 组：注册入口隐藏、未登录导航、退款场次回填、权限日志对象 ---------- */
const loginSrc = read('apps/web/src/views/LoginView.vue');
assert.ok(loginSrc.includes('const SHOW_REGISTER = false'), '注册入口须暂时隐藏');
assert.ok(loginSrc.includes('v-if="SHOW_REGISTER"'), '登录/注册切换须受开关控制');
assert.ok(loginSrc.includes('账号由管理员开通'), '登录页须提示账号由管理员开通');

const layoutSrc = read('apps/web/src/layouts/WebLayout.vue');
assert.ok(layoutSrc.includes('if (!session.user) return base'), '未登录不得展示我的报名与个人中心');

assert.ok(/interface RefundOrderDto[\s\S]*?eventTitle: string \| null/.test(read('packages/shared/src/types/domain.ts')),
  '退款单契约须回填场次名称');
assert.ok(balanceSrc.includes('LEFT JOIN registrations reg ON reg.id = r.registration_id'),
  '后台退款列表须 join 报名 / 场次');
assert.ok(balanceSrc.includes('s.label AS session_label'), '后台退款列表须带出时段名称');
assert.ok(read('apps/admin/src/views/FinanceView.vue').includes('r.eventTitle'), '退款审核列表须展示场次');

const permDtoSrc = read('apps/server/src/domain/dto.ts');
assert.ok(/permissionLogDtoOf[\s\S]*?targetType: 'user'[\s\S]*?target_user_id/.test(permDtoSrc),
  '权限日志须回填对象，避免列表显示 undefined');

/* ---------- 第 32 组：手动录入 + 后台易用性 ---------- */
// 手动录入已与自助登记对齐：名额、优惠券、扣积分/线下收款/免费由运营显式指定
const manualOk = S.adminRegistrationCreateSchema.safeParse({
  wechatId: 'u1_catpaw', eventId: '1', sessionId: '2',
});
assert.ok(manualOk.success && manualOk.data.settleMode === 'OFFLINE_UNPAID',
  '手动录入默认「线下待收」');
assert.ok(manualOk.data.seats === 1 && Array.isArray(manualOk.data.couponIds),
  '手动录入默认 1 个名额、不使用优惠券');
assert.ok(!S.adminRegistrationCreateSchema.safeParse({ eventId: '1', sessionId: '2' }).success, '手动录入须填微信号');
assert.ok(
  !S.adminRegistrationCreateSchema.safeParse({
    wechatId: 'u1_catpaw', eventId: '1', sessionId: '2', settleMode: 'NOT_REQUIRED',
  }).success,
  '结算方式只允许 CREDIT / OFFLINE_PAID / OFFLINE_UNPAID / FREE',
);
assert.ok(
  !S.adminRegistrationCreateSchema.safeParse({
    wechatId: 'u1_catpaw', eventId: '1', sessionId: '2', seats: 1, couponIds: ['c1', 'c2'],
  }).success,
  '优惠券数量不得超过名额数',
);
assert.ok(
  !S.adminRegistrationCreateSchema.safeParse({
    wechatId: 'u1_catpaw', eventId: '1', sessionId: '2', seats: 2, couponIds: ['c1', 'c1'],
  }).success,
  '同一张券不得重复使用',
);

const regModuleSrc = read('apps/server/src/modules/registrations.module.ts');
assert.ok(regModuleSrc.includes("admin.post('/', validateBody(adminRegistrationCreateSchema)"), '须提供后台手动录入接口');
assert.ok(regModuleSrc.includes("admin.get('/lookup'"), '须提供微信号校验接口，运营无需会员管理权限');
assert.ok(regModuleSrc.includes("action: 'REGISTRATION_MANUAL_CREATE'"), '手动录入须写审计日志');
assert.ok(regModuleSrc.includes('capacity_used + ? <= capacity'), '手动录入须按名额数原子校验余量，避免超卖');
assert.ok(regModuleSrc.includes('effectiveLevel('), '手动录入须按账号当前有效等级取价');
// 与自助登记同一套券校验：归属/状态/过期/门槛
const manualFnSrc = regModuleSrc.slice(
  regModuleSrc.indexOf('async function createManualRegistration'),
  regModuleSrc.indexOf('export function mountRegistrations'),
);
assert.ok(manualFnSrc.includes('couponDiscountOf'), '手动录入须用与自助登记相同的券折扣算法');
assert.ok(manualFnSrc.includes("coupon.status !== 'UNUSED'"), '手动录入须校验券状态');
assert.ok(manualFnSrc.includes('min_spend_cent'), '手动录入须校验券门槛');
assert.ok(manualFnSrc.includes('allow_coupon'), '手动录入须遵守场次的「允许用券」开关');
assert.ok(manualFnSrc.includes("op: 'FREEZE'"), '选「扣积分」时须走账本冻结，与自助登记同链路');
assert.ok(manualFnSrc.includes('BALANCE_INSUFFICIENT'), '扣积分前须校验余额');
assert.ok(manualFnSrc.includes('MAX_SEATS_PER_EVENT'), '手动录入须遵守同一场次名额上限');
assert.ok(manualFnSrc.includes("'MANUAL'"), '手动录入须显式写 source=MANUAL');
// 弹窗用选人下拉的返回值判断余额，少这个字段会员会被误判成「无积分账户」
assert.ok(
  regModuleSrc.includes('availableCent: balanceOf.get') && regModuleSrc.includes('availableCent: balRows[0]'),
  '选人与 lookup 两端都必须返回可用积分，否则手动录入会误判余额不足',
);
assert.ok(
  read('apps/admin/src/views/RegistrationsView.vue').includes('refreshLookup'),
  '选人后须再查一次权威账号信息，不能只信下拉缓存',
);

const regViewSrc = read('apps/admin/src/views/RegistrationsView.vue');
assert.ok(regViewSrc.includes('api.admin.registrations.create'), '报名管理须接入手动录入');
assert.ok(regViewSrc.includes('手动录入报名') && regViewSrc.includes('UserPicker'), '手动录入须有入口与下拉选人');
assert.ok(regViewSrc.includes("paymentFilter = 'UNPAID'"), '报名管理须支持待收款快捷筛选');
assert.ok(read('apps/admin/src/views/DashboardView.vue').includes("'/registrations?pay=UNPAID'"), '概览待收款须直达筛选结果');
assert.ok(read('apps/admin/src/views/DashboardView.vue').includes("'/finance?tab=refunds'"), '概览待审核退款须直达退款页签');
assert.ok(read('apps/admin/src/views/FinanceView.vue').includes("route.query.tab"), '财务页须支持页签深链');
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('>报名名单<'), '场次行操作须写明「报名名单」');
assert.ok(read('apps/admin/src/views/GovernanceView.vue').includes("label: '报名记录'"), '脱敏导出须用中文对象名');

assert.ok(read('mock/index.ts').includes("path === '/admin/registrations/lookup'"), 'mock 须镜像微信号校验');
assert.ok(read('mock/index.ts').includes("path === '/admin/registrations' && method === 'POST'"), 'mock 须镜像手动录入');

/* ---------- 第 33 组：后台整体优化（审计筛选 / 操作人回填 / 表格折行） ---------- */
const auditQueryOk = S.auditLogQuerySchema.safeParse({ action: 'USER_PASSWORD_RESET', keyword: 'admin' });
assert.ok(auditQueryOk.success && auditQueryOk.data.page === 1 && auditQueryOk.data.pageSize === 20,
  '审计日志查询须支持 action / keyword 且保留分页默认值');
assert.ok(!S.auditLogQuerySchema.safeParse({ action: 'x'.repeat(65) }).success, '审计日志动作筛选须限长');

assert.ok(read('packages/shared/src/types/domain.ts').includes('actorWechatId: string | null'),
  '审计日志契约须回填操作人微信号');
assert.ok(adminModuleSrc.includes('u.wechat_id AS actor_wechat_id'), '审计 / 权限日志须 join 出操作人微信号');
assert.ok(adminModuleSrc.includes('LEFT JOIN users t ON t.id = p.target_user_id'), '权限日志须 join 出对象微信号');
assert.ok(adminModuleSrc.includes('auditLogQuerySchema'), '两条日志路由须使用扩展后的查询 schema');
assert.ok(read('mock/index.ts').includes('actorWechatId'), 'mock 日志须回填操作人微信号');

const adminCss = read('apps/admin/src/style.css');
assert.ok(adminCss.includes('.clamp-1') && adminCss.includes('.clamp-2'),
  '后台表格使用的 clamp 工具类必须有定义，否则标题换行撑高行高');
assert.ok(read('apps/admin/src/views/FinanceView.vue').includes('refundKeyword')
  && read('apps/admin/src/views/FinanceView.vue').includes('txnKeyword'), '财务退款与流水须支持关键词筛选');
assert.ok(read('apps/admin/src/views/GovernanceView.vue').includes('auditAction'), '治理页须支持按动作筛选审计日志');
assert.ok(read('apps/admin/src/views/VotesView.vue').includes('visibleVoters'), '投票实时明细须支持投票人过滤');
assert.ok(read('apps/admin/src/views/EventsView.vue').includes("route.query.new === '1'"), '概览「新建场次」须直接打开弹窗');

/* ---------- 第 34 组：下拉选人 / 表单默认值 / 时段名额可视化 / 筛选导出 ---------- */
const optQueryOk = S.adminUserOptionsQuerySchema.safeParse({ keyword: 'vip', limit: '50' });
assert.ok(optQueryOk.success && optQueryOk.data.limit === 50, '选人选项查询须支持 keyword/limit 且 coerce 数字');
assert.ok(!S.adminUserOptionsQuerySchema.safeParse({ limit: 51 }).success, '选人选项须限上限，避免一次拉全表');
assert.ok(S.adminRegistrationListQuerySchema.safeParse({ eventId: '1', sessionId: '2' }).success, '报名列表查询须声明 sessionId 筛选');
assert.ok(read('packages/shared/src/schemas/event.ts').includes('freeCancelBeforeHours: 48'), '新建场次默认免费取消须为 48 小时');

const eventsViewSrc = read('apps/admin/src/views/EventsView.vue');
assert.ok(eventsViewSrc.includes("venue: '咕咕摄影棚'") && eventsViewSrc.includes('refundFreeHours: 48'), '场次表单默认须为咕咕摄影棚 / 48 小时');
assert.ok(eventsViewSrc.includes('例：猫爪社摄影会·犬了个牙') && eventsViewSrc.includes('例：仪玄OL') && eventsViewSrc.includes('例：咕咕摄影棚'), '标题/副标题/场地示例须用新文案');
assert.ok(eventsViewSrc.includes('名额/名单') && eventsViewSrc.includes('查看名单') && eventsViewSrc.includes('已满'), '场次管理须可视化时段名额与名单');
assert.ok(regViewSrc.includes('时段名额：') && regViewSrc.includes('sessionFilter'), '报名管理须有时段占用条与时段筛选');
assert.ok(regViewSrc.includes('导出筛选结果') && regViewSrc.includes('\\uFEFF'), '报名管理须导出筛选结果（CSV 带 BOM）');
assert.ok(read('apps/admin/src/views/CouponsView.vue').includes('UserPicker') && read('apps/admin/src/views/CouponsView.vue').includes('multiple'), '发券对象须改为下拉多选');
/**
 * 选人选项端点必须存在，且**不能**只挂在对 admin:registration:write 有硬要求的 admin 组上。
 * 财务要用它发起积分调账，但财务没有报名写权限，所以该端点需走「任一能力」的独立 router。
 */
assert.ok(
  regModuleSrc.includes("picker.get('/users'") || regModuleSrc.includes("admin.get('/users'"),
  '须提供选人选项端点，运营无需会员管理权限',
);
assert.ok(
  regModuleSrc.includes('requireAnyCapability') && regModuleSrc.includes("'admin:balance:adjust:request'"),
  '选人选项端点须放宽给财务（调账选人），否则财务下拉列表为空',
);
assert.ok(regModuleSrc.includes('session_capacity_used'), '报名列表须回填时段容量，供余位/已满展示');
assert.ok(read('mock/index.ts').includes("path === '/admin/registrations/users'"), 'mock 须镜像选人选项端点');
assert.ok(read('packages/shared/src/api/client.ts').includes('userOptions'), 'client 须提供选人选项方法');

/* ---------- 第 35 组：赠送积分（赠金）——单一余额 + BONUS 标记 ---------- */
// 契约：调账 / 授予 / 录入 / 导入四处入口都能带赠送，且各有边界
assert.ok(S.BALANCE_BIZ_TYPES.includes('BONUS'), 'biz_type 枚举须含 BONUS');
assert.equal(S.labelOf('BONUS'), '赠送积分', 'BONUS 须有中文标签「赠送积分」');

const adjustOk = S.balanceAdjustmentSchema.safeParse({ wechatId: 'catpaw01', amountCent: 10000, bonusCent: 2000, reason: '充值赠送' });
assert.ok(adjustOk.success, '调账应接受随充值的赠送积分');
assert.ok(!S.balanceAdjustmentSchema.safeParse({ wechatId: 'catpaw01', amountCent: -5000, bonusCent: 2000, reason: '退款扣减' }).success, '赠送只能随正数充值，扣减不得带赠送');
assert.ok(!S.balanceAdjustmentSchema.safeParse({ wechatId: 'catpaw01', amountCent: 10000, bonusCent: -1, reason: '充值赠送' }).success, '赠送积分不能为负');

const grantOk = S.membershipGrantSchema.safeParse({ wechatId: 'catpaw01', level: 'VIP', startAt: '2026-11-01T00:00:00.000Z', amountYuan: 500, bonusYuan: 100, reason: '授予会员' });
assert.ok(grantOk.success, '授予会员应接受赠送积分');
assert.ok(S.membershipGrantBaseSchema.shape.bonusYuan, '授予 schema 须声明 bonusYuan');

const createOk = S.adminCreateUserSchema.safeParse({ wechatId: 'catpaw01', nickname: '测试用户', password: 'pass1234', level: 'VIP', balanceYuan: 500, bonusYuan: 100 });
assert.ok(createOk.success, '录入用户应接受赠送积分');
assert.ok(!S.adminCreateUserSchema.safeParse({ wechatId: 'catpaw01', nickname: '测试用户', password: 'pass1234', level: 'NONE', bonusYuan: 100 }).success, '普通用户不得带赠送积分');

const importRowBase = { row: 2, wechatId: 'catpaw01', nickname: '测试用户', level: 'VIP', expireAt: null, balanceCent: 50000, remark: null, status: 'OK', messages: [], exists: false, existingUserId: null };
assert.ok(S.memberImportRowSchema.safeParse({ ...importRowBase, bonusCent: 10000 }).success, '导入行应接受赠送积分列');
assert.ok(!S.memberImportRowSchema.safeParse({ ...importRowBase, bonusCent: -1 }).success, '导入赠送积分不能为负');

// DTO 契约：累计赠送为派生值（不新增账户列）
assert.ok(read('packages/shared/src/types/domain.ts').includes('bonusGrantedCent'), '余额账户 / 用户列表 DTO 须含 bonusGrantedCent');
assert.ok(read('packages/shared/src/types/imports.ts').includes('bonusCent'), '导入行 DTO 须含 bonusCent');

// 迁移 017：ENUM 末尾追加 BONUS + balance_adjustments.bonus_cent + 回滚先平账再删结构
const ddl17 = read('apps/server/src/migrations/017_bonus_points.sql');
assert.ok(/MODIFY biz_type ENUM\('REGISTRATION','REFUND','MANUAL_ADJUST','BONUS'\)/.test(ddl17), '017 须在 biz_type ENUM 末尾追加 BONUS');
assert.ok(ddl17.includes('ADD COLUMN bonus_cent'), '017 须为 balance_adjustments 增加 bonus_cent');
assert.ok(ddl17.includes('回滚') && ddl17.includes("DELETE FROM balance_transactions WHERE biz_type='BONUS'") && ddl17.includes('DROP COLUMN bonus_cent'), '017 须给出先平账再删结构的回滚步骤');

// 服务端四处入口都要落 BONUS 流水；累计赠送由 BONUS IN 求和派生，不改对账
const balanceSrc35 = read('apps/server/src/modules/balance.module.ts');
const membersSrc35 = read('apps/server/src/modules/memberships.module.ts');
for (const [name, src] of [['balance', balanceSrc35], ['admin', adminSrc], ['memberships', membersSrc35], ['member-import', importSrc]]) {
  assert.ok(src.includes("'BONUS'"), `${name} 须写入 BONUS 流水`);
}
assert.ok(balanceSrc35.includes("t.biz_type = 'BONUS' AND t.direction = 'IN'") && balanceSrc35.includes('bonus_granted_cent'), 'GET /balance 须由 BONUS IN 求和派生累计赠送');
assert.ok(balanceSrc35.includes('`bonus:${id}`'), '调账赠送须用独立幂等键 bonus:${id}，避免与本金唯一键冲突');
assert.ok(adminSrc.includes("biz_type = 'BONUS' AND direction = 'IN'") && adminSrc.includes('bonusGrantedCent'), '用户列表须派生累计赠送');
assert.ok(read('apps/server/src/domain/dto.ts').includes('bonusGrantedCent: Number(r.bonus_granted_cent'), 'dto 须映射 bonus_granted_cent → bonusGrantedCent');

// 双端界面：调账/授予/录入赠送输入、列表累计赠送、财务按业务筛选、前台 chip、驾驶舱统计
const financeView35 = read('apps/admin/src/views/FinanceView.vue');
assert.ok(financeView35.includes('bonusPoints') && financeView35.includes('bonusCent:'), '财务调账须有赠送输入并提交 bonusCent');
assert.ok(financeView35.includes('txnBizType') && financeView35.includes('BALANCE_BIZ_TYPES'), '财务流水须支持按业务类型（含赠送）筛选');
const membersView35 = read('apps/admin/src/views/MembersView.vue');
assert.ok(membersView35.includes('bonusYuan') && membersView35.includes('累计赠送'), '用户管理须有授予/录入赠送输入与累计赠送列');
assert.ok(read('apps/admin/src/views/CockpitView.vue').includes('bonusGrantedTotal'), '驾驶舱须统计会员累计赠送');
// 累计赠送随积分明细一起移到 /points 页
const pointsView35 = read('apps/web/src/views/PointsView.vue');
assert.ok(pointsView35.includes('bonusGrantedCent') && pointsView35.includes('累计赠送'), '积分明细页须展示累计赠送');

// Mock 须镜像赠送：账户派生值、BONUS 流水、录入与导入列
const mockIndex35 = read('mock/index.ts');
assert.ok(mockIndex35.includes('bonusGrantedCent') && mockIndex35.includes("bizType: 'BONUS'"), 'mock 须镜像累计赠送与 BONUS 流水');
assert.ok(mockIndex35.includes('bonusYuan'), 'mock 录入用户须接受赠送');
assert.ok(mockIndex35.includes('赠送积分'), 'mock 导入模板/预览须含赠送积分列');
assert.ok(read('mock/data.ts').includes('bonusCent'), 'mock 账户/导入演示数据须含赠送');

/* ---------- 第 36 组：报名来源（线上/线下）+ 退款渠道按支付方式而非会员等级 ---------- */
// 契约：报名来源枚举与标签；退款单带出支付状态，用于区分「积分回充 / 线下退款」
assert.ok(S.REGISTRATION_SOURCES.includes('ONLINE') && S.REGISTRATION_SOURCES.includes('MANUAL'), '报名来源枚举须含 ONLINE/MANUAL');
assert.equal(S.labelOf('ONLINE'), '线上报名', 'ONLINE 须有中文标签「线上报名」');
assert.equal(S.labelOf('MANUAL'), '线下录入', 'MANUAL 须有中文标签「线下录入」');
const domain36 = read('packages/shared/src/types/domain.ts');
assert.ok(/source: RegistrationSource;/.test(domain36), 'RegistrationDto 须含 source');
assert.ok(/paymentStatus: PaymentStatus \| null;/.test(domain36), 'RefundOrderDto 须含 paymentStatus（可空，用户端未 join 报名）');

// 迁移 018：registrations.source 默认 ONLINE + 回滚直接删列（纯展示列，无资金/状态语义）
const ddl18 = read('apps/server/src/migrations/018_registration_source.sql');
assert.ok(/ADD COLUMN source ENUM\('ONLINE','MANUAL'\) NOT NULL DEFAULT 'ONLINE'/.test(ddl18), '018 须为 registrations 增加 source 列，默认 ONLINE');
assert.ok(ddl18.includes('AFTER payment_status'), '018 source 列应紧随 payment_status');
assert.ok(ddl18.includes('回滚') && ddl18.includes('DROP COLUMN source'), '018 须给出删列回滚思路');

// 服务端：dto 映射来源与退款支付状态；退款列表 join 报名支付状态；手动录入写 MANUAL；资金路由仍看 payment_status
const dto36 = read('apps/server/src/domain/dto.ts');
assert.ok(dto36.includes("source: (r.source ?? 'ONLINE')"), 'registrationDtoOf 须映射 source 并兜底 ONLINE');
assert.ok(dto36.includes('paymentStatus: r.reg_payment_status'), 'refundDtoOf 须映射 reg_payment_status → paymentStatus');
const balance36 = read('apps/server/src/modules/balance.module.ts');
assert.ok(balance36.includes('reg.payment_status AS reg_payment_status'), '退款审核列表须 join 报名支付状态');
assert.ok(balance36.includes("const fromBalance = reg.payment_status === 'NOT_REQUIRED'"), '退款资金路由须仍按 payment_status（NOT_REQUIRED 才回充），不得按会员等级');
const reg36 = read('apps/server/src/modules/registrations.module.ts');
assert.ok(
  /payment_status, source\b/.test(reg36) && /'MANUAL'/.test(reg36),
  '手动录入 INSERT 须显式写 source=MANUAL',
);
assert.ok(!reg36.includes('wait_seq'), '报名 INSERT 不得再写已删除的 wait_seq 列');

// 后台：来源徽标 + 取消/审核文案按支付方式分支，移除「会员…立即回充」写死口径
const adminLabels36 = read('apps/admin/src/utils/labels.ts');
assert.ok(adminLabels36.includes('REGISTRATION_SOURCE') && adminLabels36.includes('线上报名') && adminLabels36.includes('线下录入'), '后台须有来源徽标配色表');
const regView36 = read('apps/admin/src/views/RegistrationsView.vue');
assert.ok(regView36.includes('metaOf(REGISTRATION_SOURCE, r.source)'), '报名列表须渲染来源徽标');
assert.ok(regView36.includes("r.paymentStatus === 'NOT_REQUIRED'") && !regView36.includes('会员会自动生成退款单'), '取消文案须按支付方式分支，移除写死的「会员会自动生成退款单」');
assert.ok(regView36.includes("'来源'"), '报名导出须含来源列');
const finView36 = read('apps/admin/src/views/FinanceView.vue');
assert.ok(finView36.includes("order.paymentStatus === 'NOT_REQUIRED'") && !finView36.includes('会员积分会立即回充，非会员需线下退款'), '退款审核文案须按支付方式分支，移除写死的「会员积分会立即回充」');
assert.ok(finView36.includes('refundChannel') && finView36.includes('积分回充') && finView36.includes('线下退款'), '退款列表须标识退款方式（积分回充/线下退款）');
assert.ok(finView36.includes('已通过，请线下退款'), '线下支付退款通过后的 notify 不得宣称回充积分');

// Mock 镜像：报名来源、退款支付状态、线上/录入两条创建路径
const mockData36 = read('mock/data.ts');
assert.ok(mockData36.includes("source: 'MANUAL'") && mockData36.includes("source: 'ONLINE'"), 'mock 报名须含线上/线下来源');
assert.ok(mockData36.includes("paymentStatus: 'UNPAID'") && mockData36.includes("paymentStatus: 'NOT_REQUIRED'"), 'mock 退款须含线下/积分两种支付状态');
const mockIndex36 = read('mock/index.ts');
assert.ok(mockIndex36.includes("source: 'MANUAL' as const") && mockIndex36.includes("source: 'ONLINE' as const"), 'mock 手动录入写 MANUAL、线上报名写 ONLINE');

/* ---------- 第 37 组：点1 投票页移动端图片完整显示 + 点击放大灯箱 ---------- */
const voteViewSrc = read('apps/web/src/views/VoteView.vue');
// 选项图 object-contain 完整显示（不裁剪）+ 固定 4:3 容器，移动端不塌高
assert.ok(voteViewSrc.includes('object-contain'), '投票选项图须 object-contain 完整显示，不得裁剪');
assert.ok(voteViewSrc.includes('aspect-[4/3]'), '投票选项图须有固定宽高比容器，移动端不塌高');
// 放大镜按钮独立放大，@click.stop 不触发整卡选择
assert.ok(voteViewSrc.includes('zoomOption') && voteViewSrc.includes('@click.stop="zoomOption(o.id)"'), '投票图须有独立放大按钮且不干扰选择');
assert.ok(voteViewSrc.includes('import ImageLightbox from'), '投票页须接入图片灯箱');
const lightboxSrc = read('apps/web/src/components/ImageLightbox.vue');
// Teleport 到 body + 高层级，避免被父级 overflow 裁剪（移动端「展示不全」根因）
assert.ok(lightboxSrc.includes('<Teleport to="body">') && lightboxSrc.includes('z-[200]'), '灯箱须 Teleport 到 body 且层级高于页面');
assert.ok(lightboxSrc.includes('onTouchStart') && lightboxSrc.includes('onTouchMove') && lightboxSrc.includes('onTouchEnd'), '灯箱须支持触屏手势（左右切换/下滑关闭）');
assert.ok(lightboxSrc.includes('toggleZoom') && lightboxSrc.includes('max-h-full max-w-full'), '灯箱须能切换原始大小/适应屏幕');

/* ---------- 第 38 组：点2 人工分批报名门槛 registerMinLevel（与 visibility 正交） ---------- */
assert.equal(S.BIZ_CODES.REGISTRATION_LEVEL_GATE, 4024, '须有报名门槛业务码');
assert.equal(S.messageFor(S.BIZ_CODES.REGISTRATION_LEVEL_GATE), '当前报名尚未开放到你的会员等级', '门槛提示须中文');
assert.equal(S.httpStatusFor(S.BIZ_CODES.REGISTRATION_LEVEL_GATE), 409, '门槛属业务状态冲突 → 409');
// 校验链：可见性 → 门槛 → 余额 → 容量；门槛=SVIP 时 VIP 看得到却报不了
assert.equal(decide({ event: { registerMinLevel: 'SVIP' }, level: 'VIP' }).reasonCode, S.BIZ_CODES.REGISTRATION_LEVEL_GATE);
assert.equal(decide({ event: { registerMinLevel: 'SVIP' }, level: 'SVIP' }).ok, true);
assert.equal(decide({ event: { registerMinLevel: 'VIP' }, level: 'VIP' }).ok, true);
// 门槛在可见性之后：visibility=SVIP 时 VIP 先被可见性拦截（不是门槛）
assert.equal(decide({ event: { visibility: 'SVIP', registerMinLevel: 'SVIP' }, level: 'VIP' }).reasonCode, S.BIZ_CODES.LEVEL_INSUFFICIENT);
// 门槛在余额/容量之前：即便余额为 0 / 已满，也先报门槛
assert.equal(decide({ event: { registerMinLevel: 'SVIP' }, level: 'VIP', availableCent: 0 }).reasonCode, S.BIZ_CODES.REGISTRATION_LEVEL_GATE);
assert.equal(decide({ event: { registerMinLevel: 'SVIP' }, level: 'VIP', session: { capacityUsed: 2 } }).reasonCode, S.BIZ_CODES.REGISTRATION_LEVEL_GATE);
// 正交关键：PUBLIC 场次普通用户看得到，但门槛=VIP 时报不了
assert.equal(decide({ event: { visibility: 'PUBLIC', registerMinLevel: 'VIP' }, level: 'NONE', hasBalance: false, availableCent: 0 }).reasonCode, S.BIZ_CODES.REGISTRATION_LEVEL_GATE);
// 默认 NONE：所有人可报，与改造前一致
assert.equal(decide({ event: { visibility: 'PUBLIC', registerMinLevel: 'NONE' }, level: 'NONE', hasBalance: false, availableCent: 0 }).ok, true);

const eventSchemaSrc = read('packages/shared/src/schemas/event.ts');
assert.ok(eventSchemaSrc.includes("registerMinLevel: z.enum(MEMBER_LEVELS).default('NONE')"), '场次 schema 须含 registerMinLevel 且默认 NONE');
const ddl19 = read('apps/server/src/migrations/019_event_register_min_level.sql');
assert.ok(/ADD COLUMN register_min_level ENUM\('NONE','VIP','SVIP'\) NOT NULL DEFAULT 'NONE'/.test(ddl19), '019 须为 events 增加 register_min_level，默认 NONE');
assert.ok(ddl19.includes('AFTER visibility'), '019 门槛列应紧随 visibility');
assert.ok(ddl19.includes('回滚') && ddl19.includes('DROP COLUMN register_min_level'), '019 须给出删列回滚思路');
const policySrc = read('apps/server/src/domain/policy.ts');
assert.ok(policySrc.includes("satisfiesLevel(level, event.registerMinLevel ?? 'NONE')"), '门槛判定须沿用等级继承 satisfiesLevel');
assert.ok(eventsModuleSrc.includes('register_min_level') && eventsModuleSrc.includes('registerMinLevel'), '场次读写须落 register_min_level');
assert.ok(regModuleSrc.includes('registerMinLevel: event.register_min_level'), '报名创建须把门槛传入校验链');
const eventsView38 = read('apps/admin/src/views/EventsView.vue');
assert.ok(eventsView38.includes('v-model="form.registerMinLevel"'), '后台场次表单须有门槛下拉');
assert.ok(eventsView38.includes('仅 SVIP') && eventsView38.includes('VIP 及以上'), '门槛下拉须含 SVIP/VIP/所有人三档');
const detailView38 = read('apps/web/src/views/EventDetailView.vue');
assert.ok(detailView38.includes('gateBlocked') && detailView38.includes('BIZ_CODES.REGISTRATION_LEVEL_GATE'), '前台详情须按门槛业务码显示拦截');
assert.ok(detailView38.includes('本场登记尚未开放到你的会员等级'), '前台须有门槛提示文案');
const mockIndex38 = read('mock/index.ts');
assert.ok(mockIndex38.includes('registerGateReason') && mockIndex38.includes('BIZ_CODES.REGISTRATION_LEVEL_GATE'), 'mock 须镜像报名门槛');

/* ---------- 第 39 组：点3 模特身高/三围录入 + 仅会员可见 + 报名/投票双页弹窗 ---------- */
assert.ok(modelSchemaSrc.includes('heightCm') && modelSchemaSrc.includes('measurements'), '模特 schema 须含身高与三围');
assert.ok(S.modelProfileUpsertSchema.safeParse({ stageName: '测试模特', heightCm: 168, measurements: { bustCm: 86, waistCm: 60, hipCm: 88 } }).success, '模特录入应接受身高/三围');
assert.ok(!S.modelProfileUpsertSchema.safeParse({ stageName: 'x', heightCm: 999 }).success, '身高须限合理范围');
assert.ok(!S.modelProfileUpsertSchema.safeParse({ stageName: 'x', measurements: { bustCm: 999 } }).success, '三围须限合理范围');
const domain39 = read('packages/shared/src/types/domain.ts');
assert.ok(domain39.includes('ModelMeasurements') && domain39.includes('heightCm'), '模特契约须含身高/三围类型');
// 身体数据列早已存在于 001，点3 无需新迁移；服务端按 includeBody 收口
assert.ok(ddl1.includes('height_cm') && ddl1.includes('measurements_json'), '001 须已有身高/三围列（点3 无需新迁移）');
const dto39 = read('apps/server/src/domain/dto.ts');
assert.ok(/modelDtoOf\(r: RowDataPacket, includeBody = false\)/.test(dto39), 'modelDtoOf 须默认不输出身体数据（安全兜底）');
assert.ok(dto39.includes('includeBody && r.height_cm != null') && dto39.includes('includeBody ? measurementsOf'), '身高/三围须受 includeBody 控制');
assert.ok(eventsModuleSrc.includes("satisfiesLevel(currentLevel(), 'VIP')"), '公开端身体数据须仅 VIP/SVIP 可见');
assert.ok(eventsModuleSrc.includes('height_cm') && eventsModuleSrc.includes('measurements_json'), '模特写入须落身高/三围列');
const modelsView39 = read('apps/admin/src/views/ModelsView.vue');
assert.ok(modelsView39.includes('form.heightCm') && modelsView39.includes('form.bustCm') && modelsView39.includes('form.waistCm') && modelsView39.includes('form.hipCm'), '后台须能录入身高/三围');
assert.ok(modelsView39.includes("String(v ?? '').trim()"), '身高/三围须先 String 再 trim（type=number 的 v-model 会被转成 number）');
assert.ok(modelsView39.includes('仅 VIP / SVIP 会员在前台可见'), '后台须提示身体数据仅会员可见');
const dialog39 = read('apps/web/src/components/ModelInfoDialog.vue');
assert.ok(dialog39.includes('canViewBody') && dialog39.includes('<div v-if="canViewBody">'), '弹窗须按会员身份展示数据，非会员整块隐藏（点D）');
assert.ok(!dialog39.includes('身高、三围等详细资料仅会员可见'), '弹窗不得再有「仅会员可见」锁定诱导提示（点D）');
assert.ok(dialog39.includes('z-[150]'), '弹窗层级须低于灯箱 z-200');
assert.ok(detailView38.includes('ModelInfoDialog') && detailView38.includes('查看资料'), '报名详情页须能查看模特资料');
assert.ok(voteViewSrc.includes('ModelInfoDialog') && voteViewSrc.includes('campaign.value?.model'), '投票页须带出直接关联的模特资料（点C）');
const mockIndex39 = read('mock/index.ts');
assert.ok(mockIndex39.includes('publicEventOf') && mockIndex39.includes('heightCm: null, measurements: null'), 'mock 须对非会员置空身高/三围');
assert.ok(read('mock/data.ts').includes('measurements'), 'mock 模特演示数据须含三围');

/* ---------- 第 40 组：点4 场景库（一个场地多个场景）+ 场次下拉自动带出、保留自由文本 ---------- */
assert.ok(S.sceneUpsertSchema.safeParse({ venue: '如懿映画', name: '办公室景', address: '上海市徐汇区', photoUrls: ['/posters/a.jpg'], capacity: 8 }).success, '场景录入应接受场地/名称/地址/照片/容量');
assert.ok(!S.sceneUpsertSchema.safeParse({ venue: '', name: 'x' }).success, '所属场地必填');
assert.ok(!S.sceneUpsertSchema.safeParse({ venue: 'v', name: '' }).success, '场景名称必填');
assert.ok(!S.sceneUpsertSchema.safeParse({ venue: 'v', name: 'x', capacity: 0 }).success, '容纳人数须 >= 1');
assert.equal(S.sceneUpsertSchema.safeParse({ venue: 'v', name: 'x' }).data.photoUrls.length, 0, '照片默认空数组');
const ddl20 = read('apps/server/src/migrations/020_scenes.sql');
assert.ok(ddl20.includes('CREATE TABLE IF NOT EXISTS scenes'), '020 须建场景库表');
assert.ok(ddl20.includes('ADD COLUMN scene_id'), '020 须为 events 增加 scene_id 引用');
assert.ok(ddl20.includes('回滚') && ddl20.includes('DROP TABLE IF EXISTS scenes') && ddl20.includes('DROP COLUMN scene_id'), '020 须给出先摘引用再删表的回滚');
// 点4 扩展：场景增加所属场地 venue（一个场地多个场景），旧数据归入默认场地
const ddl21 = read('apps/server/src/migrations/021_scene_venue.sql');
assert.ok(ddl21.includes('ADD COLUMN venue') && ddl21.includes("DEFAULT '默认场地'"), '021 须为 scenes 增加 venue 且存量归入默认场地');
assert.ok(ddl21.includes('回滚') && ddl21.includes('DROP COLUMN venue'), '021 须给出删字段回滚');
assert.ok(S.CAPABILITIES.includes('admin:scene:write'), '须声明场景写入能力');
for (const r of ['OPERATOR', 'ADMIN', 'SUPER_ADMIN']) assert.ok(capsOfRole(r).has('admin:scene:write'), `${r} 应具备场景写入`);
for (const r of ['FINANCE', 'MODEL']) assert.ok(!capsOfRole(r).has('admin:scene:write'), `${r} 不应具备场景写入`);
assert.ok(read('apps/server/src/modules/index.ts').includes('mountScenes(app)'), '场景模块须挂载');
const scenesModuleSrc = read('apps/server/src/modules/scenes.module.ts');
assert.ok(scenesModuleSrc.includes("requireCapabilities('admin:scene:write')"), '场景接口须按能力判权');
assert.ok(scenesModuleSrc.includes('/options') && scenesModuleSrc.includes('sceneUpsertSchema'), '场景须提供下拉选项与写入校验');
assert.ok(scenesModuleSrc.includes('INSERT INTO scenes (venue, name') && scenesModuleSrc.includes('venue = COALESCE(?, venue)'), '场景写入须落 venue 列');
assert.ok(dto39.includes('sceneDtoOf') && dto39.includes('venue: r.venue'), 'dto 须有场景映射并带出 venue');
const labels40 = read('apps/admin/src/utils/labels.ts');
assert.ok(labels40.includes('SCENE_UPSERT:') && labels40.includes('SCENE_DELETE:'), '场景审计动作须有中文标签');
const scenesView40 = read('apps/admin/src/views/ScenesView.vue');
assert.ok(scenesView40.includes('api.admin.scenes'), '后台须有场景管理页');
assert.ok(scenesView40.includes('form.venue') && scenesView40.includes('groupedScenes') && scenesView40.includes('所属场地'), '后台须能录入所属场地并按场地分组');
assert.ok(scenesView40.includes("String(form.capacity ?? '').trim()"), '场景容量须先 String 再 trim（type=number 的 v-model 会被转成 number）');
const adminRouter40 = read('apps/admin/src/router/index.ts');
assert.ok(adminRouter40.includes("path: 'scenes'") && adminRouter40.includes("capabilities: ['admin:scene:write']"), '后台须有场景路由并按能力收口');
assert.ok(eventsView38.includes('v-model="form.sceneId"') && eventsView38.includes('@change="onSceneChange"'), '场次表单须有场景下拉并触发自动带出');
assert.ok(eventsView38.includes('form.venue = s.venue') && eventsView38.includes('form.scene = s.name') && eventsView38.includes('form.venuePhotos = [...s.photoUrls]'), '选场景须带出场地名/场景名/照片，且保留自由文本');
assert.ok(eventsView38.includes('optgroup') && eventsView38.includes('sceneGroups'), '场次场景下拉须按场地分组');
assert.ok(read('packages/shared/src/api/client.ts').includes('scenes:'), 'client 须提供场景方法');
assert.ok(read('packages/shared/src/api/endpoints.ts').includes('scenes'), '须声明场景端点');
const mockIndex40 = read('mock/index.ts');
assert.ok(mockIndex40.includes("'/admin/scenes/options'") && mockIndex40.includes('MOCK_SCENES'), 'mock 须镜像场景库');
assert.ok(mockIndex40.includes("venue: String(body.venue ?? '默认场地')"), 'mock 新建场景须带所属场地');
assert.ok(read('mock/data.ts').includes('export const SCENES') && read('mock/data.ts').includes("venue: '如懿映画'"), 'mock 须有按场地分组的场景演示数据');

/* ---------- 第 41 组：点5 会话延长 access 8h / refresh 30d + 无操作到期提示 + 主动续期 ---------- */
assert.equal(S.ACCESS_TOKEN_TTL_SECONDS, 8 * 3600, 'access 时效须为 8 小时');
assert.equal(S.REFRESH_TOKEN_TTL_DAYS, 30, 'refresh 时效须为 30 天');
assert.equal(S.SESSION_IDLE_WARN_SECONDS, 7 * 3600, '无操作告警阈值须为 7 小时');
assert.equal(S.SESSION_IDLE_GRACE_SECONDS, 10 * 60, '告警后宽限期须为 10 分钟');
// 纯状态机：假时钟确定性验证 active → warned → expired，以及主动续期/保持登录
{
  let clock = 0;
  const calls = { refresh: 0, warn: 0, keepAlive: 0, logout: 0, warnSeconds: -1 };
  const tk = S.createIdleTracker({
    now: () => clock, refreshIntervalMs: 1000, warnAfterMs: 5000, graceMs: 2000,
    onRefresh: () => { calls.refresh += 1; },
    onWarn: (s) => { calls.warn += 1; calls.warnSeconds = s; },
    onKeepAlive: () => { calls.keepAlive += 1; },
    onLogout: () => { calls.logout += 1; },
  });
  assert.equal(tk.phase, 'active');
  clock = 1000; tk.tick();
  assert.equal(calls.refresh, 1, '活跃满一个间隔须主动续期一次');
  assert.equal(tk.phase, 'active');
  clock = 5000; tk.tick();
  assert.equal(tk.phase, 'warned', '无操作达阈值须进入告警');
  assert.equal(calls.warnSeconds, 2, '告警剩余秒数须等于宽限期');
  clock = 5500; tk.activity();
  assert.equal(tk.phase, 'active', '告警期间用户操作须回到活跃');
  assert.equal(calls.keepAlive, 1, '回到活跃须触发收起提示回调');
  tk.keepAlive();
  assert.equal(calls.refresh, 2, '显式保持登录须立即续期');
  clock = 12500; tk.tick();
  assert.equal(tk.phase, 'expired', '宽限期结束仍无操作须登出');
  assert.equal(calls.logout, 1);
  tk.activity(); tk.tick();
  assert.equal(calls.logout, 1, 'expired 为终态，不再重复登出');
}
// 忽略告警 → 倒计时递减 → 到期登出
{
  let c = 0; let warn = 0; let logout = 0;
  const tk = S.createIdleTracker({
    now: () => c, refreshIntervalMs: 1000, warnAfterMs: 5000, graceMs: 2000,
    onRefresh: () => {}, onWarn: () => { warn += 1; }, onLogout: () => { logout += 1; },
  });
  c = 5000; tk.tick(); assert.equal(tk.phase, 'warned');
  c = 6000; tk.tick(); assert.equal(tk.secondsLeft, 1, '倒计时须随无操作递减');
  c = 7000; tk.tick(); assert.equal(tk.phase, 'expired'); assert.equal(logout, 1);
  assert.equal(warn, 2);
}
const httpSrc41 = read('packages/shared/src/api/http.ts');
assert.ok(httpSrc41.includes('refresh: refreshAccessToken'), 'http 须暴露主动续期入口（复用单飞）');
for (const p of ['apps/web/src/composables/useIdleSession.ts', 'apps/admin/src/composables/useIdleSession.ts']) {
  const src = read(p);
  assert.ok(src.includes('createIdleTracker') && src.includes('http.refresh()'), `${p}: 须接入状态机与主动续期`);
  assert.ok(src.includes('session.logout()'), `${p}: 到期须清登录态`);
}
assert.ok(read('apps/admin/src/composables/useIdleSession.ts').includes('import.meta.env.BASE_URL'), '后台登出跳转须带 /admin/ base');
const webApp41 = read('apps/web/src/App.vue');
const adminApp41 = read('apps/admin/src/App.vue');
for (const [name, src] of [['web', webApp41], ['admin', adminApp41]]) {
  assert.ok(src.includes('useIdleSession') && src.includes('warningOpen'), `${name}: App 须挂载无操作提示`);
  assert.ok(src.includes('即将退出登录') && src.includes('保持登录'), `${name}: 须有即将登出文案与保持登录按钮`);
}
assert.ok(webApp41.includes('z-[180]'), '前台提示层级须高于页面、低于灯箱');
const compose41 = read('deploy/docker-compose.prod.yml');
assert.ok(compose41.includes('ACCESS_TOKEN_TTL_SECONDS: "28800"') && compose41.includes('REFRESH_TOKEN_TTL_DAYS: "30"'), 'compose 须配置 8h/30d');
const env41 = read('apps/server/.env.example');
assert.ok(env41.includes('ACCESS_TOKEN_TTL_SECONDS=28800') && env41.includes('REFRESH_TOKEN_TTL_DAYS=30'), '.env.example 须配置 8h/30d');

/* ---------- 第 42 组：点A 列表行内改报名门槛 + 点B 客户端票数（手动刷新，无投票人） ---------- */
// 点A：admin 列表行内 select 直接 PATCH registerMinLevel，乐观更新 + 失败回滚（复用既有接口，不改契约）
const eventsView42 = read('apps/admin/src/views/EventsView.vue');
assert.ok(eventsView42.includes('async function setGate('), '后台须有行内门槛处理函数');
assert.ok(eventsView42.includes('api.admin.events.update(e.id, { registerMinLevel: level })'), '行内门槛须复用既有 PATCH 接口');
assert.ok(eventsView42.includes('e.registerMinLevel = prev'), '行内门槛失败须回滚到原值');
assert.ok(eventsView42.includes(':value="e.registerMinLevel"') && eventsView42.includes('@change="setGate('), '列表须有行内门槛下拉（桌面+移动）');
assert.ok(eventsView42.includes('报名门槛') && eventsView42.includes('colspan="8"'), '桌面表须新增报名门槛列且空态 colspan 同步');
assert.ok(eventsView42.includes('mt-2 flex flex-wrap gap-2'), '移动端卡片操作按钮须换行，避免窄屏裁切');
// 点B：服务端结果接口开放 OPEN/CLOSED/PUBLISHED（仅 DRAFT 拦截），聚合数不抑制
const votesModule42 = read('apps/server/src/modules/votes.module.ts');
assert.ok(votesModule42.includes("if (campaign.status === 'DRAFT') throw"), '客户端结果接口须仅拦草稿，开放期即可看票数');
assert.ok(!votesModule42.includes("campaign.status !== 'PUBLISHED'"), '不得再把客户端结果限定为已发布');
assert.ok(!votesModule42.includes('shouldSuppressCounts'), '客户端聚合票数不做小样本抑制（抑制函数已随候补一起下线）');
// 客户端结果 DTO 始终不含投票人身份（仅后台实时面板可见）
const domain42 = read('packages/shared/src/types/domain.ts');
const resultDtoBlock = domain42.split('export interface VoteResultDto')[1].split('export interface')[0];
assert.ok(!/voters|wechatId|nickname/.test(resultDtoBlock), '客户端结果 DTO 不得含投票人身份');
// web 票数：不自动轮询（用户刷新页面或点「刷新」），投后立即刷新 + 手动刷新按钮 + 隐私说明
const voteView42 = read('apps/web/src/views/VoteView.vue');
assert.ok(voteView42.includes('async function refreshResult('), '投票页须有独立刷新票数函数');
assert.ok(!voteView42.includes('setInterval') && !voteView42.includes('RESULT_POLL_MS'), '不得自动轮询票数（按需手动刷新）');
assert.ok(!voteView42.includes('onBeforeUnmount') && !voteView42.includes('pollTimer'), '移除轮询后不得残留定时器与卸载清理');
assert.ok(!voteView42.includes('实时') && !voteView42.includes('每 10 秒自动刷新'), '不得再有实时标识与自动刷新文案');
assert.ok(voteView42.includes('@click="refreshResult"'), '须保留手动「刷新」按钮');
assert.ok(/cast[\s\S]*?await refreshResult\(\)/.test(voteView42), '投票成功后须立即刷新票数');
assert.ok(voteView42.includes('不公开投票人'), '须保留不公开投票人说明');
// mock 镜像：草稿拦截 + 投票进程内记录（一人一票可改，票数聚合可见）
const mock42 = read('mock/index.ts');
assert.ok(mock42.includes("c.status === 'DRAFT'") && mock42.includes('投票尚未开放'), 'mock 结果接口须镜像草稿拦截');
assert.ok(mock42.includes('VOTE_VOTERS[c.id]') && mock42.includes('list.findIndex((v) => v.userId === acc!.id)'), 'mock 投票须进程内记录且一人一票可改');

/* ---------- 第 43 组：点C 投票直接关联模特 + 点D 全系统去除诱导开通会员 ---------- */
// 点C：迁移 022 给 vote_campaigns 加可空 model_id + 索引，附回滚（先摘索引再删字段）
const mig43 = read('apps/server/src/migrations/022_vote_campaign_model.sql');
assert.ok(mig43.includes('ADD COLUMN model_id BIGINT UNSIGNED NULL'), '迁移022须新增可空 model_id');
assert.ok(mig43.includes('ADD KEY idx_model (model_id)'), '迁移022须加 idx_model 索引');
assert.ok(mig43.includes('DROP COLUMN model_id') && mig43.includes('DROP KEY idx_model'), '迁移022须给出回滚思路');
// 契约：schema + DTO 增加可选 modelId / 内嵌 model（其余字段不变）
const voteSchema43 = read('packages/shared/src/schemas/vote.ts');
assert.ok(voteSchema43.includes('modelId: idSchema.nullish()'), '投票 schema 须允许可选 modelId');
const domain43 = read('packages/shared/src/types/domain.ts');
const campaignDtoBlock = domain43.split('export interface VoteCampaignDto')[1].split('export interface')[0];
assert.ok(campaignDtoBlock.includes('modelId: Id | null') && campaignDtoBlock.includes('model: ModelProfileDto | null'), 'VoteCampaignDto 须含 modelId 与内嵌 model');
// 服务端：DTO 组装带模特，create/patch 落 model_id；仅 SVIP/运营可达故身体数据恒可见，模特软删除则隐藏
const dto43 = read('apps/server/src/domain/dto.ts');
assert.ok(/voteCampaignDtoOf\([^)]*model: ModelProfileDto \| null = null\)/.test(dto43), 'voteCampaignDtoOf 须接受内嵌 model 参数');
assert.ok(dto43.includes('modelId: r.model_id == null ? null : String(r.model_id)'), 'voteCampaignDtoOf 须输出 modelId');
const votesModule43 = read('apps/server/src/modules/votes.module.ts');
assert.ok(votesModule43.includes('async function campaignModelOf('), '服务端须有投票模特组装函数');
assert.ok(votesModule43.includes('deleted_at IS NULL') && votesModule43.includes('modelDtoOf(rows[0], true)'), '模特须过滤软删除且身体数据对 SVIP/运营可见');
assert.ok(votesModule43.includes('INSERT INTO vote_campaigns (event_id, model_id,'), '新建投票须落 model_id');
assert.ok(votesModule43.includes("sets.push('model_id = ?')"), '修改投票须支持改 model_id');
assert.ok(votesModule43.includes('await campaignModelOf(campaign.model_id)'), '前台投票详情/提交须带出模特');
// 后台：新建/修改弹窗下拉选模特并回填，列表展示模特名
const votesView43 = read('apps/admin/src/views/VotesView.vue');
assert.ok(votesView43.includes('const models = ref<ModelProfileDto[]>') && votesView43.includes('api.admin.models.list({ pageSize: 100 })'), '后台须加载模特下拉数据');
assert.ok(votesView43.includes('v-model="form.modelId"') && votesView43.includes('v-model="editForm.modelId"'), '新建/修改弹窗须有模特下拉');
assert.ok(votesView43.includes('modelId: form.modelId || null') && votesView43.includes('modelId: editForm.modelId || null'), '新建/修改须提交 modelId');
assert.ok(votesView43.includes('editForm.modelId = c.modelId ??'), '修改弹窗须回填已关联模特');
assert.ok(votesView43.includes('模特：{{ c.model.stageName }}'), '列表须展示关联模特名（桌面+移动）');
// 前台：投票页直接用 campaign.model 展示模特入口，不再依赖 eventId 间接带出
const voteView43 = read('apps/web/src/views/VoteView.vue');
assert.ok(voteView43.includes('const voteModel = computed(() => campaign.value?.model ?? null)'), '投票页模特须取自 campaign.model');
assert.ok(voteView43.includes('v-if="voteModel"') && voteView43.includes(':model="voteModel"'), '模特入口与弹窗须绑定 voteModel');
assert.ok(!voteView43.includes('eventModel') && !voteView43.includes('api.events.detail'), '不得再靠 eventId 间接取模特');
// mock 镜像：campaign 带 model（前台按会员 gating，后台恒全量），create/patch 支持 modelId
const mock43 = read('mock/index.ts');
assert.ok(mock43.includes('function voteModelOf(') && mock43.includes('isMemberAcc(acc)'), 'mock 须按会员 gating 组装投票模特');
assert.ok(mock43.includes('model: voteModelOf(c, true)'), 'mock 后台投票须带全量模特');
assert.ok(mock43.includes('if (body.modelId !== undefined) c.modelId = body.modelId'), 'mock 修改投票须支持 modelId');
const mockData43 = read('mock/data.ts');
assert.ok(mockData43.includes("modelId: '1'") && mockData43.includes('modelId: null as string | null'), 'mock 种子须演示关联模特与不关联两种投票');
// 点D：无权限直接隐藏，全系统不得诱导开通会员
const modelDialog43 = read('apps/web/src/components/ModelInfoDialog.vue');
assert.ok(!modelDialog43.includes('开通 VIP / SVIP 会员后即可查看') && !modelDialog43.includes('可联系客服了解开通方式'), '模特弹窗不得再有开通诱导文案');
assert.ok(!modelDialog43.includes('身高、三围等详细资料仅会员可见'), '模特弹窗不得再有「仅会员可见」锁定提示');
assert.ok(modelDialog43.includes('<div v-if="canViewBody">') && !modelDialog43.includes('border-amber-200 bg-amber-50'), '非会员须整块隐藏身体数据，不留琥珀色诱导框');
const profile43 = read('apps/web/src/views/ProfileView.vue');
assert.ok(!profile43.includes('开通会员，解锁专属场次与价格') && !profile43.includes('const benefits ='), '个人中心须移除开通会员引导块与权益清单');
assert.ok(profile43.includes('当前为普通用户') && !profile43.includes('需要开通请联系客服'), '普通用户仅保留中性状态说明，不劝开通');
const eventDetail43 = read('apps/web/src/views/EventDetailView.vue');
assert.ok(!eventDetail43.includes('开通会员可享专属价与积分抵扣'), '报名页价格说明不得诱导开通会员');
assert.ok(!eventDetail43.includes('线下付款、开通会员、改期与退款'), '客服服务清单不得含「开通会员」诱导');
assert.ok(!domain43.includes('改用升级引导'), '余额 DTO 注释不得再描述升级引导');

/* ---------- 第 44 组：点E 投票结果带方案缩略图 + 点F 名额/名单改弹窗 ---------- */
// 点E：方案名可能只是编号，结果行必须回填方案图，投的是哪件服装一眼可辨（服务端结果 DTO 不带图，前端按 optionId 从 campaign 回填）
const resultDtoBlock44 = domain43.split('export interface VoteResultDto')[1].split('export interface')[0];
assert.ok(!resultDtoBlock44.includes('imageUrl'), '客户端结果 DTO 保持仅聚合票数，不改契约新增图片字段');
const voteView44 = read('apps/web/src/views/VoteView.vue');
assert.ok(voteView44.includes('function optionImageOf(optionId: string)'), '前台结果行须按 optionId 回填方案图');
assert.ok(voteView44.includes('campaign.value?.options.find((o) => o.id === optionId)?.imageUrl'), '回填来源须是 campaign.options');
assert.ok(/v-for="o in result\.options"[\s\S]{0,600}?optionImageOf\(o\.optionId\)/.test(voteView44), '结果行须在方案名旁渲染缩略图');
assert.ok(voteView44.includes('>无图<'), '无方案图时须有中性「无图」占位');
const votesView44 = read('apps/admin/src/views/VotesView.vue');
assert.ok(votesView44.includes('function voterOptionImage(optionId: string)'), '后台投票人明细须按 optionId 回填方案图');
assert.ok(/v-for="o in live\.options"[\s\S]{0,500}?o\.imageUrl/.test(votesView44), '后台方案票数行须显示缩略图');
assert.ok(/v-for="v in visibleVoters"[\s\S]{0,700}?voterOptionImage\(v\.optionId\)/.test(votesView44), '后台投票人表所选方案须显示缩略图');
// 点F：名额/名单从列表下方内嵌面板改为弹窗（列表不再被挤占），加载/名额进度/查看名单逻辑沿用
const eventsView44 = read('apps/admin/src/views/EventsView.vue');
assert.ok(eventsView44.includes('const seatsOpen = ref(false)'), '名额/名单须由弹窗开关驱动');
assert.ok(eventsView44.includes('async function openSeats(e: EventDto)'), '打开弹窗须复用按场次加载报名逻辑');
assert.ok(eventsView44.includes('<el-dialog v-model="seatsOpen"'), '名额/名单须使用弹窗展示');
assert.ok(eventsView44.includes('width="min(820px, 94vw)"') && eventsView44.includes('max-h-[70vh] overflow-y-auto'), '弹窗须限宽并在移动端可滚动');
assert.ok(eventsView44.includes('const seatsTitle = computed('), '弹窗标题须带场次名');
assert.ok(eventsView44.includes(':type="seatsOpen && expandedId === e.id ? \'primary\' : \'default\'"'), '同一时刻只能有一个场次按钮处于激活态');
assert.ok(eventsView44.includes('@click="goSessionRegistrations(expandedEvent, s)"'), '弹窗内须保留按时段查看名单入口');
assert.ok(eventsView44.includes('<el-button @click="seatsOpen = false">关闭</el-button>'), '弹窗须有显式关闭按钮');
assert.ok(!eventsView44.includes('class="mt-3 rounded-xl border border-slate-200 bg-white p-4"'), '不得再保留列表下方的内嵌名额面板');

/* ---------- 第 45 组：后台账号自助修改密码（复用 /me/password，不改契约） ---------- */
const meRoutes45 = read('apps/server/src/modules/me/routes.ts');
assert.ok(meRoutes45.includes("router.post(\n  '/password'") && meRoutes45.includes('changePassword('), '本人改密接口须沿用 /me/password（不新增后台专用接口）');
const adminLayout45 = read('apps/admin/src/layouts/AdminLayout.vue');
assert.ok(adminLayout45.includes('changePasswordSchema'), '后台改密须复用共享校验规则');
assert.ok(adminLayout45.includes('await api.auth.changePassword(parsed.data)'), '后台改密须调用本人改密接口');
assert.ok(adminLayout45.includes('function openPassword(') && adminLayout45.includes('async function submitPassword('), '后台须有改密弹窗开关与提交逻辑');
assert.ok((adminLayout45.match(/@click="openPassword"/g) || []).length >= 2, '桌面侧边栏与移动抽屉都须有「修改密码」入口');
assert.ok(adminLayout45.includes('>修改密码</button>') && adminLayout45.includes('>退出登录</button>'), '侧边栏底部须同时保留修改密码与退出登录');
assert.ok(adminLayout45.includes('<el-dialog v-model="pwdOpen" title="修改密码"'), '改密须用弹窗，不打断当前页面');
assert.ok(adminLayout45.includes('当前密码') && adminLayout45.includes('新密码') && adminLayout45.includes('确认新密码'), '改密表单须含当前密码 / 新密码 / 确认新密码');
assert.ok(adminLayout45.includes('两次输入的新密码不一致'), '前端须校验两次新密码一致');
assert.ok(adminLayout45.includes('session.resetState()') && adminLayout45.includes('await session.hydrate()'), '改密成功后须重载内存态，避免旧能力视图');

/* ---------- 第 46 组：场次图片区按模特配置（每位模特各自照片 + 服装） ---------- */
const eventsView46 = read('apps/admin/src/views/EventsView.vue');
assert.ok(eventsView46.includes('本场照片') && !eventsView46.includes('>活动海报<'), '场次图片区须用「本场照片」而不是「活动海报」');
// 已无「主模特」单一概念：每位模特各有一张卡片
assert.ok(!eventsView46.includes('const selectedModel = computed('), '不再区分主模特，去掉 selectedModel');
assert.ok(
  eventsView46.includes('function onModelsChange(') && eventsView46.includes('@change="onModelsChange"'),
  '切换模特须触发照片联动',
);
assert.ok(eventsView46.includes('photos[Math.floor(Math.random() * photos.length)]'), '选定模特后须随机带出该模特库的一张图');
assert.ok(eventsView46.includes('modelPhotoPool(mid)'), '指定模特后只能从该模特照片库中点选');
assert.ok(eventsView46.includes('function pickModelPhotoAt(') && eventsView46.includes('@click="pickModelPhotoAt(idx, url)"'),
  '须支持按模特替换已选图');
assert.ok(eventsView46.includes('function randomModelPhotoAt(') && eventsView46.includes('>随机换一张<'), '须支持随机换一张');
assert.ok(eventsView46.includes('<ImageUploader v-model="form.posters" :max="1" cover-hint="" />'), '未指定模特时保留自由上传，且限制为 1 张');
assert.ok(eventsView46.includes('该模特还没有照片'), '模特无照片时须给出中性提示，不落回上传');
assert.ok(eventsView46.includes('posterUrls: f.posters.slice(0, 1)') && eventsView46.includes('coverUrl: f.posters[0] ?? null'), '保存时模特图仅 1 张，首张即封面');
assert.ok(eventsView46.includes('].slice(0, 1)'), '编辑回填时旧多图只取首张，避免单张语义被破坏');
const mockData46 = read('mock/data.ts');
assert.ok(/photoUrls: \['\/posters\/poster-catspaw\.jpg', '\/posters\/poster-housekeeping\.jpg'\]/.test(mockData46), 'Mock 模特须有多张照片可选');
const eventSchema46 = read('packages/shared/src/schemas/event.ts');
assert.ok(eventSchema46.includes('posterUrls: z.array(z.string().trim().max(512)).max(9)'), '不变更 posterUrls 契约（仍为数组，仅前端限制 1 张）');

/* ---------- 第 47 组：退款对账痕迹（会员自动落定 / 非会员线下登记，2026-11-13） ---------- */
const refundSettleSql47 = read('apps/server/src/migrations/024_refund_offline_settle.sql');
assert.ok(refundSettleSql47.includes('settled_by') && refundSettleSql47.includes('settled_at'), '退款单须有 settled_by / settled_at 两列记录资金落定');
assert.ok(refundSettleSql47.includes('ADD KEY idx_unsettled (status, settled_at)'), '须有 (status, settled_at) 索引支撑「待线下退款」查询');
const balanceMod47 = read('apps/server/src/modules/balance.module.ts');
assert.ok(balanceMod47.includes('const settledAt = fromBalance ? now : null;'), '会员回充自动落定、非会员留空，两者必须区分');
assert.ok(balanceMod47.includes('async function settleRefund('), '须有 settleRefund 用于补记线下退款');
assert.ok(balanceMod47.includes("throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '只有已通过的退款单才能登记线下退款完成')"), '只有 REFUNDED 的单子才能登记线下退款');
assert.ok(balanceMod47.includes("admin.post('/refunds/:id/settle'"), '须暴露 POST /admin/refunds/:id/settle 路由');
assert.ok(balanceMod47.includes("requireCapabilities('admin:refund:review')"), '登记线下退款须复用 admin:refund:review 权限');
assert.ok(balanceMod47.includes('unsettledTotal'), '退款列表须带出 unsettledTotal 挂账数');
// 场次取消的整场退款同样要写 settled_*，否则同一条退款链路出现两种口径
const eventsMod47 = read('apps/server/src/modules/events.module.ts');
assert.ok(eventsMod47.includes('SET balance_txn_id = ?, settled_by = ?, settled_at = ?'), '场次取消的会员退款也须写入资金落定痕迹');
const refundSchema47 = read('packages/shared/src/schemas/finance.ts');
assert.ok(refundSchema47.includes('refundSettleSchema'), '契约层须有 refundSettleSchema');
const endpoints47 = read('packages/shared/src/api/endpoints.ts');
assert.ok(endpoints47.includes('refundSettle: (id: string) => `/admin/refunds/${id}/settle`'), '契约层须声明 refundSettle 端点');
const domainTypes47 = read('packages/shared/src/types/domain.ts');
assert.ok(domainTypes47.includes('settledAt: ISODateTime | null;'), 'RefundOrderDto 须带 settledAt');
const financeView47 = read('apps/admin/src/views/FinanceView.vue');
assert.ok(financeView47.includes('function needSettle(') && financeView47.includes('api.admin.refunds.settle('), '财务页须能登记线下退款完成');
assert.ok(financeView47.includes("value=\"UNSETTLED\""), '财务页须能筛出「待线下退款」挂账单');
assert.ok(financeView47.includes('待线下退款'), '挂账单须在列表里显式标出');

/* ---------- 第 48 组：工程化与真分页（2026-11-13） ---------- */
// 锁文件与 CI：没有它们，依赖版本与类型检查都靠本地自觉
assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')), '须提交 pnpm-lock.yaml 锁死依赖版本');
const ciYml48 = read('.github/workflows/ci.yml');
assert.ok(ciYml48.includes('--frozen-lockfile') && ciYml48.includes('pnpm typecheck') && ciYml48.includes('pnpm verify'),
  'CI 须冻结锁文件安装后跑 typecheck 与 verify');
const rootPkg48 = JSON.parse(read('package.json'));
assert.ok(rootPkg48.scripts.typecheck.includes('pnpm -r'), '根 typecheck 须递归覆盖全部子包（此前只跑 shared）');
for (const p of ['apps/web/package.json', 'apps/admin/package.json']) {
  assert.ok(JSON.parse(read(p)).scripts.typecheck.includes('vue-tsc'), `${p}: 前端包须用 vue-tsc 做类型检查`);
}
// 真分页：列表页不得再靠 loadAllPages 拉全量
const registrations48 = read('apps/server/src/modules/registrations.module.ts');
assert.ok(registrations48.includes('adminRegistrationListQuerySchema'), '报名列表须走带筛选的查询 schema');
assert.ok(registrations48.includes('unpaidTotal'), '报名列表须返回全局待收款数（不受分页影响）');
const balance48 = read('apps/server/src/modules/balance.module.ts');
assert.ok(balance48.includes('adminRefundListQuerySchema') && balance48.includes('adminBalanceTxnListQuerySchema'),
  '退款与积分流水列表须走带筛选的查询 schema');
const registrationsView48 = read('apps/admin/src/views/RegistrationsView.vue');
assert.ok(!registrationsView48.includes('loadAllPages((page, pageSize) => api.admin.registrations.list'),
  '报名列表页不得再整表拉全量');
assert.ok(registrationsView48.includes('pageCount'), '报名列表须有分页控件');
const financeView48 = read('apps/admin/src/views/FinanceView.vue');
assert.ok(financeView48.includes('refundPageCount') && financeView48.includes('txnPageCount'), '财务两个列表都须分页');
assert.ok(!financeView48.includes('pendingRefunds'), '页签角标须用服务端 pendingTotal，不能用当前页过滤结果');
// 死代码与巨型文件
const ledger48 = read('apps/server/src/domain/ledger.ts');
assert.ok(!ledger48.includes('export async function reconcileAccount'), '零调用的 reconcileAccount 不应保留实现');
assert.ok(ledger48.includes('HAVING diff <> 0'), '对账口径须以 SQL 注释形式留在账本文件里，便于运维照抄');
const cockpit48 = read('apps/admin/src/views/CockpitView.vue');
assert.ok(cockpit48.includes("from './cockpit/chartOptions'"), '驾驶舱图表配置须抽到独立模块');
assert.ok(cockpit48.includes('<style src="./cockpit.css" scoped>'), '驾驶舱样式须外置，视图只留业务逻辑');
assert.ok(cockpit48.split('\n').length < 700, '驾驶舱单文件须控制体量（拆分前 994 行）');

// ---------- 合规：账号注销 / 敏感信息单独同意 / 处理者身份 ----------
// PIPL 第 47 条（删除权）要求「承诺即能落地」，故必须有真实接口而非只写进政策
const meRoutes49 = read('apps/server/src/modules/me/routes.ts');
assert.ok(meRoutes49.includes("'/delete'"), '须提供本人注销账号接口');
assert.ok(meRoutes49.includes('deleteAccountSchema'), '注销须校验密码，避免被 CSRF 或会话劫持触发');
const authService49 = read('apps/server/src/modules/auth/service.ts');
assert.ok(authService49.includes("action: 'USER_ACCOUNT_DELETE'"), '注销须写审计日志');
assert.ok(authService49.includes('已注销用户') && authService49.includes('deleted_'),
  '注销须匿名化昵称与微信号（履行业务记录留存的同时抹除身份信息）');
assert.ok(read('apps/web/src/views/ProfileView.vue').includes('注销账号') || read('apps/web/src/views/SettingsView.vue').includes('注销账号'), '须有注销入口');
assert.ok(read('apps/web/src/views/ProfileView.vue').includes('/settings'), '个人中心须能进入设置页');
// PIPL 第 17 条：必须告知处理者名称与联系方式
const privacy49 = read('apps/web/src/views/PrivacyView.vue');
assert.ok(privacy49.includes('个人信息处理者'), '隐私政策须告知个人信息处理者身份');
assert.ok(privacy49.includes('Cookie'), '隐私政策须说明 Cookie 用途');
// PIPL 第 28–29 条：身高/三围属敏感个人信息，需单独同意并留痕
const consentMigration49 = read('apps/server/src/migrations/025_model_body_data_consent.sql');
assert.ok(consentMigration49.includes('body_data_consent_at'), '须为身高/三围单独同意留痕');
assert.ok(read('apps/admin/src/views/ModelsView.vue').includes('bodyDataConsent'), '后台模特编辑须有单独同意勾选');
assert.ok(read('apps/server/src/modules/events.module.ts').includes('body_data_consent_at'),
  '服务端须写入同意时间，而不是只存前端勾选');
// 折扣券语义回归：discountBp 是实付比例，减免额 = 原价 ×(1 − bp/10000)
assert.equal(S.couponDiscountOf({ type: 'DISCOUNT', discountBp: 8000 }, 10000), 2000,
  '8 折必须减免 20%，不能把 80% 当减免额');

// ---------- SVIP 专属：登记中场次的「同场的人」（只给昵称） ----------
// 复用文件前面已算好的 capsSvipP / capsVipP / capsNoneP
assert.ok(capsSvipP.has('event:participants:view'), 'SVIP 须能查看同场名单');
assert.ok(!capsVipP.has('event:participants:view'), 'VIP 不得查看同场名单');
assert.ok(!capsNoneP.has('event:participants:view'), '普通用户不得查看同场名单');
const participantsModule = read('apps/server/src/modules/events.module.ts');
assert.ok(participantsModule.includes("requireCapabilities('event:participants:view')"),
  '同场名单接口须按能力位鉴权，不能只看登录态');
// 隐私：该接口只允许查昵称，绝不能把 wechat_id 带出来
const participantsStart = participantsModule.indexOf("'/:id/participants'");
const participantsEnd = participantsModule.indexOf("pub.get('/:id'", participantsStart);
assert.ok(participantsStart > 0 && participantsEnd > participantsStart, '同场名单路由须存在于 events 模块');
const participantsSrc = participantsModule.slice(participantsStart, participantsEnd);
assert.ok(participantsSrc.includes('u.nickname'), '同场名单须查昵称');
assert.ok(!participantsSrc.includes('wechat_id'), '同场名单不得查询或返回微信号');
assert.ok(participantsSrc.includes("'CONFIRMED', 'CHECKED_IN', 'COMPLETED'"),
  '已取消/退款中的登记不得出现在同场名单里');
assert.ok(read('apps/web/src/views/EventDetailView.vue').includes("session.can('event:participants:view')"),
  '前台须按能力位决定是否请求同场名单');
// ---------- 登记按钮必须按「选中时段」判断，而不是整场一刀切 ----------
// 只回整场一个 canRegister 会让「第1场满、第2场有位」时按钮整体禁用
assert.ok(
  read('apps/server/src/modules/events.module.ts').includes('sessionChecks'),
  '余量接口须逐时段返回可报状态',
);
assert.ok(
  !/const target = sessions\.find\(\(s\) => s\.status === 'OPEN'\)/.test(
    read('apps/server/src/modules/events.module.ts'),
  ),
  '余量接口不得只挑第一个 OPEN 时段判定整场',
);
const webDetail = read('apps/web/src/views/EventDetailView.vue');
assert.ok(webDetail.includes('canSubmitSelected'), '登记按钮须按选中时段判断是否可用');
assert.ok(
  !webDetail.includes(':disabled="!availability?.canRegister"'),
  '登记按钮不得再用整场 canRegister 做禁用条件',
);
assert.ok(
  /function openConfirm[\s\S]{0,400}?canSubmitSelected/.test(webDetail),
  'openConfirm 也须校验，不能只靠按钮 disabled',
);
assert.ok(
  /async function doSubmit[\s\S]{0,300}?canSubmitSelected/.test(webDetail),
  'doSubmit 提交前须再校验一次',
);
// 已满时段仍要能选中，否则看不到「同场的人」
assert.ok(
  !webDetail.includes(':disabled="!stateOf(s).ok"'),
  '时段卡片不得整体禁用：满员时段也要能选中查看同场名单',
);
// 空输入登录不得直接抛后端/英文报错
assert.ok(
  /wechatId: z\.string\(\)\.trim\(\)\.min\(1, '请输入微信号'\)/.test(read('packages/shared/src/schemas/auth.ts')),
  'loginSchema 必须为必填项提供中文文案',
);
// 会员无积分账户时应补建，而不是报「仅会员可调整积分」
const balanceAdjustSrc = read('apps/server/src/modules/balance.module.ts');
assert.ok(balanceAdjustSrc.includes('INSERT IGNORE INTO balance_accounts'), '会员缺积分账户时须自动补建');
assert.ok(
  balanceAdjustSrc.includes('该用户不是有效会员，无法调整积分'),
  '非会员调账仍须拒绝，且文案要说明原因',
);
assert.ok(read('mock/index.ts').includes('/participants$'),
  'mock 须镜像同场名单端点');

// ---------- 时段级回避名单（SVIP 择邻） ----------
// 语义：某个时段不接受某人报名；不是全局黑名单，换时段仍可报名
assert.equal(S.BIZ_CODES.SESSION_RESTRICTED, 4025, '回避拦截须有独立业务码');
assert.ok(
  /该时段暂不可选/.test(S.BIZ_CODE_MESSAGES[4025] ?? ''),
  '回避拦截文案必须中性，不得暴露「被某会员排除」',
);
const avoidMigration = read('apps/server/src/migrations/026_session_avoid_rules.sql');
assert.ok(avoidMigration.includes('session_avoid_rules'), '须有回避名单表');
assert.ok(avoidMigration.includes('uk_session_blocked'), '同一时段对同一人只保留一条规则');
assert.ok(avoidMigration.includes('revoked_at'), '回避规则须软删除，保留解除痕迹');
const avoidModule = read('apps/server/src/modules/avoid-rules.module.ts');
assert.ok(
  avoidModule.includes("requireCapabilities('admin:registration:write')"),
  '回避名单只给运营（报名写权限）配置，不开放给会员',
);
assert.ok(read('apps/server/src/modules/index.ts').includes('mountSessionAvoidRules'), '须挂载回避名单路由');

const regAvoid = read('apps/server/src/modules/registrations.module.ts');
assert.ok(regAvoid.includes('BIZ_CODES.SESSION_RESTRICTED'), '自助报名须拦截回避名单');
assert.ok(
  regAvoid.includes('session_avoid_rules') && regAvoid.includes('owner_user_id = ?'),
  '发起人取消报名后，其回避规则须自动失效',
);
// 运营手动录入：只警告不阻断
const manualForAvoid = regAvoid.slice(
  regAvoid.indexOf('async function createManualRegistration'),
  regAvoid.indexOf('export function mountRegistrations'),
);
assert.ok(manualForAvoid.includes('warnings'), '手动录入命中回避名单须回传警告而不是阻断');

const eventsForAvoid = read('apps/server/src/modules/events.module.ts');
assert.ok(eventsForAvoid.includes('restrictedSessionIds'), '余量接口须回传被回避的时段，供前端置灰');
assert.ok(
  read('apps/web/src/views/EventDetailView.vue').includes('暂不可选'),
  '前台须把被回避的时段标成中性文案',
);
assert.ok(
  read('apps/admin/src/views/RegistrationsView.vue').includes('回避名单'),
  '后台须有回避名单管理入口',
);
assert.ok(read('mock/index.ts').includes('MOCK_AVOID_RULES'), 'mock 须镜像回避名单');

// ---------- 代拍：独立于时段的报名项 ----------
const proxyMigration = read('apps/server/src/migrations/027_proxy_shoot_session.sql');
assert.ok(proxyMigration.includes("'PROXY'"), 'event_sessions 须有 kind 区分代拍');
assert.ok(proxyMigration.includes('uk_event_proxy'), '同一场次最多一个代拍行');
const proxyDto = read('apps/server/src/domain/dto.ts');
assert.ok(proxyDto.includes("r.kind === 'PROXY'"), '时段 DTO 须映射 kind');
const proxyEvents = read('apps/server/src/modules/events.module.ts');
assert.ok(proxyEvents.includes('proxySessionOf'), '创建场次时须自动生成代拍行');
assert.ok(
  proxyEvents.includes("String((s as { kind?: string }).kind ?? 'NORMAL') === 'PROXY'"),
  '编辑场次时代拍行须单独处理，不能被当作未提交的常规时段删掉',
);
assert.ok(proxyEvents.includes('rawBodyOf'), '须区分「字段缺省」与「显式传 false」，否则改时段会误关代拍');
// 只切开关、不带 sessions 的编辑也要生成代拍，否则后台勾了但前台没入口
assert.ok(
  /hasProxyFlag && !wantsRelations/.test(proxyEvents),
  '只改代拍开关（不提交时段）时也必须生成/清理代拍项',
);
assert.ok(proxyEvents.includes('不能关闭本场的代拍'), '已有代拍报名时不得关闭代拍');
// 代拍不参与时间冲突
const proxyReg = read('apps/server/src/modules/registrations.module.ts');
assert.ok(proxyReg.includes("const isProxy"), '报名链路须识别代拍');
assert.ok(proxyReg.includes("s.kind <> 'PROXY'"), '代拍不参与常规时段的时间冲突检测');
assert.ok(read('apps/server/src/domain/policy.ts').includes('isProxy ? t >= parseUtc(session.endAt)'),
  '代拍以整场结束为界，不是时段开始');
assert.ok(read('apps/web/src/views/EventDetailView.vue').includes('代拍服务'), '前台须展示代拍选项');
// 代拍不限人数：跳过容量校验，也不累加计数器
assert.ok(
  read('apps/server/src/domain/policy.ts').includes('!isProxy && session.capacityUsed'),
  '代拍须跳过满员校验',
);
assert.ok(
  /isProxySession[\\s\\S]{0,400}?capacity_used = capacity_used \\+ \\?/.test(proxyReg) === false || proxyReg.includes('if (!isProxySession)'),
  '代拍不得累加时段占用计数',
);
assert.ok(read('apps/admin/src/views/EventsView.vue').includes('allowProxyShoot'), '后台须有代拍开关');
// 代拍不限人数：容量汇总、退名额、退款驳回都不得把它算进去
assert.ok(
  read('apps/server/src/domain/dto.ts').includes("kind !== 'PROXY'"),
  '场次汇总容量须排除代拍',
);
assert.ok(
  read('apps/server/src/modules/registrations.module.ts').includes("kind <> 'PROXY' AND capacity_used > 0"),
  '取消报名回退名额时须跳过代拍',
);
assert.ok(
  read('apps/server/src/modules/balance.module.ts').includes("kind <> 'PROXY' AND capacity_used < capacity"),
  '退款驳回回补名额时须跳过代拍',
);
assert.ok(read('mock/data.ts').includes("kind: 'PROXY'"), 'mock 须镜像代拍行');

/* ---------- 第 50 组：双模特各自照片与服装（不区分主副） ---------- */
// 数据模型：按「场次 × 模特」存服装与照片，而不是整场一份
const migration029 = read('apps/server/src/migrations/029_event_model_wardrobe.sql');
assert.ok(migration029.includes('wardrobe_urls'), '每位模特的服装须单独持久化');
assert.ok(migration029.includes('event_models'), '服装须挂在 event_models 上（场次 × 模特）');
const migration030 = read('apps/server/src/migrations/030_event_model_photos.sql');
assert.ok(migration030.includes('photo_urls'), '每位模特的照片须单独持久化');

const domainSlotSrc = read('packages/shared/src/types/domain.ts');
assert.ok(domainSlotSrc.includes('EventModelSlotDto'), '须有「模特在场次中的槽位」DTO');
assert.ok(domainSlotSrc.includes('modelSlots'), 'EventDto 须下发每人的照片与服装');
const slotBlock = domainSlotSrc.slice(
  domainSlotSrc.indexOf('export interface EventModelSlotDto'),
  domainSlotSrc.indexOf('export interface EventDto'),
);
assert.ok(slotBlock.includes('photoUrls') && slotBlock.includes('wardrobeUrls'),
  '槽位须同时含照片与服装');

const eventSlotSchemaSrc = read('packages/shared/src/schemas/event.ts');
assert.ok(eventSlotSchemaSrc.includes('modelWardrobes'), '输入 schema 须支持按模特的服装');
assert.ok(eventSlotSchemaSrc.includes('modelPhotos'), '输入 schema 须支持按模特的照片');

// 服务端：写入 / 读取 / 回退
assert.ok(eventsModuleSrc.includes('replaceEventModels'), '须有模特槽位写入函数');
assert.ok(eventsModuleSrc.includes('em.wardrobe_urls') && eventsModuleSrc.includes('em.photo_urls'),
  '读取须带上按模特的服装与照片');
assert.ok(eventsModuleSrc.includes('modelSlotsOf'), '须把模特行映射成槽位并做回退');
const slotFn = eventsModuleSrc.slice(
  eventsModuleSrc.indexOf('function modelSlotsOf'),
  eventsModuleSrc.indexOf('async function withRelations'),
);
assert.ok(slotFn.includes('eventWardrobes'), '服装须回退到整场那组');
assert.ok(slotFn.includes('eventPhotos') || slotFn.includes('profilePhoto'),
  '照片须回退到整场或档案首图');
assert.ok(eventsModuleSrc.includes('hasPhotoField'), '只改某位模特照片时也须落库');
// 按模特 id 对齐，而不是按数组下标（删掉第一位后下标会左移，会串图）
assert.ok(eventsModuleSrc.includes('prevWardrobe') && eventsModuleSrc.includes('prevPhoto'),
  '服装与照片须按模特 id 保留原值');

// 后台：不分主副模特，每人一套
const slotEventsViewSrc = read('apps/admin/src/views/EventsView.vue');
assert.ok(!slotEventsViewSrc.includes('selectedModel'), '不得再有「主模特」这一概念');
assert.ok(slotEventsViewSrc.includes('modelWardrobes') && slotEventsViewSrc.includes('modelPhotos'),
  '后台表单须按模特分别收集照片与服装');
assert.ok(slotEventsViewSrc.includes('模特 {{ idx + 1 }}'), '后台须为每位模特各渲染一张卡片');
assert.ok(slotEventsViewSrc.includes('场地照片由整场共用'), '场地照片须说明为整场共用，无需按模特重复上传');
assert.ok(slotEventsViewSrc.includes('pickModelPhotoAt'), '每位模特须能各自选照片');

// 海报：双模特各自展示自己的服装
const slotPosterSrc = read('apps/admin/src/utils/poster.ts');
assert.ok(slotPosterSrc.includes("case 'wardrobe2'"), '海报须支持第二模特的服装区块');
assert.ok(slotPosterSrc.includes('slotWardrobe'), '海报服装须按模特取值');
assert.ok(slotPosterSrc.includes('hasSecondModel'), '单模特场次须跳过第二模特区块');
const slotPosterSchemaSrc = read('packages/shared/src/schemas/poster.ts');
assert.ok(slotPosterSchemaSrc.includes('modelIndex'), '海报区块须能绑定到具体模特');
const duoBlock = slotPosterSchemaSrc.slice(
  slotPosterSchemaSrc.indexOf('const DUO'),
  slotPosterSchemaSrc.indexOf('const COMPACT'),
);
assert.ok(duoBlock.includes("mk('wardrobe'") && duoBlock.includes("mk('wardrobe2'"),
  '双人版式须同时含两位模特的服装');

// 前台：服装按模特分组展示
const webDetailSrc = read('apps/web/src/views/EventDetailView.vue');
assert.ok(webDetailSrc.includes('wardrobeGroups'), '前台服装须按模特分组');
assert.ok(webDetailSrc.includes('服装照片 · ${m.stageName}'), '双人场服装标题须带模特名');
assert.ok(webDetailSrc.includes('modelSlots'), '前台须使用按模特的照片与服装');

/* ---------- 第 51 组：部署打包的归档根目录必须是 photo-club/ ---------- */
// 踩过的坑：pack.py 曾把暂存目录名一起打进归档，
// 于是包内路径变成 .pack-staging/photo-club/deploy/…，
// 上线后解压到 /www/wwwroot 只多出一个隐藏目录，线上一个字节都没覆盖 → 「传了没生效」。
const packPy = read('deploy/pack.py');
assert.ok(packPy.includes("TOP = 'photo-club'"), '打包脚本须固定归档顶层为 photo-club');
assert.ok(packPy.includes('arcname=TOP'), '打包须用固定 arcname，不能带暂存目录名');
assert.ok(!packPy.includes('arcname=os.path.basename(SRC)'), '不得再用暂存目录名当归档根');
assert.ok(packPy.includes('打包自检失败'), '打包后须自检归档路径');
assert.ok(packPy.includes("m.name.startswith(TOP + '/')"), '自检须校验所有条目都在 photo-club/ 下');
assert.ok(packPy.includes("elif info.name.endswith('.sh')"), '脚本须保留 .sh 可执行位');
assert.ok(packPy.includes('info.mode = 0o755'), '目录与脚本须为 0755');

/* ---------- 第 52 组：只给账号串认不出人，全站须同时下发并显示昵称 ---------- */
// 运营反馈：报名管理「用户」列只有 c1021522802 / symj_sunshine_young 这类自起的微信号，
// 想确认「这是谁」得去会员管理再搜一次。凡是展示用户的地方，昵称必须和微信号一起到手。
const nickDomainSrc = read('packages/shared/src/types/domain.ts');
assert.ok(nickDomainSrc.includes('userNickname: string | null'), '报名 DTO 须带报名人昵称');
assert.ok(nickDomainSrc.includes('accountNickname: string | null'), '积分流水 DTO 须带账户昵称');
assert.ok(nickDomainSrc.includes('actorNickname: string | null'), '审计日志 DTO 须带操作人昵称');
assert.ok(nickDomainSrc.includes('createdByNickname') && nickDomainSrc.includes('usedByNickname'),
  '邀请码 DTO 须带生成人与使用人昵称');
assert.ok(nickDomainSrc.includes('targetNickname'), '权限日志 DTO 须带被操作对象昵称');
assert.ok(nickDomainSrc.includes('boundNickname'), '模特档案 DTO 须带绑定账号昵称');

// 服务端：五张列表的 SQL 都要 join users 把昵称取回来，光有 wechat_id 不够
assert.ok(regModuleSrc.includes('u.nickname AS user_nickname'), '报名列表须 join 出昵称');
assert.ok(regModuleSrc.includes('u.nickname LIKE ?'), '报名搜索须能按昵称搜到人');
const nickBalSrc = read('apps/server/src/modules/balance.module.ts');
assert.ok(nickBalSrc.includes('u.nickname AS account_nickname'), '积分流水须 join 出昵称');
assert.ok(nickBalSrc.includes('u.nickname LIKE ?'), '流水搜索须能按昵称搜');
assert.ok(adminModuleSrc.includes('u.nickname AS actor_nickname'), '审计日志须 join 出操作人昵称');
assert.ok(adminModuleSrc.includes('t.nickname AS target_nickname'), '权限日志须 join 出被操作人昵称');
assert.ok(adminModuleSrc.includes('u.nickname LIKE ?'), '审计与权限日志搜索须能按昵称搜');
const nickInviteSrc = read('apps/server/src/modules/invite-codes.ts');
assert.ok(nickInviteSrc.includes('creator.nickname AS creator_nickname')
  && nickInviteSrc.includes('used.nickname AS used_nickname'), '邀请码须 join 出生成人与使用人昵称');

// CSV 导出：只有 user_id 时运营在 Excel 里认不出人，昵称列必须跟着导
const nickExportBlock = adminModuleSrc.slice(
  adminModuleSrc.indexOf('const EXPORT_TARGETS'),
  adminModuleSrc.indexOf('function csvCell'),
);
assert.ok(nickExportBlock.includes('user_nickname') && nickExportBlock.includes('actor_nickname')
  && nickExportBlock.includes('account_nickname') && nickExportBlock.includes('requester_nickname'),
  '四张导出表都须带昵称列');
assert.ok(nickExportBlock.includes('LEFT JOIN users'), '导出须 join users 才能拿到昵称');
// id 列不能因为加了昵称就被删掉：对账还要靠它回库核对
assert.ok(nickExportBlock.includes("columns: ['id', 'event_id', 'user_id', 'user_nickname'"),
  '导出加昵称后仍须保留裸 id 列供对账');

// 前端：统一走 personLabel，昵称优先、微信号兜底、最后才是 #id
const nickLabelsSrc = read('apps/admin/src/utils/labels.ts');
assert.ok(nickLabelsSrc.includes('export function personLabel'), '须有共用的「昵称（微信号）」拼接函数');
const personLabelFn = nickLabelsSrc.slice(
  nickLabelsSrc.indexOf('export function personLabel'),
  nickLabelsSrc.indexOf('export function', nickLabelsSrc.indexOf('export function personLabel') + 10),
);
assert.ok(personLabelFn.includes('withWechat'), '须支持「只显示昵称不带微信号」的窄列场景');
assert.ok(personLabelFn.includes("'—'"), '昵称与微信号都缺时须显示 — 而不是空白或 null');

// 各视图不得再把裸微信号当主名渲染
for (const [file, needles] of [
  ['apps/admin/src/views/RegistrationsView.vue', ['personLabel(r.userNickname, r.userWechatId']],
  ['apps/admin/src/views/FinanceView.vue', ['personLabel(t.accountNickname, t.accountWechatId', 'personLabel(r.requesterNickname, r.requesterWechatId']],
  ['apps/admin/src/views/CockpitView.vue', ['personLabel(r.userNickname, r.userWechatId', 'personLabel(r.requesterNickname, r.requesterWechatId']],
  ['apps/admin/src/views/GovernanceView.vue', ['personLabel(l.actorNickname, l.actorWechatId', 'personLabel(p.targetNickname, p.targetWechatId']],
  ['apps/admin/src/views/InviteCodesView.vue', ['personLabel(c.createdByNickname', 'personLabel(c.usedByNickname']],
  ['apps/admin/src/views/CouponsView.vue', ['personLabel(String(row.userNickname ?? \'\')']],
  ['apps/admin/src/views/ModelsView.vue', ['personLabel(m.boundNickname, m.boundWechatId']],
  ['apps/admin/src/views/EventsView.vue', ['personLabel(r.userNickname, r.userWechatId']],
  ['apps/admin/src/components/UserPicker.vue', ['personLabel(o.nickname, o.wechatId']],
]) {
  const src = read(file);
  assert.ok(src.includes('personLabel'), `${file} 须用 personLabel 拼用户显示名`);
  for (const needle of needles) assert.ok(src.includes(needle), `${file} 须把昵称作为主名（缺 ${needle}）`);
  assert.ok(src.includes("from '../utils/labels'"), `${file} 须从 utils/labels 引入 personLabel`);
}

// Mock 层：dev:admin:mock 下也要能看到昵称，否则本地联调重现不了线上问题
const nickMockSrc = read('mock/index.ts');
assert.ok(nickMockSrc.includes('createdByNickname') && nickMockSrc.includes('usedByNickname'),
  'Mock 邀请码须带生成人与使用人昵称');
assert.ok(nickMockSrc.includes('actorNickname') && nickMockSrc.includes('targetNickname'),
  'Mock 审计与权限日志须带操作人昵称');
assert.ok(nickMockSrc.includes('accountNickname'), 'Mock 积分流水须带账户昵称');

/*
 * 昵称必显（第二批）：审计日志的「对象」列、会员管理列序、导入凭证与失败明细、
 * 以及登录/改密页的「当前账号」，凡是只给账号串或 #id 的地方都要有名字。
 */
assert.ok(adminModuleSrc.includes("tu.nickname AS target_nickname") && adminModuleSrc.includes("a.target_type = 'user'"),
  '审计日志须在 targetType=user 时 join 出被操作对象昵称（其它实体无法统一 join，保持 #id）');
assert.ok(nickDomainSrc.includes('targetNickname: string | null'),
  'AuditLogDto 须带 targetNickname（权限日志继承同一字段）');

const nickMembersSrc = read('apps/admin/src/views/MembersView.vue');
assert.ok(nickMembersSrc.includes('personLabel(c.nickname, c.wechatId)'),
  '导入凭证清单须显示「昵称（微信号）」而不是裸账号串');
assert.ok(nickMembersSrc.includes('personLabel(e.nickname, e.wechatId)'),
  '导入失败明细须显示昵称');
assert.ok(nickMembersSrc.includes("{{ u.nickname || '—' }}"),
  '会员管理主表须以昵称为主名');
assert.ok(
  nickMembersSrc.indexOf("{{ u.nickname || '—' }}") < nickMembersSrc.indexOf('{{ u.wechatId }}</td>'),
  '会员管理主表昵称列须排在微信号列之前',
);

const nickImportSrc = read('apps/server/src/modules/member-import.ts');
assert.ok(nickImportSrc.includes('nickname: r.nickname || null'),
  '导入凭证与失败明细都要回传昵称，否则运营只能看到账号串');
const nickImportsTypeSrc = read('packages/shared/src/types/imports.ts');
assert.ok(nickImportsTypeSrc.includes('nickname: string | null'),
  'MemberImportCredentialDto 与 MemberImportErrorDto 须带 nickname');

assert.ok(read('apps/web/src/views/ChangePasswordView.vue').includes('session.user?.nickname || session.user?.wechatId'),
  '前台改密页「当前账号」须昵称优先');
assert.ok(read('apps/admin/src/views/ForbiddenView.vue').includes('session.user.nickname || session.user.wechatId'),
  '后台 403 页「当前账号」须昵称优先');
assert.ok(read('apps/admin/src/views/GovernanceView.vue').includes('l.targetNickname || l.targetWechatId'),
  '审计日志「对象」列有昵称时须显示昵称，缺才退化成 #id');

console.log(`VERIFY_OK: 52 组断言通过（角色边界/导入/Mock/三块图区/模特独立建档/时段冲突/枚举对齐/邀请码/多名额/手机号移除/会员授予/图片上传/乱码修复/图片诊断/编辑弹窗回填/调账一步化/重置密码/3001修复/改密与强制改密/退款资金链与协议与限流/投票开放与状态回填/投票解耦与流水与报名展示/海报导出与二维码配置/网站与客服二维码/海报标题配置/前台双 Tab 与截止只读/优惠券/积分化与协议同意/注册隐藏与退款场次与权限日志/手动录入与后台易用性/后台整体优化/下拉选人与默认值与时段名额与导出/赠送积分/报名来源与退款渠道/投票图片灯箱/人工报名门槛/模特身高三围会员可见/场景库/会话延长与无操作提示/列表行内门槛与客户端票数手动刷新/投票直接关联模特与全系统去会员诱导/投票结果缩略图与名额名单弹窗/后台自助改密/场次模特照片取自模特库/海报设计器与版式持久化/双模特各自照片与服装/部署打包路径/工程化与真分页/昵称必显；DDL ${tables.length} 表 / 种子 ${seedTables.length} 表一致；双端能力名对齐`);
