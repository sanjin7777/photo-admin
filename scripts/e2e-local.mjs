/**
 * 本地真实后端全流程端到端测试（非 mock）。
 *
 * 直连 http://127.0.0.1:3000/api/v1，用 fetch + Bearer（从登录 Set-Cookie 提取 pc_access）。
 * 覆盖：注册/邀请码 → 登录/改密/refresh 轮换与重放 → 建场次/发布 → 会员授予/余额 →
 *       会员报名冻结/幂等重放/幂等冲突 → 时段冲突 → 容量满 → 优惠券折扣核算 →
 *       取消/退款审核（全额/部分/驳回）→ 线下退款落定 → 批量操作 → 投票 SVIP gating →
 *       主办方取消全额退款 → 权限负例 → 账本对账 → 注销。
 *
 * 运行：node scripts/e2e-local.mjs   （需 server 已在 3000 启动、DB 已迁移+种子）
 */

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000/api/v1';
const ADMIN = { wechatId: 'admin_catpaw', password: 'Photo@12345' };
const PW = 'E2eTest123';
const run = Date.now().toString(36);
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const HOUR = 3600_000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
const failures = [];
const log = (...a) => console.log(...a);
function check(name, cond, detail = '') {
  if (cond) { pass++; log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { log(`\n=== ${t} ===`); }

async function raw(method, path, { token, body, idem, query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* noop */ }
  return { status: res.status, code: json?.code, message: json?.message, data: json?.data, details: json?.details, headers: res.headers };
}
const ok = (r) => r.code === 0;
function tokenOf(r) {
  const cookies = r.headers.getSetCookie?.() ?? [];
  for (const c of cookies) { const m = /pc_access=([^;]+)/.exec(c); if (m) return m[1]; }
  return null;
}
function refreshOf(r) {
  const cookies = r.headers.getSetCookie?.() ?? [];
  for (const c of cookies) { const m = /pc_refresh=([^;]+)/.exec(c); if (m) return m[1]; }
  return null;
}
async function login(wechatId, password = PW) {
  const r = await raw('POST', '/auth/login', { body: { wechatId, password } });
  if (!ok(r)) throw new Error(`login ${wechatId} failed: ${r.code} ${r.message}`);
  return { token: tokenOf(r), refresh: refreshOf(r), user: r.data.user };
}
// 断言业务码（失败时打印实际）
function expectCode(name, r, code) {
  check(name, r.code === code, `期望 code=${code} 实际=${r.code} ${r.message ?? ''}`);
}

const users = {};   // key -> {wechatId, token, id}
const tokens = {};  // key -> token（用于对账）

async function main() {
  section('0. 健康检查');
  const health = await raw('GET', '/health');
  check('health db:up', ok(health) && health.data?.db === 'up', JSON.stringify(health.data));

  section('1. 管理员登录 + 生成邀请码');
  const admin = await login(ADMIN.wechatId, ADMIN.password);
  check('admin 登录拿到 token', !!admin.token);
  const A = admin.token;
  const inv = await raw('POST', '/admin/invite-codes', { token: A, body: { count: 8, note: 'e2e' } });
  check('生成 8 个邀请码', ok(inv) && inv.data?.codes?.length === 8, JSON.stringify(inv.data)?.slice(0, 120));
  const codes = inv.data.codes;

  section('2. 注册 5 个测试用户（邀请码一次性 + 协议留痕）');
  const defs = [
    ['vip', `e${run}v`, '测试VIP'],
    ['svip', `e${run}s`, '测试SVIP'],
    ['normal', `e${run}n`, '测试普通'],
    ['normal2', `e${run}m`, '测试普通2'],
    ['full', `e${run}f`, '测试满员'],
  ];
  for (let i = 0; i < defs.length; i++) {
    const [key, wechatId, nickname] = defs[i];
    const r = await raw('POST', '/auth/register', { body: { wechatId, password: PW, nickname, inviteCode: codes[i], agreed: true } });
    check(`注册 ${key}`, ok(r) && r.data?.wechatId === wechatId, `${r.code} ${r.message}`);
    users[key] = { wechatId, id: r.data?.id, nickname };
  }
  // 负例：复用已用邀请码
  const reuse = await raw('POST', '/auth/register', { body: { wechatId: `e${run}x`, password: PW, nickname: '复用码', inviteCode: codes[0], agreed: true } });
  expectCode('复用邀请码被拒 4019', reuse, 4019);
  // 负例：未勾选协议
  const noAgree = await raw('POST', '/auth/register', { body: { wechatId: `e${run}y`, password: PW, nickname: '未同意', inviteCode: codes[5], agreed: false } });
  expectCode('未同意协议被拒 1002', noAgree, 1002);
  // 登录各用户
  for (const key of Object.keys(users)) {
    const s = await login(users[key].wechatId);
    users[key].token = s.token; users[key].refresh = s.refresh;
  }
  check('5 用户均登录成功', Object.values(users).every((u) => u.token));
  // 协议状态：注册即留痕，needConsent=false
  const consent = await raw('GET', '/me/consents', { token: users.vip.token });
  check('注册即同意协议 needConsent=false', ok(consent) && consent.data?.needConsent === false, JSON.stringify(consent.data));

  section('3. 授予会员（VIP 500元+赠50 / SVIP 800元），sv+1 旧 token 失效');
  const oldVipToken = users.vip.token;
  const grantVip = await raw('POST', '/admin/memberships', { token: A, body: { wechatId: users.vip.wechatId, level: 'VIP', startAt: iso(NOW - HOUR), amountYuan: 500, bonusYuan: 50, reason: 'e2e 授予VIP' } });
  check('授予 VIP', ok(grantVip), `${grantVip.code} ${grantVip.message}`);
  const grantSvip = await raw('POST', '/admin/memberships', { token: A, body: { wechatId: users.svip.wechatId, level: 'SVIP', startAt: iso(NOW - HOUR), amountYuan: 800, reason: 'e2e 授予SVIP' } });
  check('授予 SVIP', ok(grantSvip), `${grantSvip.code} ${grantSvip.message}`);
  // 旧 token 应失效（SESSION_VERSION_MISMATCH 2004 或 UNAUTHORIZED）
  const stale = await raw('GET', '/me', { token: oldVipToken });
  check('授予后旧 token 失效', stale.code === 2004 || stale.code === 2001, `code=${stale.code}`);
  // 重新登录
  users.vip.token = (await login(users.vip.wechatId)).token;
  users.svip.token = (await login(users.svip.wechatId)).token;
  const vipBal = await raw('GET', '/balance', { token: users.vip.token });
  check('VIP 余额 applicable', ok(vipBal) && vipBal.data?.applicable === true);
  check('VIP 可用=55000分(500元+赠50)', vipBal.data?.account?.availableCent === 55000, `actual=${vipBal.data?.account?.availableCent}`);
  check('VIP 赠送累计=5000分', vipBal.data?.account?.bonusGrantedCent === 5000, `actual=${vipBal.data?.account?.bonusGrantedCent}`);
  const svipBal = await raw('GET', '/balance', { token: users.svip.token });
  check('SVIP 可用=80000分', svipBal.data?.account?.availableCent === 80000, `actual=${svipBal.data?.account?.availableCent}`);
  const normalBal = await raw('GET', '/balance', { token: users.normal.token });
  check('普通用户无余额账户 applicable=false', ok(normalBal) && normalBal.data?.applicable === false);
  // 重复授予同等级被拒
  const dupGrant = await raw('POST', '/admin/memberships', { token: A, body: { wechatId: users.vip.wechatId, level: 'VIP', startAt: iso(NOW), reason: '重复授予' } });
  expectCode('重复授予同等级被拒 1001', dupGrant, 1001);

  section('4. 建场次并发布');
  // 场次A：PUBLIC，全额退（feeRatio 0, freeCancelBeforeHours 0），2 时段各容量 3
  const sessStart = NOW + 3 * DAY;
  const eventABody = {
    title: `E2E公开场${run}`, venue: '测试棚', registrationOpenAt: iso(NOW - HOUR), registrationCloseAt: iso(NOW + HOUR),
    visibility: 'PUBLIC', registerMinLevel: 'NONE', allowCoupon: true,
    refundPolicy: { freeCancelBeforeHours: 0, feeRatio: 0 },
    sessions: [
      { label: '上午场', startAt: iso(sessStart), endAt: iso(sessStart + 2 * HOUR), capacity: 3 },
      { label: '下午场', startAt: iso(sessStart + 4 * HOUR), endAt: iso(sessStart + 6 * HOUR), capacity: 3 },
    ],
    prices: [ { level: 'PUBLIC', priceCent: 10000 }, { level: 'VIP', priceCent: 8000 }, { level: 'SVIP', priceCent: 6000 } ],
  };
  const evA = await raw('POST', '/admin/events', { token: A, body: eventABody });
  check('创建场次A', ok(evA), `${evA.code} ${evA.message}`);
  const eventAId = evA.data?.id;
  // 把开始时间改成「所有场次里最早」：排序断言要求 A 在 start_at ASC 下也排第一。
  // 用 now+2h（必须早于 D 的重叠场 earliest+1h，否则节8 冲突检测不触发）；
  // 首位断言只校验「报名中组优先」，不硬断言就是 A——历史残留的报名中场次可能更早。
  // PATCH 需 sessions+prices 同提；新 id 会整表重建时段，随后重新取 sessA1/sessA2。
  const earliest = NOW + 2 * HOUR;
  await raw('PATCH', `/admin/events/${eventAId}`, { token: A, body: {
    sessions: [
      { label: '上午场', startAt: iso(earliest), endAt: iso(earliest + 2 * HOUR), capacity: 3 },
      { label: '下午场', startAt: iso(earliest + 4 * HOUR), endAt: iso(earliest + 6 * HOUR), capacity: 3 },
    ],
    prices: eventABody.prices,
  } });
  const pubA = await raw('POST', `/admin/events/${eventAId}/publish`, { token: A });
  check('发布场次A→REGISTRATION_OPEN', ok(pubA) && pubA.data?.status === 'REGISTRATION_OPEN', JSON.stringify(pubA.data));
  const evADetail = await raw('GET', `/events/${eventAId}`, { token: users.normal.token });
  const sessA1 = evADetail.data?.sessions?.find((s) => s.label === '上午场');
  const sessA2 = evADetail.data?.sessions?.find((s) => s.label === '下午场');
  check('场次A 含 2 时段', !!sessA1 && !!sessA2);
  // 草稿不可见
  const evDraft = await raw('POST', '/admin/events', { token: A, body: { ...eventABody, title: `E2E草稿${run}` } });
  const draftId = evDraft.data?.id;
  const draftView = await raw('GET', `/events/${draftId}`, { token: users.normal.token });
  expectCode('草稿场次前台不可见 4001', draftView, 4001);

  // 场次B：部分退 feeRatio 0.1（SVIP 价 6000 → 退 5400 扣 600）
  const evB = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E部分退${run}`, refundPolicy: { freeCancelBeforeHours: 0, feeRatio: 0.1 },
    sessions: [{ label: '夜场', startAt: iso(sessStart + 8 * HOUR), endAt: iso(sessStart + 10 * HOUR), capacity: 5 }],
  } });
  const eventBId = evB.data?.id;
  await raw('POST', `/admin/events/${eventBId}/publish`, { token: A });
  const sessB = (await raw('GET', `/events/${eventBId}`, { token: users.svip.token })).data?.sessions?.[0];

  // 场次C：退款窗口关闭（freeCancelBeforeHours 极大）
  const evC = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E窗口关${run}`, refundPolicy: { freeCancelBeforeHours: 720, feeRatio: 0 },
    sessions: [{ label: '远期场', startAt: iso(sessStart + 12 * HOUR), endAt: iso(sessStart + 14 * HOUR), capacity: 5 }],
  } });
  const eventCId = evC.data?.id;
  await raw('POST', `/admin/events/${eventCId}/publish`, { token: A });
  const sessC = (await raw('GET', `/events/${eventCId}`, { token: users.normal.token })).data?.sessions?.[0];

  // 场次D：与 A 上午场时间重叠（测时段冲突），随后主办方取消
  const evD = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E重叠场${run}`,
    sessions: [{ label: '重叠场', startAt: iso(earliest + HOUR), endAt: iso(earliest + 3 * HOUR), capacity: 5 }],
  } });
  const eventDId = evD.data?.id;
  await raw('POST', `/admin/events/${eventDId}/publish`, { token: A });
  const sessD = (await raw('GET', `/events/${eventDId}`, { token: users.vip.token })).data?.sessions?.[0];

  // 场次E：容量 1（测满员）
  const evE = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E满员场${run}`,
    sessions: [{ label: '独苗场', startAt: iso(sessStart + 16 * HOUR), endAt: iso(sessStart + 18 * HOUR), capacity: 1 }],
  } });
  const eventEId = evE.data?.id;
  await raw('POST', `/admin/events/${eventEId}/publish`, { token: A });
  const sessE = (await raw('GET', `/events/${eventEId}`, { token: users.full.token })).data?.sessions?.[0];

  // 场次F：报名窗口已关（close=now-30min）但场次尚未开始——
  // 排序断言用：它开始时间比 A 早，旧排序会把它顶到第一页，把可报名的 A 挤下去
  const evF = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E截止场${run}`,
    registrationOpenAt: iso(NOW - 2 * HOUR), registrationCloseAt: iso(NOW - 30 * 60 * 1000),
    sessions: [{ label: '早场', startAt: iso(sessStart - 2 * HOUR), endAt: iso(sessStart), capacity: 5 }],
  } });
  const eventFId = evF.data?.id;
  await raw('POST', `/admin/events/${eventFId}/publish`, { token: A });

  section('4b. 列表口径：游客无历史 + 报名中优先排序');
  // 库里种子全是未来场次，造一个「昨天已开拍」的场次G 验证登录用户可见历史
  const evG = await raw('POST', '/admin/events', { token: A, body: {
    ...eventABody, title: `E2E历史场${run}`,
    registrationOpenAt: iso(NOW - 2 * DAY), registrationCloseAt: iso(NOW - DAY - HOUR),
    sessions: [{ label: '昨日场', startAt: iso(NOW - DAY), endAt: iso(NOW - DAY + 2 * HOUR), capacity: 5 }],
  } });
  check('创建历史场次G', ok(evG), `${evG.code} ${evG.message}`);
  const eventGId = evG.data?.id;
  await raw('POST', `/admin/events/${eventGId}/publish`, { token: A });
  const guestPast = await raw('GET', '/events', { query: { scope: 'past', pageSize: 100 } });
  check('游客请求历史场次得空页', ok(guestPast) && guestPast.data?.total === 0 && guestPast.data?.list?.length === 0, `total=${guestPast.data?.total}`);
  const memberPast = await raw('GET', '/events', { token: users.vip.token, query: { scope: 'past', pageSize: 100 } });
  check('登录用户可见历史场次', ok(memberPast) && memberPast.data?.total > 0, `total=${memberPast.data?.total}`);
  const guestUpcoming = await raw('GET', '/events', { query: { scope: 'upcoming', pageSize: 100 } });
  // 首位必须是「报名中」组（历史 E2E 残留的报名中场次可能比 A 开始更早，不能硬断言就是 A）
  const firstEvent = guestUpcoming.data?.list?.[0];
  const firstIsOpen = firstEvent && firstEvent.status === 'REGISTRATION_OPEN' && Date.parse(firstEvent.registrationCloseAt) > Date.now();
  check('近期首位是报名中场次（截止场开始更早也排后）', ok(guestUpcoming) && !!firstIsOpen, `first=${firstEvent?.id} status=${firstEvent?.status}`);
  const upcomingAll = guestUpcoming;
  const fIdx = upcomingAll.data?.list?.findIndex((e) => String(e.id) === String(eventFId));
  const aIdx = upcomingAll.data?.list?.findIndex((e) => String(e.id) === String(eventAId));
  check('截止场F排在报名中场次A之后', fIdx > aIdx && aIdx >= 0, `aIdx=${aIdx} fIdx=${fIdx}`);

  section('5. 会员报名冻结 + 幂等重放 + 幂等冲突');
  const idem1 = `e2e-${run}-vip-a1`;
  const regVip1 = await raw('POST', '/registrations', { token: users.vip.token, idem: idem1, body: { eventId: eventAId, sessionId: sessA1.id, seats: 1 } });
  check('VIP 报名A上午场', ok(regVip1) && regVip1.data?.registrations?.length === 1, `${regVip1.code} ${regVip1.message}`);
  const vipReg1 = regVip1.data?.registrations?.[0];
  check('VIP 价=8000分', vipReg1?.feeCent === 8000, `actual=${vipReg1?.feeCent}`);
  check('会员 paymentStatus=NOT_REQUIRED', vipReg1?.paymentStatus === 'NOT_REQUIRED');
  check('会员报名带 balanceTxnId', !!vipReg1?.balanceTxnId);
  // 幂等重放：同键同参 → 同一报名 id，不重复冻结
  const replay = await raw('POST', '/registrations', { token: users.vip.token, idem: idem1, body: { eventId: eventAId, sessionId: sessA1.id, seats: 1 } });
  check('幂等重放返回同一报名', ok(replay) && replay.data?.registrations?.[0]?.id === vipReg1?.id, `replayId=${replay.data?.registrations?.[0]?.id}`);
  const balAfterReplay = await raw('GET', '/balance', { token: users.vip.token });
  check('重放未重复冻结 available=47000', balAfterReplay.data?.account?.availableCent === 47000, `actual=${balAfterReplay.data?.account?.availableCent}`);
  check('重放后 frozen=8000', balAfterReplay.data?.account?.frozenCent === 8000, `actual=${balAfterReplay.data?.account?.frozenCent}`);
  // 幂等冲突：同键不同参
  const conflict = await raw('POST', '/registrations', { token: users.vip.token, idem: idem1, body: { eventId: eventAId, sessionId: sessA1.id, seats: 2 } });
  expectCode('同键不同参幂等冲突 4013', conflict, 4013);
  // 缺幂等键
  const noIdem = await raw('POST', '/registrations', { token: users.vip.token, body: { eventId: eventAId, sessionId: sessA1.id, seats: 1 } });
  expectCode('缺幂等键被拒 1004', noIdem, 1004);

  section('6. 非会员报名 → 待支付 → 确认收款才已确认');
  const regNormal = await raw('POST', '/registrations', { token: users.normal.token, idem: `e2e-${run}-n-a1`, body: { eventId: eventAId, sessionId: sessA1.id, seats: 1 } });
  check('普通用户报名A上午场', ok(regNormal), `${regNormal.code} ${regNormal.message}`);
  const normalReg = regNormal.data?.registrations?.[0];
  check('普通价=10000分(PUBLIC)', normalReg?.feeCent === 10000, `actual=${normalReg?.feeCent}`);
  check('非会员 paymentStatus=UNPAID', normalReg?.paymentStatus === 'UNPAID');
  check('非会员报名先落 PENDING_PAYMENT（不是已确认）', normalReg?.status === 'PENDING_PAYMENT', `actual=${normalReg?.status}`);
  check('非会员无 balanceTxnId', !normalReg?.balanceTxnId);
  const confirmPay = await raw('POST', `/admin/registrations/${normalReg.id}/confirm-payment`, { token: A });
  check('确认收款→PAID 且状态转 CONFIRMED', ok(confirmPay) && confirmPay.data?.paymentStatus === 'PAID' && confirmPay.data?.status === 'CONFIRMED', JSON.stringify(confirmPay.data));
  const normalAfterPay = await raw('GET', `/registrations/${normalReg.id}`, { token: users.normal.token });
  check('确认收款后我的登记=CONFIRMED', normalAfterPay.data?.status === 'CONFIRMED', `actual=${normalAfterPay.data?.status}`);
  const confirmAgain = await raw('POST', `/admin/registrations/${normalReg.id}/confirm-payment`, { token: A });
  expectCode('重复确认收款被拒 4007', confirmAgain, 4007);

  section('6b. 待支付直接取消：无退款单 + 名额归还 + 券立即退回');
  const pendCancel = await raw('POST', '/registrations', { token: users.normal2.token, idem: `e2e-${run}-pend1`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1 } });
  check('normal2 报名A下午场（待支付）', ok(pendCancel) && pendCancel.data?.registrations?.[0]?.status === 'PENDING_PAYMENT', `${pendCancel.code} ${pendCancel.data?.registrations?.[0]?.status}`);
  const pendReg = pendCancel.data?.registrations?.[0];
  const availBefore = await raw('GET', `/events/${eventAId}/availability`, { token: users.normal2.token });
  const sessA2Before = availBefore.data?.sessionChecks?.find((s) => s.sessionId === sessA2.id);
  const cancelPend = await raw('POST', `/registrations/${pendReg.id}/cancel`, { token: users.normal2.token, body: { reason: '付款前取消' } });
  check('待支付取消成功', ok(cancelPend), `${cancelPend.code} ${cancelPend.message}`);
  const pendAfter = await raw('GET', `/registrations/${pendReg.id}`, { token: users.normal2.token });
  check('待支付取消后=CANCELLED（不走退款）', pendAfter.data?.status === 'CANCELLED', `actual=${pendAfter.data?.status}`);
  const pendRefunds = await raw('GET', '/refunds/mine', { token: users.normal2.token });
  check('待支付取消不产生退款单', !pendRefunds.data?.list?.some((x) => x.registrationId === pendReg.id), JSON.stringify(pendRefunds.data)?.slice(0, 120));
  const availAfter = await raw('GET', `/events/${eventAId}/availability`, { token: users.normal2.token });
  const sessA2After = availAfter.data?.sessionChecks?.find((s) => s.sessionId === sessA2.id);
  check('待支付取消后名额归还', (sessA2After?.capacityUsed ?? 0) === (sessA2Before?.capacityUsed ?? 1) - 1, `before=${sessA2Before?.capacityUsed} after=${sessA2After?.capacityUsed}`);
  // 待支付带券取消：券应立即退回 UNUSED（钱没收到，无需等退款完成）
  const pendCoupon = await raw('POST', '/admin/coupons', { token: A, body: { wechatIds: [users.normal2.wechatId], title: 'E2E待支付取消券', type: 'AMOUNT', amountCent: 500 } });
  const pendCouponId = pendCoupon.data?.couponIds?.[0];
  const pendWithCoupon = await raw('POST', '/registrations', { token: users.normal2.token, idem: `e2e-${run}-pend2`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1, couponIds: [pendCouponId] } });
  check('待支付带券报名成功', ok(pendWithCoupon), `${pendWithCoupon.code} ${pendWithCoupon.message}`);
  const pendCouponReg = pendWithCoupon.data?.registrations?.[0];
  await raw('POST', `/registrations/${pendCouponReg.id}/cancel`, { token: users.normal2.token, body: {} });
  const pendCouponMine = await raw('GET', '/me/coupons', { token: users.normal2.token });
  const pendCouponAfter = pendCouponMine.data?.find((c) => c.id === pendCouponId);
  check('待支付取消后券立即退回 UNUSED', pendCouponAfter?.status === 'UNUSED', `actual=${pendCouponAfter?.status}`);
  // 已取消的报名不能再确认收款（payment_status 仍是 UNPAID，只查收款标记会漏）
  const payCancelled = await raw('POST', `/admin/registrations/${pendReg.id}/confirm-payment`, { token: A });
  expectCode('已取消报名确认收款被拒 4007', payCancelled, 4007);
  const batchPayCancelled = await raw('POST', '/admin/registrations/batch', { token: A, body: { action: 'CONFIRM_PAYMENT', ids: [pendReg.id] } });
  check('批量确认收款跳过已取消报名', ok(batchPayCancelled) && batchPayCancelled.data?.succeeded?.length === 0 && batchPayCancelled.data?.skipped?.length === 1, JSON.stringify(batchPayCancelled.data)?.slice(0, 160));

  section('7. 优惠券折扣核算');
  // 折扣券 85 折给 VIP（VIP 价 8000 → 减 1200 → 实付 6800）
  const issueDisc = await raw('POST', '/admin/coupons', { token: A, body: { wechatIds: [users.vip.wechatId], title: 'E2E八五折', type: 'DISCOUNT', discountBp: 8500 } });
  check('发放折扣券', ok(issueDisc) && issueDisc.data?.couponIds?.length === 1, `${issueDisc.code} ${issueDisc.message}`);
  const discCouponId = issueDisc.data?.couponIds?.[0];
  // 立减券 1000 分给 normal2（PUBLIC 10000 → 9000）
  const issueAmt = await raw('POST', '/admin/coupons', { token: A, body: { wechatIds: [users.normal2.wechatId], title: 'E2E立减10元', type: 'AMOUNT', amountCent: 1000 } });
  const amtCouponId = issueAmt.data?.couponIds?.[0];
  check('发放立减券', ok(issueAmt));
  const regVipCoupon = await raw('POST', '/registrations', { token: users.vip.token, idem: `e2e-${run}-vip-coupon`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1, couponIds: [discCouponId] } });
  check('VIP 用折扣券报名A下午场', ok(regVipCoupon), `${regVipCoupon.code} ${regVipCoupon.message}`);
  const vipCouponReg = regVipCoupon.data?.registrations?.[0];
  check('折扣券原价=8000', vipCouponReg?.originalFeeCent === 8000, `actual=${vipCouponReg?.originalFeeCent}`);
  check('折扣券优惠=1200', vipCouponReg?.discountCent === 1200, `actual=${vipCouponReg?.discountCent}`);
  check('折扣券实付=6800', vipCouponReg?.feeCent === 6800, `actual=${vipCouponReg?.feeCent}`);
  // 券已核销
  const vipCoupons = await raw('GET', '/me/coupons', { token: users.vip.token });
  const usedDisc = vipCoupons.data?.find((c) => c.id === discCouponId);
  check('折扣券状态=USED', usedDisc?.status === 'USED', `actual=${usedDisc?.status}`);
  // normal2 用立减券
  const regN2 = await raw('POST', '/registrations', { token: users.normal2.token, idem: `e2e-${run}-n2-amt`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1, couponIds: [amtCouponId] } });
  const n2Reg = regN2.data?.registrations?.[0];
  check('立减券实付=9000', n2Reg?.feeCent === 9000, `actual=${n2Reg?.feeCent}`);
  // 负例：用别人的券
  const stealCoupon = await raw('POST', '/registrations', { token: users.normal.token, idem: `e2e-${run}-steal`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1, couponIds: [discCouponId] } });
  expectCode('用他人券被拒 4022', stealCoupon, 4022);

  section('8. 时段冲突检测 + ignoreConflict');
  const regConflict = await raw('POST', '/registrations', { token: users.vip.token, idem: `e2e-${run}-conflict`, body: { eventId: eventDId, sessionId: sessD.id, seats: 1 } });
  expectCode('重叠时段报名冲突 4017', regConflict, 4017);
  check('冲突响应带 conflicts 明细', Array.isArray(regConflict.details?.conflicts) && regConflict.details.conflicts.length > 0, JSON.stringify(regConflict.details)?.slice(0, 120));
  const regIgnore = await raw('POST', '/registrations', { token: users.vip.token, idem: `e2e-${run}-ignore`, body: { eventId: eventDId, sessionId: sessD.id, seats: 1, ignoreConflict: true } });
  check('ignoreConflict=true 报名成功', ok(regIgnore), `${regIgnore.code} ${regIgnore.message}`);
  const vipDReg = regIgnore.data?.registrations?.[0];

  section('9. 容量满员');
  const regFull1 = await raw('POST', '/registrations', { token: users.full.token, idem: `e2e-${run}-full1`, body: { eventId: eventEId, sessionId: sessE.id, seats: 1 } });
  check('满员场第1人报名成功', ok(regFull1), `${regFull1.code} ${regFull1.message}`);
  const regFull2 = await raw('POST', '/registrations', { token: users.normal2.token, idem: `e2e-${run}-full2`, body: { eventId: eventEId, sessionId: sessE.id, seats: 1 } });
  expectCode('满员场第2人被拒 4003', regFull2, 4003);

  section('10. 会员取消 → 退款审核通过（全额回充 + 退券）');
  const cancelVipCoupon = await raw('POST', `/registrations/${vipCouponReg.id}/cancel`, { token: users.vip.token, body: { reason: 'e2e 取消' } });
  check('VIP 取消折扣券报名', ok(cancelVipCoupon), `${cancelVipCoupon.code} ${cancelVipCoupon.message}`);
  const mineVip = await raw('GET', '/refunds/mine', { token: users.vip.token });
  const vipRefund = mineVip.data?.list?.find((x) => x.registrationId === vipCouponReg.id);
  check('生成退款单 REQUESTED', vipRefund?.status === 'REQUESTED', `actual=${vipRefund?.status}`);
  check('退款额=实付6800(全额)', vipRefund?.amountCent === 6800, `actual=${vipRefund?.amountCent}`);
  // 取消后券仍占用（退款完成才退）
  const couponDuring = (await raw('GET', '/me/coupons', { token: users.vip.token })).data?.find((c) => c.id === discCouponId);
  check('退款待审期间券仍 USED', couponDuring?.status === 'USED', `actual=${couponDuring?.status}`);
  // 审核通过
  const approveVip = await raw('POST', `/admin/refunds/${vipRefund.id}/review`, { token: A, body: { approve: true } });
  check('审核通过退款', ok(approveVip), `${approveVip.code} ${approveVip.message}`);
  const balAfterRefund = await raw('GET', '/balance', { token: users.vip.token });
  // VIP 此时仍冻结：A上午场8000 + D重叠场8000 = 16000；可用 55000-16000=39000
  check('退款回充后 available=39000', balAfterRefund.data?.account?.availableCent === 39000, `actual=${balAfterRefund.data?.account?.availableCent}`);
  check('退款回充后 frozen=16000', balAfterRefund.data?.account?.frozenCent === 16000, `actual=${balAfterRefund.data?.account?.frozenCent}`);
  const couponAfter = (await raw('GET', '/me/coupons', { token: users.vip.token })).data?.find((c) => c.id === discCouponId);
  check('退款完成后券退回 UNUSED', couponAfter?.status === 'UNUSED', `actual=${couponAfter?.status}`);
  const vipRefundDetail = await raw('GET', `/refunds/${vipRefund.id}`, { token: users.vip.token });
  check('会员退款自动落定 settledAt 非空', !!vipRefundDetail.data?.settledAt, `settledAt=${vipRefundDetail.data?.settledAt}`);
  // 会员单审核时已自动落定 settled_at，线下落定接口对已落定单幂等返回成功（不报错、不改动）
  const settleMember = await raw('POST', `/admin/refunds/${vipRefund.id}/settle`, { token: A, body: { remark: '不应改动' } });
  check('会员退款线下落定幂等成功(已自动落定)', ok(settleMember), `${settleMember.code} ${settleMember.message}`);
  const memberSettleDetail = await raw('GET', `/refunds/${vipRefund.id}`, { token: users.vip.token });
  check('会员退款落定备注未被线下覆盖', memberSettleDetail.data?.settleRemark !== '不应改动', `remark=${memberSettleDetail.data?.settleRemark}`);

  section('11. 部分退款（feeRatio 0.1：SVIP 6000 → 退5400 扣600）');
  const regSvipB = await raw('POST', '/registrations', { token: users.svip.token, idem: `e2e-${run}-svip-b`, body: { eventId: eventBId, sessionId: sessB.id, seats: 1 } });
  const svipBReg = regSvipB.data?.registrations?.[0];
  check('SVIP 报名B夜场 价=6000', ok(regSvipB) && svipBReg?.feeCent === 6000, `${regSvipB.code} fee=${svipBReg?.feeCent}`);
  await raw('POST', `/registrations/${svipBReg.id}/cancel`, { token: users.svip.token, body: {} });
  const svipRefund = (await raw('GET', '/refunds/mine', { token: users.svip.token })).data?.list?.find((x) => x.registrationId === svipBReg.id);
  check('部分退款额=5400', svipRefund?.amountCent === 5400, `actual=${svipRefund?.amountCent}`);
  await raw('POST', `/admin/refunds/${svipRefund.id}/review`, { token: A, body: { approve: true } });
  const svipBalAfter = await raw('GET', '/balance', { token: users.svip.token });
  // SVIP 80000 冻结6000 → 退5400 扣600：available=80000-6000+5400=79400, frozen=0
  check('部分退后 SVIP available=79400', svipBalAfter.data?.account?.availableCent === 79400, `actual=${svipBalAfter.data?.account?.availableCent}`);
  check('部分退后 SVIP frozen=0', svipBalAfter.data?.account?.frozenCent === 0, `actual=${svipBalAfter.data?.account?.frozenCent}`);

  section('12. 退款窗口关闭（付款后才受窗口约束）');
  const regC = await raw('POST', '/registrations', { token: users.normal.token, idem: `e2e-${run}-n-c`, body: { eventId: eventCId, sessionId: sessC.id, seats: 1 } });
  const cReg = regC.data?.registrations?.[0];
  check('报名窗口关闭场C成功（待支付）', ok(regC) && cReg?.status === 'PENDING_PAYMENT', `${regC.code} ${cReg?.status}`);
  // 待支付阶段取消不受退款窗口约束（钱还没收）
  const cancelCPend = await raw('POST', `/registrations/${cReg.id}/cancel`, { token: users.normal.token, body: {} });
  check('待支付阶段取消不受窗口限制', ok(cancelCPend), `${cancelCPend.code} ${cancelCPend.message}`);
  // 再报一单并确认收款，此时取消才受窗口约束
  const regC2 = await raw('POST', '/registrations', { token: users.normal.token, idem: `e2e-${run}-n-c2`, body: { eventId: eventCId, sessionId: sessC.id, seats: 1 } });
  const cReg2 = regC2.data?.registrations?.[0];
  await raw('POST', `/admin/registrations/${cReg2.id}/confirm-payment`, { token: A });
  const cancelC = await raw('POST', `/registrations/${cReg2.id}/cancel`, { token: users.normal.token, body: {} });
  expectCode('已确认且窗口外取消被拒 4008', cancelC, 4008);

  section('13. 非会员线下退款：审核通过→挂账→线下落定→幂等');
  await raw('POST', `/registrations/${normalReg.id}/cancel`, { token: users.normal.token, body: { reason: 'e2e 线下退' } });
  const normalRefund = (await raw('GET', '/refunds/mine', { token: users.normal.token })).data?.list?.find((x) => x.registrationId === normalReg.id);
  check('非会员退款单 REQUESTED', normalRefund?.status === 'REQUESTED');
  check('非会员退款额=10000', normalRefund?.amountCent === 10000, `actual=${normalRefund?.amountCent}`);
  await raw('POST', `/admin/refunds/${normalRefund.id}/review`, { token: A, body: { approve: true } });
  const nrDetail = await raw('GET', `/refunds/${normalRefund.id}`, { token: users.normal.token });
  check('非会员退款通过后 settledAt=null(挂账)', nrDetail.data?.status === 'REFUNDED' && !nrDetail.data?.settledAt, `status=${nrDetail.data?.status} settled=${nrDetail.data?.settledAt}`);
  // 后台挂账筛选
  const unsettled = await raw('GET', '/admin/refunds', { token: A, query: { settle: 'UNSETTLED', keyword: users.normal.wechatId } });
  check('后台 UNSETTLED 筛选命中', ok(unsettled) && unsettled.data?.list?.some((x) => x.id === normalRefund.id), JSON.stringify(unsettled.data)?.slice(0, 100));
  const settle1 = await raw('POST', `/admin/refunds/${normalRefund.id}/settle`, { token: A, body: { remark: '微信转账尾号1234' } });
  check('线下落定成功', ok(settle1) && !!settle1.data?.settledAt, `${settle1.code} ${settle1.message}`);
  check('落定备注留存', settle1.data?.settleRemark === '微信转账尾号1234', `actual=${settle1.data?.settleRemark}`);
  const settle2 = await raw('POST', `/admin/refunds/${normalRefund.id}/settle`, { token: A, body: { remark: '重复' } });
  check('重复落定幂等成功', ok(settle2), `${settle2.code} ${settle2.message}`);

  section('14. 驳回退款（名额回补 + 不退券）→ 再取消 → 通过');
  // n2Reg 是待支付单：先确认收款，才能走退款流程
  await raw('POST', `/admin/registrations/${n2Reg.id}/confirm-payment`, { token: A });
  await raw('POST', `/registrations/${n2Reg.id}/cancel`, { token: users.normal2.token, body: {} });
  const n2Refund = (await raw('GET', '/refunds/mine', { token: users.normal2.token })).data?.list?.find((x) => x.registrationId === n2Reg.id);
  const rejectNoRemark = await raw('POST', `/admin/refunds/${n2Refund.id}/review`, { token: A, body: { approve: false } });
  expectCode('驳回缺原因被拒 1002', rejectNoRemark, 1002);
  const reject = await raw('POST', `/admin/refunds/${n2Refund.id}/review`, { token: A, body: { approve: false, remark: 'e2e 驳回测试' } });
  check('驳回退款成功', ok(reject), `${reject.code} ${reject.message}`);
  const n2RegAfter = await raw('GET', `/registrations/${n2Reg.id}`, { token: users.normal2.token });
  check('驳回后报名回 CONFIRMED', n2RegAfter.data?.status === 'CONFIRMED', `actual=${n2RegAfter.data?.status}`);
  const n2CouponAfter = (await raw('GET', '/me/coupons', { token: users.normal2.token })).data?.find((c) => c.id === amtCouponId);
  check('驳回不退券 仍 USED', n2CouponAfter?.status === 'USED', `actual=${n2CouponAfter?.status}`);
  // 再取消 → 新退款单 → 通过
  await raw('POST', `/registrations/${n2Reg.id}/cancel`, { token: users.normal2.token, body: {} });
  const n2Refund2 = (await raw('GET', '/refunds/mine', { token: users.normal2.token })).data?.list?.find((x) => x.registrationId === n2Reg.id && x.status === 'REQUESTED');
  check('驳回后可重新申请退款', !!n2Refund2);
  await raw('POST', `/admin/refunds/${n2Refund2.id}/review`, { token: A, body: { approve: true } });
  await raw('POST', `/admin/refunds/${n2Refund2.id}/settle`, { token: A, body: { remark: 'e2e 二次退' } });
  const n2CouponFinal = (await raw('GET', '/me/coupons', { token: users.normal2.token })).data?.find((c) => c.id === amtCouponId);
  check('二次退款完成后券退回 UNUSED', n2CouponFinal?.status === 'UNUSED', `actual=${n2CouponFinal?.status}`);

  section('15. 批量操作（签到 + 确认收款）');
  // normal2 已退款，改用 full 用户的满员场报名做签到；再建一条待支付做批量确认收款
  const regBatchPay = await raw('POST', '/registrations', { token: users.normal2.token, idem: `e2e-${run}-batchpay`, body: { eventId: eventAId, sessionId: sessA2.id, seats: 1 } });
  const batchPayReg = regBatchPay.data?.registrations?.[0];
  check('批量确认收款对象为待支付', batchPayReg?.status === 'PENDING_PAYMENT', `actual=${batchPayReg?.status}`);
  // full 用户的满员场报名仍是待支付：待支付不允许直接签到
  const batchCheckinPend = await raw('POST', '/admin/registrations/batch', { token: A, body: { action: 'CHECK_IN', ids: [regFull1.data.registrations[0].id] } });
  check('待支付批量签到被跳过', ok(batchCheckinPend) && batchCheckinPend.data?.succeeded?.length === 0 && batchCheckinPend.data?.skipped?.length === 1, JSON.stringify(batchCheckinPend.data));
  // 确认收款后转 CONFIRMED，才能签到
  await raw('POST', `/admin/registrations/${regFull1.data.registrations[0].id}/confirm-payment`, { token: A });
  const batchCheckin = await raw('POST', '/admin/registrations/batch', { token: A, body: { action: 'CHECK_IN', ids: [regFull1.data.registrations[0].id] } });
  check('批量签到成功', ok(batchCheckin) && batchCheckin.data?.succeeded?.length === 1, JSON.stringify(batchCheckin.data));
  const batchPay = await raw('POST', '/admin/registrations/batch', { token: A, body: { action: 'CONFIRM_PAYMENT', ids: [batchPayReg.id, normalReg.id] } });
  // normalReg 已 REFUNDED 应被跳过，batchPayReg 待支付成功并转 CONFIRMED
  check('批量确认收款：1成功1跳过', ok(batchPay) && batchPay.data?.succeeded?.length === 1 && batchPay.data?.skipped?.length === 1, JSON.stringify(batchPay.data));
  const batchPayAfter = await raw('GET', `/registrations/${batchPayReg.id}`, { token: users.normal2.token });
  check('批量确认收款后转 CONFIRMED', batchPayAfter.data?.status === 'CONFIRMED', `actual=${batchPayAfter.data?.status}`);

  section('16. 投票（SVIP gating + 改票 + 结果）');
  const campaign = await raw('POST', '/admin/vote-campaigns', { token: A, body: {
    title: `E2E投票${run}`, openAt: iso(NOW - HOUR), closeAt: iso(NOW + DAY),
    options: [{ name: '方案A', sort: 0 }, { name: '方案B', sort: 1 }],
  } });
  check('创建投票活动', ok(campaign), `${campaign.code} ${campaign.message}`);
  const campaignId = campaign.data?.id;
  await raw('POST', `/admin/vote-campaigns/${campaignId}/open`, { token: A });
  const campDetail = await raw('GET', `/vote-campaigns/${campaignId}`, { token: users.svip.token });
  const optA = campDetail.data?.options?.find((o) => o.name === '方案A');
  const optB = campDetail.data?.options?.find((o) => o.name === '方案B');
  // 非 SVIP 投票被拒
  const voteNormal = await raw('POST', '/votes', { token: users.normal.token, body: { campaignId, optionId: optA.id } });
  check('非SVIP投票被拒(3001/3002)', voteNormal.code === 3001 || voteNormal.code === 3002, `code=${voteNormal.code}`);
  const vote1 = await raw('POST', '/votes', { token: users.svip.token, body: { campaignId, optionId: optA.id } });
  check('SVIP 投票成功', ok(vote1), `${vote1.code} ${vote1.message}`);
  const vote2 = await raw('POST', '/votes', { token: users.svip.token, body: { campaignId, optionId: optB.id } });
  check('SVIP 改票成功', ok(vote2) && vote2.data?.myOptionId === optB.id, `myOption=${vote2.data?.myOptionId}`);
  const result = await raw('GET', `/vote-campaigns/${campaignId}/result`, { token: users.svip.token });
  check('结果总票数=1(改票不新增)', ok(result) && result.data?.totalVotes === 1, `total=${result.data?.totalVotes}`);
  const live = await raw('GET', `/admin/vote-campaigns/${campaignId}/live`, { token: A });
  check('后台实时面板含投票人昵称', ok(live) && live.data?.voters?.[0]?.nickname === users.svip.nickname, JSON.stringify(live.data?.voters)?.slice(0, 120));
  await raw('POST', `/admin/vote-campaigns/${campaignId}/publish`, { token: A });
  const pubResult = await raw('GET', `/vote-campaigns/${campaignId}/result`, { token: users.svip.token });
  check('发布后结果仍可读', ok(pubResult) && pubResult.data?.totalVotes === 1);

  section('17. 主办方取消场次 → 全额退款');
  const balBeforeCancel = await raw('GET', '/balance', { token: users.vip.token });
  const cancelEventD = await raw('POST', `/admin/events/${eventDId}/cancel`, { token: A });
  check('主办方取消场次D', ok(cancelEventD), `${cancelEventD.code} ${cancelEventD.message}`);
  const vipDAfter = await raw('GET', `/registrations/${vipDReg.id}`, { token: users.vip.token });
  check('场次取消后报名 REFUNDED', vipDAfter.data?.status === 'REFUNDED', `actual=${vipDAfter.data?.status}`);
  const balAfterCancel = await raw('GET', '/balance', { token: users.vip.token });
  // D 重叠场 VIP 价 8000 全额回充：available 39000+8000=47000, frozen 16000-8000=8000
  check('取消回充后 available=47000', balAfterCancel.data?.account?.availableCent === 47000, `actual=${balAfterCancel.data?.account?.availableCent}`);
  check('取消回充后 frozen=8000', balAfterCancel.data?.account?.frozenCent === 8000, `actual=${balAfterCancel.data?.account?.frozenCent}`);

  section('18. 权限负例');
  const normalAdmin = await raw('GET', '/admin/events', { token: users.normal.token });
  expectCode('普通用户访问后台被拒 3001', normalAdmin, 3001);
  const vipRefunds = await raw('GET', '/admin/refunds', { token: users.vip.token });
  expectCode('VIP 访问退款后台被拒 3001', vipRefunds, 3001);
  const noAuth = await raw('GET', '/me');
  expectCode('无 token 访问 /me 被拒 2001', noAuth, 2001);
  // 越权读他人报名
  const ownCheck = await raw('GET', `/registrations/${vipReg1.id}`, { token: users.normal.token });
  expectCode('读他人报名被拒 3003', ownCheck, 3003);

  section('19. 账本对账（流水推导 == 物化余额）');
  for (const key of ['vip', 'svip']) {
    const u = users[key];
    const txns = await raw('GET', '/balance/transactions', { token: u.token, query: { pageSize: 100 } });
    const list = txns.data?.list ?? [];
    let avail = 0, frozen = 0;
    for (const t of list) {
      const amt = t.amountCent;
      if (t.direction === 'IN') avail += amt;
      else if (t.direction === 'UNFREEZE') { avail += amt; frozen -= amt; }
      else if (t.direction === 'FREEZE') { avail -= amt; frozen += amt; }
      else if (t.direction === 'OUT') { if (t.bizType === 'REGISTRATION') frozen -= amt; else avail -= amt; } // OUT+REGISTRATION=SETTLE(只扣冻结)；OUT+MANUAL_ADJUST=DEBIT(扣可用)
    }
    const bal = await raw('GET', '/balance', { token: u.token });
    check(`${key} 可用余额对账一致`, avail === bal.data?.account?.availableCent, `推导=${avail} 物化=${bal.data?.account?.availableCent}`);
    check(`${key} 冻结余额对账一致`, frozen === bal.data?.account?.frozenCent, `推导=${frozen} 物化=${bal.data?.account?.frozenCent}`);
  }

  section('20. 审计日志带昵称（近期改造验收）');
  const audits = await raw('GET', '/admin/audit-logs', { token: A, query: { pageSize: 20 } });
  check('审计日志返回', ok(audits) && Array.isArray(audits.data?.list));
  const withActorNick = audits.data?.list?.filter((l) => l.actorNickname);
  check('审计日志含操作人昵称', withActorNick?.length > 0, `count=${withActorNick?.length}`);
  const perms = await raw('GET', '/admin/permission-logs', { token: A, query: { pageSize: 20 } });
  check('权限日志含目标昵称字段', ok(perms) && perms.data?.list?.some((p) => 'targetNickname' in p));

  section('21. 改密 / refresh 轮换与重放 / 登出 / 注销');
  // 用一个全新throwaway用户做认证安全测试，避免污染主链路
  const throwaway = `e${run}t`;
  await raw('POST', '/auth/register', { body: { wechatId: throwaway, password: PW, nickname: '安全测试', inviteCode: codes[6], agreed: true } });
  let ts = await login(throwaway);
  // refresh 轮换
  const r1 = await raw('POST', '/auth/refresh', { body: { refreshToken: ts.refresh } });
  check('refresh 轮换成功', ok(r1), `${r1.code} ${r1.message}`);
  const newRefresh = refreshOf(r1);
  const newAccess = tokenOf(r1);
  check('refresh 下发新 token', !!newRefresh && !!newAccess);
  // 重放旧 refresh → TOKEN_REPLAYED 2003，整个 family 失效
  const replayRefresh = await raw('POST', '/auth/refresh', { body: { refreshToken: ts.refresh } });
  expectCode('重放旧 refresh 被拒 2003', replayRefresh, 2003);
  // 重放后新 access 也失效（sv+1）
  const afterReplay = await raw('GET', '/me', { token: newAccess });
  check('重放后新 access 失效', afterReplay.code === 2004 || afterReplay.code === 2001, `code=${afterReplay.code}`);
  // 重新登录 → 改密 → 旧 token 失效
  ts = await login(throwaway);
  const oldToken = ts.token;
  const chg = await raw('POST', '/me/password', { token: ts.token, body: { oldPassword: PW, newPassword: 'E2eNewPass456' } });
  check('改密成功', ok(chg), `${chg.code} ${chg.message}`);
  const oldAfterChg = await raw('GET', '/me', { token: oldToken });
  check('改密后旧 token 失效', oldAfterChg.code === 2004 || oldAfterChg.code === 2001, `code=${oldAfterChg.code}`);
  // 新密码登录
  const newLogin = await login(throwaway, 'E2eNewPass456');
  check('新密码可登录', !!newLogin.token);
  // 错密码
  const wrongPw = await raw('POST', '/auth/login', { body: { wechatId: throwaway, password: 'WrongPass999' } });
  expectCode('错密码被拒 2005', wrongPw, 2005);
  // 注销（无有效登记）
  const del = await raw('POST', '/me/delete', { token: newLogin.token, body: { password: 'E2eNewPass456' } });
  check('注销账号成功', ok(del), `${del.code} ${del.message}`);
  const loginAfterDel = await raw('POST', '/auth/login', { body: { wechatId: throwaway, password: 'E2eNewPass456' } });
  check('注销后无法登录', loginAfterDel.code !== 0, `code=${loginAfterDel.code}`);
  // 登出主测试用户之一
  const logout = await raw('POST', '/auth/logout', { token: users.full.token });
  check('登出成功', ok(logout), `${logout.code} ${logout.message}`);

  section('22. 后台报名列表筛选 + 昵称必显');
  const adminRegs = await raw('GET', '/admin/registrations', { token: A, query: { eventId: eventAId, pageSize: 50 } });
  check('后台报名列表返回', ok(adminRegs) && Array.isArray(adminRegs.data?.list));
  check('报名列表带用户昵称', adminRegs.data?.list?.every((r) => 'userNickname' in r));
  check('unpaidTotal 为全局聚合数', typeof adminRegs.data?.unpaidTotal === 'number');
  const kwSearch = await raw('GET', '/admin/registrations', { token: A, query: { keyword: users.vip.nickname } });
  check('按昵称搜索命中', ok(kwSearch) && kwSearch.data?.list?.some((r) => r.userId === users.vip.id), `total=${kwSearch.data?.total}`);

  // 汇总
  log(`\n${'='.repeat(50)}`);
  log(`全流程测试完成：${pass} 通过 / ${fail} 失败`);
  if (failures.length) { log('失败明细：'); failures.forEach((f) => log('  - ' + f)); }
  log('='.repeat(50));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('E2E 运行异常：', e); process.exit(2); });
