/**
 * 模块 6 路由契约验收：启动真实 Express app，逐条探测 shared ENDPOINTS 对应的路径。
 * 断言「不是 404」即可证明路由已挂载；认证/DB 错误属预期（本机不连 MySQL）。
 * 运行：node apps/server/node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json scripts/verify-routes.ts
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { BIZ_CODES } from '@photo/shared';
import { app } from '../apps/server/src/app';

const probes: Array<[string, string]> = [
  ['GET', '/api/v1/health'],
  ['POST', '/api/v1/auth/register'], ['POST', '/api/v1/auth/login'],
  ['POST', '/api/v1/auth/refresh'], ['POST', '/api/v1/auth/logout'],
  ['GET', '/api/v1/me'], ['GET', '/api/v1/me/capabilities'],
  // 本人修改密码（导入账号首次登录也走这里）
  ['POST', '/api/v1/me/password'],
  ['GET', '/api/v1/events'], ['GET', '/api/v1/events/1'],
  ['GET', '/api/v1/events/1/availability'],
  ['GET', '/api/v1/models'], ['GET', '/api/v1/models/4'],
  ['POST', '/api/v1/registrations'], ['GET', '/api/v1/registrations/mine'],
  ['POST', '/api/v1/registrations/1/cancel'],
  ['GET', '/api/v1/refunds/mine'], ['GET', '/api/v1/balance'],
  ['GET', '/api/v1/balance/transactions'],
  ['GET', '/api/v1/memberships/mine'], ['GET', '/api/v1/memberships/mine/privileges'],
  ['GET', '/api/v1/vote-campaigns/1'], ['POST', '/api/v1/votes'],
  ['GET', '/api/v1/vote-campaigns/1/result'],
  ['GET', '/api/v1/admin/events'], ['POST', '/api/v1/admin/events'],
  ['POST', '/api/v1/admin/events/1/cancel'],
  ['GET', '/api/v1/admin/registrations'],
  // 手动录入（线下报名）：按微信号查账号 + 录入
  ['GET', '/api/v1/admin/registrations/lookup?wechatId=u1_catpaw'],
  ['POST', '/api/v1/admin/registrations'],
  // 下拉选人选项（手动录入 / 发券共用）
  ['GET', '/api/v1/admin/registrations/users'],
  ['GET', '/api/v1/admin/refunds'], ['GET', '/api/v1/admin/balance/transactions'],
  ['POST', '/api/v1/admin/memberships'], ['GET', '/api/v1/admin/vote-campaigns'],
  ['POST', '/api/v1/admin/vote-campaigns/1/publish'],
  ['GET', '/api/v1/admin/audit-logs'], ['GET', '/api/v1/admin/permission-logs'],
  ['POST', '/api/v1/admin/exports'],
  // 本轮新增：前台投票列表 + 会员导入三件套
  ['GET', '/api/v1/vote-campaigns'],
  ['POST', '/api/v1/admin/members/import/preview'],
  ['POST', '/api/v1/admin/members/import/commit'],
  ['GET', '/api/v1/admin/members/import/template'],
  // 用户管理与场次恢复
  ['GET', '/api/v1/admin/users'], ['POST', '/api/v1/admin/users'],
  ['POST', '/api/v1/admin/users/reset-password'],
  ['GET', '/api/v1/admin/models'],
  ['POST', '/api/v1/admin/events/1/restore'],
  ['POST', '/api/v1/admin/uploads'],
  // 注册邀请码：列表 / 批量生成 / 作废
  ['GET', '/api/v1/admin/invite-codes'],
  ['POST', '/api/v1/admin/invite-codes'],
  ['POST', '/api/v1/admin/invite-codes/1/revoke'],
  // 场次海报固定二维码配置
  ['GET', '/api/v1/admin/settings/poster'],
  ['PUT', '/api/v1/admin/settings/poster'],
  // 前台公开设置（报名页客服二维码，无需登录）
  ['GET', '/api/v1/settings/public'],
  // 投票草稿开放
  ['POST', '/api/v1/admin/vote-campaigns/1/open'],
  // 场次草稿发布 + 投票查看/修改/实时明细
  ['POST', '/api/v1/admin/events/1/publish'],
  ['GET', '/api/v1/admin/vote-campaigns/1/live'],
  ['PATCH', '/api/v1/admin/vote-campaigns/1'],
  // 优惠券：我的券 / 后台列表 / 发券 / 作废
  ['GET', '/api/v1/me/coupons'],
  ['GET', '/api/v1/admin/coupons'],
  ['POST', '/api/v1/admin/coupons'],
  ['POST', '/api/v1/admin/coupons/1/revoke'],
  // 协议同意：查询 / 补勾
  ['GET', '/api/v1/me/consents'],
  ['POST', '/api/v1/me/consents'],
  // 场景库（点4）：列表 / 下拉选项 / 详情 / 增改删
  ['GET', '/api/v1/admin/scenes'],
  ['GET', '/api/v1/admin/scenes/options'],
  ['GET', '/api/v1/admin/scenes/1'],
  ['POST', '/api/v1/admin/scenes'],
  ['PATCH', '/api/v1/admin/scenes/1'],
  ['DELETE', '/api/v1/admin/scenes/1'],
];

async function main(): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  const results = await Promise.all(probes.map(async ([method, pathname]) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-Trace-Id': `verify-${pathname}` },
      body: method === 'POST' ? '{}' : undefined,
    });
    const body = (await res.json()) as { code: number };
    return { method, pathname, status: res.status, code: body.code };
  }));

  const missing = results.filter((r) => r.code === BIZ_CODES.RESOURCE_NOT_FOUND);
  assert.equal(missing.length, 0, `以下端点未挂载: ${missing.map((r) => `${r.method} ${r.pathname}`).join(', ')}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(`ROUTES_OK: ${results.length} 个端点全部已挂载（非 404）；未连接 MySQL 的认证/DB 错误为预期`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('ROUTES_FAILED', error);
  process.exit(1);
});
