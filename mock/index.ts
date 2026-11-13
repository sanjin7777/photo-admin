/**
 * 本地 Mock API —— 通过 Vite 中间件接管 /api/v1，让前端在没有后端、没有数据库的
 * 情况下也能跑通全部页面与权限分支。
 *
 * 用法：npm run dev:mock（等价于 vite --mode mock，读取 .env.mock 的 VITE_USE_MOCK=true）
 *
 * 身份：登录后写一条 `pc_mock_uid` Cookie；后续请求按该 Cookie 还原账号，
 * 所以换个账号登录就能验证「管理员 / 运营 / 财务 / SVIP / VIP / 普通用户」的界面差异。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { capabilitiesFor } from '../packages/shared/src/capabilities';
import { BIZ_CODES } from '../packages/shared/src/errors';
import { couponDiscountOf } from '../packages/shared/src/schemas/coupon';
import { LEGAL_VERSION } from '../packages/shared/src/legal';
import {
  ACCOUNTS, ALL_EVENTS, AUDIT_LOGS, COUPONS, EVENT_DRAFT, EVENT_PUBLIC, EVENT_SVIP, IMPORT_PREVIEW_ROWS, MODELS,
  PERMISSION_LOGS, POSTER_SETTINGS, REFUNDS, REGISTRATIONS, SCENES, VOTE_DRAFT, VOTE_OPEN, VOTE_PUBLISHED, VOTE_VOTERS, mockUserOf,
  type MockAccount,
} from './data';

const MOCK_PASSWORD = 'mock123456';
/** 演示账号默认视为已同意当前协议，避免每次登录都弹窗；新版本发布时从这里移除即可复现拦截 */
const CONSENTED = new Set<string>(ACCOUNTS.map((a) => a.id));

/** 本地演示用邀请码（进程内可变，重启 dev server 会重置） */
interface MockInviteCode {
  id: string;
  code: string;
  status: 'UNUSED' | 'USED' | 'REVOKED';
  createdBy: string;
  usedByWechatId: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nowIso = (): string => new Date().toISOString();
function randomCode(): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}
/** 预置 3 个可直接用于本地注册联调的码（不含 0/1，符合邀请码格式规则） */
const INVITE_CODES: MockInviteCode[] = ['CATPAW26AB', 'CATPAW26CD', 'CATPAW26EF'].map((code, i) => ({
  id: String(i + 1),
  code,
  status: 'UNUSED',
  createdBy: 'mgr_catpaw',
  usedByWechatId: null,
  usedAt: null,
  expiresAt: null,
  note: '本地演示码',
  createdAt: nowIso(),
}));

/**
 * 投票演示数据按统一形状收拢，便于像真实后端一样在进程内被修改。
 * 票数从 VOTE_VOTERS 明细推导，保证列表、实时面板与投票人表格口径一致。
 */
interface MockVoteCampaign {
  id: string;
  title: string;
  openAt: string;
  closeAt: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'PUBLISHED';
  maxVotesPerUser: number;
  options: Array<{ id: string; campaignId: string; name: string; imageUrl: string | null; sort: number }>;
  updatedAt: string;
  [key: string]: unknown;
}
const ADMIN_VOTE_CAMPAIGNS = [VOTE_DRAFT, VOTE_OPEN, VOTE_PUBLISHED] as unknown as MockVoteCampaign[];

const votesOf = (campaignId: string) => VOTE_VOTERS[campaignId] ?? [];
function tallyOf(campaignId: string): Map<string, number> {
  const tally = new Map<string, number>();
  for (const v of votesOf(campaignId)) tally.set(v.optionId, (tally.get(v.optionId) ?? 0) + 1);
  return tally;
}
function lastVotedAtOf(campaignId: string): string | null {
  return votesOf(campaignId).reduce<string | null>((acc, v) => (!acc || v.votedAt > acc ? v.votedAt : acc), null);
}
/** 点C：投票直接关联模特；includeBody 控制身高/三围 gating（前台按会员，后台恒 true），与后端 campaignModelOf 一致 */
function voteModelOf(c: MockVoteCampaign, includeBody: boolean) {
  const mid = (c.modelId as string | null) ?? null;
  const m = mid ? MODELS.find((x) => x.id === mid) ?? null : null;
  if (!m) return null;
  return includeBody ? m : { ...m, heightCm: null, measurements: null };
}
const withVoteStats = (c: MockVoteCampaign) => ({
  ...c,
  model: voteModelOf(c, true),
  totalVotes: votesOf(c.id).length,
  lastVotedAt: lastVotedAtOf(c.id),
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify({ code: 0, message: 'ok', data, traceId: 'mock-trace' });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function fail(res: ServerResponse, code: number, message: string, status = 200, details?: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ code, message, data: null, details: details ?? null, traceId: 'mock-trace' }));
}

function currentAccount(req: IncomingMessage): MockAccount | null {
  const cookie = req.headers.cookie ?? '';
  const uid = /pc_mock_uid=([^;]+)/.exec(cookie)?.[1];
  if (!uid) return null;
  return ACCOUNTS.find((a) => a.id === uid) ?? null;
}

function capsOf(acc: MockAccount): string[] {
  return [...capabilitiesFor({ authenticated: true, level: acc.level, backendRoles: acc.roles })];
}

/** 可见场次：按等级过滤，与后端 satisfiesVisibility 同序；草稿由调用方另行排除 */
function visibleEvents(acc: MockAccount | null) {
  const rank = { NONE: 0, VIP: 1, SVIP: 2 } as const;
  const vis = { PUBLIC: 0, VIP: 1, SVIP: 2 } as const;
  const lv = acc?.level ?? 'NONE';
  return [EVENT_DRAFT, EVENT_PUBLIC, EVENT_SVIP].filter((e) => rank[lv] >= vis[e.visibility]);
}

const LEVEL_RANK = { NONE: 0, VIP: 1, SVIP: 2 } as const;
const isMemberAcc = (acc: MockAccount | null): boolean => !!acc && (acc.level === 'VIP' || acc.level === 'SVIP');

/**
 * 前台场次：克隆并把模特身高/三围 gating 给会员（点3），与后端 modelDtoOf(includeBody) 一致。
 * 不修改共享种子对象，避免后台列表（应见全量）被污染。
 */
function publicEventOf(ev: typeof EVENT_PUBLIC, acc: MockAccount | null): typeof EVENT_PUBLIC {
  const member = isMemberAcc(acc);
  const model = ev.model && !member ? { ...ev.model, heightCm: null, measurements: null } : ev.model;
  return { ...ev, model } as typeof EVENT_PUBLIC;
}

/** 报名门槛（点2）：可见性已在 visibleEvents 过滤，这里只判 registerMinLevel */
function registerGateReason(ev: typeof EVENT_PUBLIC, acc: MockAccount | null): number | null {
  const lv = acc?.level ?? 'NONE';
  const need = (ev.registerMinLevel ?? 'NONE') as keyof typeof LEVEL_RANK;
  return LEVEL_RANK[lv] >= LEVEL_RANK[need] ? null : BIZ_CODES.REGISTRATION_LEVEL_GATE;
}

const paginate = <T>(list: T[], total = list.length) => ({ list, total, page: 1, pageSize: list.length });

/**
 * 真分页切片：后端已把 page/pageSize 下推到 SQL，mock 若继续返回全量，
 * 翻页按钮就成了摆设（点下一页还是同一批数据）。
 * 没有传分页参数时按全量返回，保持对旧调用的兼容。
 */
function pageArgs<T>(url: URL, list: T[]): { list: T[]; total: number; page: number; pageSize: number } {
  const total = list.length;
  const rawPage = Number(url.searchParams.get('page'));
  const rawSize = Number(url.searchParams.get('pageSize'));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(100, Math.floor(rawSize)) : total || 20;
  return { list: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}

/**
 * 日期范围筛选（与后端 localDayRangeUtc 同语义）：按本地自然日含首含尾。
 * mock 里直接比较本地日期字符串，不绕 UTC，演示数据看着更直观。
 */
function inDayRange(iso: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** 场景库进程内可变数据（点4）；venue 为所属场地，一个场地多个场景 */
interface MockScene {
  id: string; venue: string; name: string; address: string | null; description: string | null;
  photoUrls: string[]; capacity: number | null; createdAt: string; updatedAt: string;
}
const MOCK_SCENES: MockScene[] = SCENES.map((s) => ({ ...s, photoUrls: [...s.photoUrls] }));

/** 优惠券进程内可变数据；EXPIRED 与后端一致，读时按 expiresAt 动态判定 */
type MockCouponStatus = 'UNUSED' | 'USED' | 'EXPIRED' | 'REVOKED';
interface MockCoupon {
  id: string; userId: string; title: string; type: 'DISCOUNT' | 'AMOUNT';
  discountBp: number | null; amountCent: number | null; minSpendCent: number; maxDiscountCent: number | null;
  expiresAt: string | null; status: 'UNUSED' | 'USED' | 'REVOKED';
  usedRegistrationId: string | null; usedAt: string | null;
  note: string | null; issuedBy: string | null; createdAt: string; updatedAt: string;
}
const MOCK_COUPONS: MockCoupon[] = COUPONS.map((c) => ({ ...c }));
const couponStatusOf = (c: MockCoupon): MockCouponStatus =>
  c.status === 'UNUSED' && c.expiresAt && Date.parse(c.expiresAt) <= Date.now() ? 'EXPIRED' : c.status;
const couponDtoOf = (c: MockCoupon) => ({ ...c, status: couponStatusOf(c) });

/** 按等级取价：与后端 pickPrice 同序（SVIP → VIP → PUBLIC） */
function priceOf(ev: typeof EVENT_PUBLIC, level: MockAccount['level']): number {
  const find = (lv: string) => ev.prices.find((p) => p.level === lv)?.priceCent;
  if (level === 'SVIP') return find('SVIP') ?? find('VIP') ?? find('PUBLIC') ?? 0;
  if (level === 'VIP') return find('VIP') ?? find('PUBLIC') ?? 0;
  return find('PUBLIC') ?? 0;
}

export async function mockHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (req.method ?? 'GET').toUpperCase();
  const acc = currentAccount(req);
  const caps = acc ? capsOf(acc) : [];

  const needAuth = (): boolean => {
    if (!acc) { fail(res, BIZ_CODES.UNAUTHORIZED, '请先登录', 401); return true; }
    return false;
  };
  const needCap = (cap: string): boolean => {
    if (!acc) { fail(res, BIZ_CODES.UNAUTHORIZED, '请先登录', 401); return true; }
    if (!caps.includes(cap)) { fail(res, BIZ_CODES.FORBIDDEN, '没有该操作的权限', 403); return true; }
    return false;
  };

  /* ---------------- 认证 ---------------- */
  if (path === '/auth/login' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { wechatId?: string; password?: string };
    const target = ACCOUNTS.find((a) => a.wechatId === body.wechatId);
    if (!target || (body.password ?? '') !== (target.password ?? MOCK_PASSWORD)) {
      fail(res, BIZ_CODES.INVALID_CREDENTIALS, '账号或密码错误');
      return;
    }
    res.setHeader('Set-Cookie', `pc_mock_uid=${target.id}; Path=/; SameSite=Lax`);
    json(res, { user: mockUserOf(target), expiresIn: 900 });
    return;
  }
  if (path === '/auth/register' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      wechatId?: string; nickname?: string; inviteCode?: string; agreed?: boolean;
    };
    if (body.agreed !== true) {
      fail(res, BIZ_CODES.INVALID_PARAM, '请阅读并同意用户协议与隐私政策');
      return;
    }
    const code = (body.inviteCode ?? '').trim().toUpperCase();
    const invite = INVITE_CODES.find((c) => c.code === code);
    if (!invite || invite.status === 'REVOKED') {
      fail(res, BIZ_CODES.INVITE_CODE_INVALID, '邀请码无效，请向管理员获取');
      return;
    }
    if (invite.status === 'USED') {
      fail(res, BIZ_CODES.INVITE_CODE_USED, '该邀请码已被使用');
      return;
    }
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
      fail(res, BIZ_CODES.INVITE_CODE_EXPIRED, '邀请码已过期，请向管理员重新获取');
      return;
    }
    if (ACCOUNTS.some((a) => a.wechatId === body.wechatId)) {
      fail(res, BIZ_CODES.INVALID_PARAM, '该微信号已被注册');
      return;
    }
    invite.status = 'USED';
    invite.usedByWechatId = body.wechatId ?? '';
    invite.usedAt = nowIso();
    json(res, {
      id: '99', wechatId: body.wechatId ?? '', nickname: body.nickname ?? '',
      level: 'NONE', roles: [], invitedByCode: code, createdAt: nowIso(), updatedAt: nowIso(),
    }, 201);
    return;
  }
  if (path === '/auth/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'pc_mock_uid=; Path=/; Max-Age=0');
    json(res, null);
    return;
  }
  if (path === '/auth/refresh' && method === 'POST') { json(res, { expiresIn: 900 }); return; }

  if (path === '/me') { if (needAuth()) return; json(res, mockUserOf(acc!)); return; }
  if (path === '/me/capabilities') {
    if (needAuth()) return;
    json(res, { capabilities: caps, backendRoles: acc!.roles, level: acc!.level });
    return;
  }
  if (path === '/me/password' && method === 'POST') {
    if (needAuth()) return;
    const body = JSON.parse((await readBody(req)) || '{}') as { oldPassword?: string; newPassword?: string };
    if ((body.oldPassword ?? '') !== (acc!.password ?? MOCK_PASSWORD)) {
      fail(res, BIZ_CODES.INVALID_CREDENTIALS, '当前密码不正确');
      return;
    }
    if ((body.newPassword ?? '') === body.oldPassword) {
      fail(res, BIZ_CODES.INVALID_PARAM, '新密码不能与当前密码相同');
      return;
    }
    acc!.password = body.newPassword;
    acc!.mustChangePassword = false;
    json(res, mockUserOf(acc!));
    return;
  }
  if (path === '/me/consents') {
    if (needAuth()) return;
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { agreed?: boolean };
      if (body.agreed !== true) {
        fail(res, BIZ_CODES.INVALID_PARAM, '请阅读并勾选同意');
        return;
      }
      CONSENTED.add(acc!.id);
    }
    const ok = CONSENTED.has(acc!.id);
    json(res, {
      termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION,
      agreedTerms: ok, agreedPrivacy: ok, needConsent: !ok,
    });
    return;
  }
  if (path === '/me/coupons' && method === 'GET') {    if (needAuth()) return;
    const order: Record<MockCouponStatus, number> = { UNUSED: 0, USED: 1, EXPIRED: 2, REVOKED: 3 };
    const rows = MOCK_COUPONS
      .filter((c) => c.userId === acc!.id)
      .map(couponDtoOf)
      .sort((a, b) => order[a.status] - order[b.status]
        || (Date.parse(a.expiresAt ?? '') || 0) - (Date.parse(b.expiresAt ?? '') || 0));
    json(res, rows);
    return;
  }

  /* ---------------- 场次 ---------------- */
  if (path === '/events') {
    // 草稿只有后台可见；模特身体数据按会员 gating（点3）
    json(res, paginate(visibleEvents(acc).filter((e) => e.status !== 'DRAFT').map((e) => publicEventOf(e as typeof EVENT_PUBLIC, acc))));
    return;
  }
  const eventDetail = /^\/events\/([^/]+)$/.exec(path);
  if (eventDetail) {
    const ev = visibleEvents(acc).find((e) => e.id === eventDetail[1] && e.status !== 'DRAFT');
    if (!ev) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '场次不存在或不可见'); return; }
    json(res, publicEventOf(ev as typeof EVENT_PUBLIC, acc));
    return;
  }
  const eventAvail = /^\/events\/([^/]+)\/availability$/.exec(path);
  if (eventAvail) {
    // 候补已下线：满员即不可报名；报名门槛（点2）按 registerMinLevel 判定
    const ev = visibleEvents(acc).find((e) => e.id === eventAvail[1] && e.status !== 'DRAFT');
    if (!ev) { json(res, { canRegister: false, reasonCode: BIZ_CODES.RESOURCE_NOT_FOUND }); return; }
    const reason = registerGateReason(ev as typeof EVENT_PUBLIC, acc);
    json(res, { canRegister: reason === null, reasonCode: reason });
    return;
  }

  /* ---------------- 报名 ---------------- */
  if (path === '/registrations/mine') {
    if (needAuth()) return;
    const rows = REGISTRATIONS.filter((r) => r.userId === acc!.id)
      .map((r) => ({ ...r, event: publicEventOf(r.event as typeof EVENT_PUBLIC, acc) }));
    json(res, paginate(rows));
    return;
  }
  if (path === '/registrations' && method === 'POST') {
    if (needAuth()) return;
    const body = JSON.parse((await readBody(req)) || '{}') as {
      sessionId?: string; ignoreConflict?: boolean; seats?: number; couponIds?: unknown;
    };
    const allSessions = [...EVENT_PUBLIC.sessions, ...EVENT_SVIP.sessions];
    const target = allSessions.find((s) => s.id === body.sessionId);
    const ev = EVENT_PUBLIC.sessions.some((s) => s.id === body.sessionId)
      ? EVENT_PUBLIC
      : EVENT_SVIP.sessions.some((s) => s.id === body.sessionId) ? EVENT_SVIP : EVENT_PUBLIC;
    const ignore = body.ignoreConflict === true;

    if (target && !ignore) {
      // 与已占用名额的报名（已确认/已签到，含历史候补）做时段重叠判断
      const conflicts = REGISTRATIONS
        .filter((r) => r.userId === acc!.id)
        .filter((r) => new Date(r.session.startAt) < new Date(target.endAt)
          && new Date(r.session.endAt) > new Date(target.startAt))
        .map((r) => ({
          registrationId: r.id,
          eventId: r.eventId,
          eventTitle: r.event.title,
          sessionLabel: r.session.label,
          startAt: r.session.startAt,
          endAt: r.session.endAt,
        }));
      if (conflicts.length) {
        fail(res, BIZ_CODES.SCHEDULE_CONFLICT, '该时段与你已报名的场次时间冲突', 409, { conflicts });
        return;
      }
    }
    // 点2：人工分批报名门槛，与后端 decideRegistration 同序（冲突判定之后）；看得到不代表此刻报得了
    const gateReason = registerGateReason(ev as typeof EVENT_PUBLIC, acc);
    if (gateReason !== null) {
      fail(res, gateReason, '当前报名尚未开放到你的会员等级', 409);
      return;
    }
    // 与后端一致：一次请求生成 seats 条独立报名记录
    const seats = Math.max(1, Math.min(10, Number(body.seats ?? 1) || 1));
    const priceCent = priceOf(ev, acc!.level);
    const rawIds = Array.isArray(body.couponIds)
      ? body.couponIds.filter((x): x is string => typeof x === 'string') : [];
    const couponIds = [...new Set(rawIds)].sort();
    if (couponIds.length > seats) {
      fail(res, BIZ_CODES.INVALID_PARAM, '优惠券数量不能超过报名名额数');
      return;
    }
    if (couponIds.length && ev.allowCoupon === false) {
      fail(res, BIZ_CODES.COUPON_NOT_ALLOWED, '该场次不可使用优惠券');
      return;
    }
    const picked: MockCoupon[] = [];
    for (const id of couponIds) {
      const c = MOCK_COUPONS.find((x) => x.id === id && x.userId === acc!.id);
      if (!c || c.status !== 'UNUSED'
        || (c.expiresAt && Date.parse(c.expiresAt) <= Date.now())
        || c.minSpendCent > priceCent) {
        fail(res, BIZ_CODES.COUPON_INVALID, '优惠券不可用，请重新选择');
        return;
      }
      picked.push(c);
    }
    const now = nowIso();
    const batch = `mock-r-${Date.now()}`;
    const base = REGISTRATIONS[0];
    const created = Array.from({ length: seats }, (_, i) => {
      const c = picked[i];
      const discount = c ? couponDiscountOf(c, priceCent) : 0;
      return {
        ...base, id: `${batch}-${i}`,
        source: 'ONLINE' as const,
        userId: acc!.id, userWechatId: acc!.wechatId,
        eventId: ev.id, event: ev, eventTitle: ev.title,
        sessionId: target?.id ?? base.sessionId,
        session: target ?? base.session,
        sessionLabel: target?.label ?? base.sessionLabel,
        sessionStartAt: target?.startAt ?? base.sessionStartAt,
        feeCent: Math.max(0, priceCent - discount),
        originalFeeCent: priceCent,
        discountCent: discount,
        couponId: c?.id ?? null,
        couponTitle: c?.title ?? null,
        createdAt: now, updatedAt: now,
      };
    });
    picked.forEach((c, i) => {
      c.status = 'USED';
      c.usedRegistrationId = created[i]?.id ?? null;
      c.usedAt = now;
      c.updatedAt = now;
    });
    json(res, { registrations: created, seats }, 201);
    return;
  }
  if (/^\/registrations\/[^/]+\/cancel$/.test(path)) { json(res, { id: 'r1', status: 'CANCELLED' }); return; }

  /* ---------------- 余额与会员 ---------------- */
  if (path === '/balance') {
    if (needAuth()) return;
    const cent = acc!.balanceCent;
    if (cent == null) { json(res, { applicable: false, account: null }); return; }
    json(res, { applicable: true, account: { userId: acc!.id, availableCent: cent, frozenCent: 0, bonusGrantedCent: acc!.bonusCent ?? 0, version: 1, updatedAt: new Date().toISOString() } });
    return;
  }
  if (path === '/balance/transactions') {
    if (needAuth()) return;
    if (acc!.balanceCent == null) { json(res, paginate([])); return; }
    const list = [
      { id: 't1', accountUserId: acc!.id, accountWechatId: acc!.wechatId, direction: 'IN', amountCent: acc!.balanceCent, balanceAfterCent: acc!.balanceCent, bizType: 'MANUAL_ADJUST', bizId: 'seed', originTxnId: null, idempotencyKey: 'mock-1', operatorId: '1', remark: '种子入账', createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
      { id: 't2', accountUserId: acc!.id, accountWechatId: acc!.wechatId, direction: 'FREEZE', amountCent: 18900, balanceAfterCent: acc!.balanceCent, bizType: 'FREEZE', bizId: 'r1', originTxnId: null, idempotencyKey: 'mock-2', operatorId: null, remark: '报名冻结', createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
    ];
    if ((acc!.bonusCent ?? 0) > 0) {
      list.push({ id: 't3', accountUserId: acc!.id, accountWechatId: acc!.wechatId, direction: 'IN', amountCent: acc!.bonusCent!, balanceAfterCent: acc!.balanceCent, bizType: 'BONUS', bizId: 'seed-bonus', originTxnId: null, idempotencyKey: 'mock-3', operatorId: '1', remark: '充值赠送', createdAt: new Date(Date.now() - 4 * 86400000).toISOString() });
    }
    json(res, paginate(list));
    return;
  }
  if (path === '/memberships/mine') {
    if (needAuth()) return;
    if (acc!.level === 'NONE') { json(res, []); return; }
    json(res, [{
      id: 'm1', userId: acc!.id, level: acc!.level, status: 'ACTIVE',
      startAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      expireAt: new Date(Date.now() + 300 * 86400000).toISOString(),
      source: 'GRANT', grantedBy: '1', grantReason: '演示数据', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]);
    return;
  }

  /* ---------------- 投票 ---------------- */
  if (path === '/vote-campaigns') {
    if (needCap('vote:cast')) return;
    json(res, [VOTE_OPEN, VOTE_PUBLISHED].map((c) => ({
      id: c.id, eventId: c.eventId,
      eventTitle: c.eventId == null ? null : c.eventId === '1' ? EVENT_PUBLIC.title : EVENT_SVIP.title,
      title: c.title, status: c.status, openAt: c.openAt, closeAt: c.closeAt,
      optionCount: c.options.length,
      coverImageUrl: c.options.find((o) => o.imageUrl)?.imageUrl ?? null,
      myVoted: Boolean(c.myOptionId),
    })));
    return;
  }
  const voteDetail = /^\/vote-campaigns\/([^/]+)$/.exec(path);
  if (voteDetail) {
    if (needCap('vote:cast')) return;
    const c = [VOTE_OPEN, VOTE_PUBLISHED].find((x) => x.id === voteDetail[1]);
    if (!c) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '活动不存在'); return; }
    json(res, { ...c, model: voteModelOf(c, isMemberAcc(acc)) });
    return;
  }
  if (/^\/vote-campaigns\/[^/]+\/result$/.test(path)) {
    if (needCap('vote:result:read')) return;
    const id = path.split('/')[2];
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === id);
    if (c && c.status === 'DRAFT') { fail(res, BIZ_CODES.VOTE_CLOSED, '投票尚未开放'); return; }
    const tally = tallyOf(id);
    const total = votesOf(id).length;
    json(res, {
      campaignId: id, totalVotes: total, suppressed: false,
      options: c
        ? c.options.map((o) => ({
          optionId: o.id, name: o.name, voteCount: tally.get(o.id) ?? 0,
          ratio: total ? Number(((tally.get(o.id) ?? 0) / total).toFixed(3)) : null,
        }))
        : [],
    });
    return;
  }
  if (path === '/votes' && method === 'POST') {
    if (needCap('vote:cast')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as { campaignId?: string; optionId?: string };
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === body.campaignId);
    if (!c) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '投票活动不存在'); return; }
    if (c.status !== 'OPEN') { fail(res, BIZ_CODES.VOTE_CLOSED, '投票未开放或已截止'); return; }
    const opt = c.options.find((o) => o.id === body.optionId);
    if (!opt) { fail(res, BIZ_CODES.INVALID_PARAM, '方案不存在'); return; }
    // 进程内记录投票：一人一票、改投覆盖旧票，与后端一致；票数由 tallyOf 实时聚合，客户端轮询可见
    const list = VOTE_VOTERS[c.id] ?? (VOTE_VOTERS[c.id] = []);
    const record = { userId: acc!.id, wechatId: acc!.wechatId, nickname: acc!.nickname, optionId: opt.id, votedAt: nowIso() };
    const mine = list.findIndex((v) => v.userId === acc!.id);
    if (mine >= 0) list[mine] = record; else list.push(record);
    c.myOptionId = opt.id;
    json(res, { ...c, model: voteModelOf(c, isMemberAcc(acc)) });
    return;
  }

  /* ---------------- 管理端 ---------------- */
  if (path === '/admin/events') {
    if (needCap('admin:event:write')) return;
    if (method === 'POST') {
      // 新建一律落草稿，与真实服务端一致
      await readBody(req);
      json(res, { ...EVENT_PUBLIC, id: '9', title: '新建场次（草稿）', status: 'DRAFT' }, 201);
      return;
    }
    // 与后端同口径：status / visibility / keyword 下推，再按 page/pageSize 切片
    const status = (url.searchParams.get('status') ?? '').trim();
    const visibility = (url.searchParams.get('visibility') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const rows = ALL_EVENTS
      .filter((e) => !status || e.status === status)
      .filter((e) => !visibility || e.visibility === visibility)
      .filter((e) => !kw || e.title.toLowerCase().includes(kw) || String(e.venue ?? '').toLowerCase().includes(kw));
    json(res, pageArgs(url, rows));
    return;
  }
  if (/^\/admin\/events\/[^/]+\/(cancel|restore|publish)$/.test(path)) {
    if (needCap('admin:event:write')) return;
    if (path.endsWith('/publish')) {
      const target = ALL_EVENTS.find((e) => e.id === path.split('/')[3]);
      if (target && target.status === 'DRAFT') (target as { status: string }).status = 'REGISTRATION_OPEN';
      json(res, target ?? { id: path.split('/')[3], status: 'REGISTRATION_OPEN' });
      return;
    }
    const isRestore = path.endsWith('/restore');
    json(res, { id: path.split('/')[3], status: isRestore ? 'REGISTRATION_OPEN' : 'CANCELLED' });
    return;
  }
  const adminEventPatch = /^\/admin\/events\/([^/]+)$/.exec(path);
  if (adminEventPatch && method === 'PATCH') {
    if (needCap('admin:event:write')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const base = ALL_EVENTS.find((e) => e.id === adminEventPatch[1]) ?? EVENT_PUBLIC;
    const sessions = Array.isArray(body.sessions)
      ? (body.sessions as Array<Record<string, unknown>>).map((s, i) => ({
          id: typeof s.id === 'string' ? s.id : `new-${i}`,
          eventId: base.id, label: String(s.label ?? `第${i + 1}场`),
          startAt: String(s.startAt ?? ''), endAt: String(s.endAt ?? ''),
          capacity: Number(s.capacity ?? 1), capacityUsed: 0, status: 'OPEN' as const,
        }))
      : base.sessions;
    // 进程内持久化标量字段（registerMinLevel / sceneId / visibility 等）+ 规范化时段，便于联调门槛与场景
    Object.assign(base, body, { sessions });
    json(res, base);
    return;
  }
  if (path === '/admin/registrations/lookup' && method === 'GET') {
    if (needCap('admin:registration:write')) return;
    const wechatId = (url.searchParams.get('wechatId') ?? '').trim();
    const target = ACCOUNTS.find((a) => a.wechatId === wechatId);
    if (!target) {
      fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${wechatId}」不存在`);
      return;
    }
    json(res, {
      id: target.id, wechatId: target.wechatId, nickname: target.nickname,
      level: target.level, status: target.frozen ? 'FROZEN' : 'ACTIVE',
    });
    return;
  }
  if (path === '/admin/registrations/users' && method === 'GET') {
    if (needCap('admin:registration:write')) return;
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
    const rows = ACCOUNTS
      .filter((a) => !a.roles.includes('SUPER_ADMIN'))
      .filter((a) => !kw || a.wechatId.toLowerCase().includes(kw) || a.nickname.toLowerCase().includes(kw))
      .slice(0, limit)
      .map((a) => ({
        id: a.id, wechatId: a.wechatId, nickname: a.nickname,
        level: a.level, status: a.frozen ? 'FROZEN' : 'ACTIVE',
      }));
    json(res, rows);
    return;
  }
  if (path === '/admin/registrations' && method === 'POST') {
    if (needCap('admin:registration:write')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as {
      wechatId?: string; eventId?: string; sessionId?: string;
      paymentStatus?: 'PAID' | 'UNPAID'; reason?: string;
    };
    const account = ACCOUNTS.find((a) => a.wechatId === (body.wechatId ?? '').trim());
    if (!account) {
      fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${body.wechatId ?? ''}」不存在`);
      return;
    }
    if (account.frozen) { fail(res, BIZ_CODES.INVALID_PARAM, '该账号已冻结，不能录入报名'); return; }
    const event = ALL_EVENTS.find((e) => e.id === body.eventId);
    if (!event) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '场次不存在'); return; }
    const eventStatus: string = event.status;
    const eventVisibility: string = event.visibility;
    if (eventStatus === 'DRAFT' || eventStatus === 'CANCELLED') {
      fail(res, BIZ_CODES.INVALID_PARAM, '草稿或已取消的场次不能录入报名');
      return;
    }
    if (eventVisibility === 'SVIP' && account.level !== 'SVIP') {
      fail(res, BIZ_CODES.LEVEL_INSUFFICIENT, '该账号等级不满足场次可见性');
      return;
    }
    if (eventVisibility === 'VIP' && account.level === 'NONE') {
      fail(res, BIZ_CODES.LEVEL_INSUFFICIENT, '该账号等级不满足场次可见性');
      return;
    }
    const session = event.sessions.find((s) => s.id === body.sessionId);
    if (!session) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '时段不存在'); return; }
    if (session.capacityUsed >= session.capacity) {
      fail(res, BIZ_CODES.EVENT_FULL, '该时段名额已满，无法补录');
      return;
    }
    const priceOf = (level: string) => {
      const find = (lv: string) => event.prices.find((p) => p.level === lv)?.priceCent;
      if (level === 'SVIP') return find('SVIP') ?? find('VIP') ?? find('PUBLIC') ?? 0;
      if (level === 'VIP') return find('VIP') ?? find('PUBLIC') ?? 0;
      return find('PUBLIC') ?? 0;
    };
    const feeCent = priceOf(account.level);
    const stamp = new Date().toISOString();
    const row = {
      id: `r${Date.now()}`, eventId: event.id, userId: account.id, sessionId: session.id,
      status: 'CONFIRMED' as const, paymentStatus: body.paymentStatus === 'PAID' ? 'PAID' as const : 'UNPAID' as const,
      source: 'MANUAL' as const,
      
      feeCent, originalFeeCent: feeCent, discountCent: 0, couponId: null, couponTitle: null,
      refundPolicySnapshot: event.refundPolicy, balanceTxnId: null, cancelReason: null,
      userWechatId: account.wechatId,
      eventTitle: event.title, sessionLabel: session.label, sessionStartAt: session.startAt,
      event, session, createdAt: stamp, updatedAt: stamp,
    };
    session.capacityUsed += 1;
    (REGISTRATIONS as unknown as Array<Record<string, unknown>>).unshift(row);
    json(res, row, 201);
    return;
  }
  if (path === '/admin/registrations/batch' && method === 'POST') {
    if (needCap('admin:registration:write')) return;
    // 与后端同语义：逐条校验、部分成功。mock 里同样不能整批失败，
    // 否则本地演示时看不到「成功 N 条 / 跳过 M 条」这条提示。
    const body = JSON.parse((await readBody(req)) || '{}') as { action?: string; ids?: string[] };
    const action = body.action ?? '';
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const succeeded: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const r = REGISTRATIONS.find((x) => x.id === id);
      if (!r) { skipped.push({ id, reason: '报名不存在' }); continue; }
      if (action === 'CHECK_IN') {
        if (r.status !== 'CONFIRMED') { skipped.push({ id, reason: '当前状态不能签到' }); continue; }
        r.status = 'CHECKED_IN';
      } else if (action === 'CONFIRM_PAYMENT') {
        if (r.paymentStatus !== 'UNPAID') { skipped.push({ id, reason: '该报名当前无需确认收款' }); continue; }
        r.paymentStatus = 'PAID';
      } else {
        skipped.push({ id, reason: '不支持的操作' }); continue;
      }
      succeeded.push(id);
    }
    json(res, { action, succeeded, skipped });
    return;
  }
  if (path === '/admin/registrations') {
    if (needCap('admin:registration:write')) return;
    // 与后端同口径：eventId / sessionId / status / paymentStatus / keyword 全部下推，再按 page/pageSize 切片。
    // 后端已改真分页，mock 若继续返回全量，翻页按钮会形同虚设。
    const eventId = (url.searchParams.get('eventId') ?? '').trim();
    const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
    const status = (url.searchParams.get('status') ?? '').trim();
    const paymentStatus = (url.searchParams.get('paymentStatus') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const regFrom = (url.searchParams.get('dateFrom') ?? '').trim();
    const regTo = (url.searchParams.get('dateTo') ?? '').trim();
    const rows = REGISTRATIONS
      .filter((r) => !eventId || String(r.eventId) === eventId)
      .filter((r) => !sessionId || String(r.sessionId) === sessionId)
      .filter((r) => !status || r.status === status)
      .filter((r) => !paymentStatus || r.paymentStatus === paymentStatus)
      .filter((r) => inDayRange(r.createdAt, regFrom, regTo))
      .filter((r) => {
        if (!kw) return true;
        const title = String((r as unknown as Record<string, unknown>).eventTitle ?? '').toLowerCase();
        return String(r.userWechatId ?? '').toLowerCase().includes(kw) || title.includes(kw);
      });
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20) || 20));
    const start = (page - 1) * pageSize;
    json(res, {
      list: rows.slice(start, start + pageSize),
      total: rows.length,
      page,
      pageSize,
      // 全局待收款角标，不受当前页与筛选影响
      unpaidTotal: REGISTRATIONS.filter((r) => r.paymentStatus === 'UNPAID' && r.status === 'CONFIRMED').length,
    });
    return;
  }
  if (path === '/admin/refunds' && method === 'GET') {
    if (needCap('admin:refund:review')) return;
    const status = (url.searchParams.get('status') ?? '').trim();
    const settle = (url.searchParams.get('settle') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const dateFrom = (url.searchParams.get('dateFrom') ?? '').trim();
    const dateTo = (url.searchParams.get('dateTo') ?? '').trim();
    const rows = REFUNDS.filter((r) => {
      // 与后端一致：settle 是独立维度（是否已线下退款），不是 status 的取值
      if (settle === 'UNSETTLED' && !(r.status === 'REFUNDED' && !r.settledAt)) return false;
      if (settle === 'SETTLED' && !r.settledAt) return false;
      if (status === 'UNSETTLED') {
        if (!(r.status === 'REFUNDED' && !r.settledAt)) return false;
      } else if (status && r.status !== status) return false;
      if (!inDayRange(r.createdAt, dateFrom, dateTo)) return false;
      if (!kw) return true;
      const acc = ACCOUNTS.find((a) => a.id === r.requestedBy);
      const reg = REGISTRATIONS.find((x) => x.id === r.registrationId);
      const ev = reg ? ALL_EVENTS.find((e) => e.id === reg.eventId) : null;
      return [acc?.wechatId, acc?.nickname, ev?.title, String(r.registrationId)]
        .some((v) => String(v ?? '').toLowerCase().includes(kw));
    });
    json(res, {
      ...pageArgs(url, rows),
      pendingTotal: REFUNDS.filter((r) => r.status === 'REQUESTED').length,
      // 已批准但线下还没退钱的挂账数（对账口径）
      unsettledTotal: REFUNDS.filter((r) => r.status === 'REFUNDED' && !r.settledAt).length,
    });
    return;
  }
  // 退款审核 / 线下退款落定：Mock 里直接改内存行，便于验证「积分回充 vs 线下退款」两条分支
  const refundAct = /^\/admin\/refunds\/([^/]+)\/(review|settle)$/.exec(path);
  if (refundAct) {
    if (needCap('admin:refund:review')) return;
    const [, refundId, action] = refundAct;
    const target = REFUNDS.find((r) => r.id === refundId) as unknown as Record<string, unknown> | undefined;
    if (!target) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '退款单不存在'); return; }
    const body = JSON.parse((await readBody(req)) || '{}') as { approve?: boolean; remark?: string };
    const now = new Date().toISOString();
    if (action === 'review') {
      if (target.status !== 'REQUESTED') { fail(res, BIZ_CODES.ILLEGAL_TRANSITION, '该退款单已处理'); return; }
      const approve = Boolean(body.approve);
      target.status = approve ? 'REFUNDED' : 'REJECTED';
      target.reviewedBy = '1';
      target.reviewedAt = now;
      target.reviewRemark = body.remark ?? null;
      // 会员（积分支付）审核通过即资金落定；非会员留空，等线下退款后补记
      if (approve && target.paymentStatus === 'NOT_REQUIRED') {
        target.settledBy = '1';
        target.settledAt = now;
      }
      json(res, { id: refundId });
      return;
    }
    if (target.status !== 'REFUNDED') { fail(res, BIZ_CODES.ILLEGAL_TRANSITION, '只有已通过的退款单才能登记线下退款完成'); return; }
    if (target.settledAt) { json(res, target); return; }
    target.settledBy = '1';
    target.settledAt = now;
    target.settleRemark = body.remark ?? null;
    json(res, target);
    return;
  }
  if (path === '/admin/coupons' && method === 'GET') {
    if (needCap('admin:membership:grant')) return;
    const status = (url.searchParams.get('status') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const rows = MOCK_COUPONS.map((c) => {
      const a = ACCOUNTS.find((x) => x.id === c.userId);
      return {
        ...couponDtoOf(c),
        userId: c.userId,
        userWechatId: a?.wechatId ?? null,
        userNickname: a?.nickname ?? null,
      };
    })
      .filter((r) => !status || r.status === status)
      .filter((r) => !kw || r.title.toLowerCase().includes(kw)
        || (r.userWechatId ?? '').toLowerCase().includes(kw)
        || (r.userNickname ?? '').toLowerCase().includes(kw));
    json(res, paginate(rows));
    return;
  }
  if (path === '/admin/coupons' && method === 'POST') {
    if (needCap('admin:membership:grant')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as {
      wechatIds?: unknown; title?: string; type?: 'DISCOUNT' | 'AMOUNT';
      discountBp?: number; amountCent?: number; minSpendCent?: number;
      maxDiscountCent?: number | null; expiresAt?: string | null; note?: string | null;
    };
    const wechatIds = [...new Set(Array.isArray(body.wechatIds)
      ? body.wechatIds.filter((x): x is string => typeof x === 'string') : [])];
    if (!wechatIds.length || wechatIds.length > 50) {
      fail(res, BIZ_CODES.INVALID_PARAM, '请输入 1–50 个微信号');
      return;
    }
    const targets = wechatIds.map((w) => ACCOUNTS.find((a) => a.wechatId === w));
    const missing = wechatIds.filter((_, i) => !targets[i]);
    if (missing.length) {
      fail(res, BIZ_CODES.INVALID_PARAM, `微信号不存在：${missing.join('、')}`);
      return;
    }
    const now = nowIso();
    const stamp = Date.now();
    const created: string[] = [];
    targets.forEach((a, i) => {
      const id = `mc-${stamp}-${i}`;
      MOCK_COUPONS.unshift({
        id, userId: a!.id, title: String(body.title ?? '优惠券'),
        type: body.type === 'AMOUNT' ? 'AMOUNT' : 'DISCOUNT',
        discountBp: body.type === 'AMOUNT' ? null : Number(body.discountBp ?? 10000),
        amountCent: body.type === 'AMOUNT' ? Number(body.amountCent ?? 0) : null,
        minSpendCent: Number(body.minSpendCent ?? 0),
        maxDiscountCent: body.type === 'AMOUNT' || body.maxDiscountCent == null
          ? null : Number(body.maxDiscountCent),
        expiresAt: body.expiresAt ?? null, status: 'UNUSED',
        usedRegistrationId: null, usedAt: null,
        note: body.note ?? null, issuedBy: acc!.id,
        createdAt: now, updatedAt: now,
      });
      created.push(id);
    });
    json(res, { created: created.length, couponIds: created }, 201);
    return;
  }
  const adminCouponRevoke = /^\/admin\/coupons\/([^/]+)\/revoke$/.exec(path);
  if (adminCouponRevoke && method === 'POST') {
    if (needCap('admin:membership:grant')) return;
    const c = MOCK_COUPONS.find((x) => x.id === adminCouponRevoke[1]);
    if (!c) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '优惠券不存在'); return; }
    if (c.status !== 'UNUSED') { fail(res, BIZ_CODES.INVALID_PARAM, '仅未使用的优惠券可以作废'); return; }
    c.status = 'REVOKED';
    c.updatedAt = nowIso();
    json(res, { id: c.id });
    return;
  }

  /* ---------------- 模特管理 ---------------- */
  if (path === '/admin/models') {
    if (needCap('admin:model:write')) return;
    if (method === 'POST') {
      await readBody(req);
      json(res, { userId: '99' }, 201);
      return;
    }
    json(res, paginate(MODELS));
    return;
  }
  if (/^\/admin\/models\/[^/]+$/.test(path) && method === 'PATCH') {
    if (needCap('admin:model:write')) return;
    await readBody(req);
    json(res, { userId: path.split('/')[3] });
    return;
  }

  /* ---------------- 场景库（点4） ---------------- */
  if (path === '/admin/scenes/options') {
    if (needCap('admin:scene:write')) return;
    json(res, MOCK_SCENES);
    return;
  }
  if (path === '/admin/scenes' && method === 'POST') {
    if (needCap('admin:scene:write')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const id = String(Date.now());
    const stamp = nowIso();
    MOCK_SCENES.unshift({
      id, venue: String(body.venue ?? '默认场地'), name: String(body.name ?? '未命名场景'),
      address: (body.address as string | null) ?? null,
      description: (body.description as string | null) ?? null,
      photoUrls: Array.isArray(body.photoUrls) ? (body.photoUrls as string[]) : [],
      capacity: body.capacity == null ? null : Number(body.capacity),
      createdAt: stamp, updatedAt: stamp,
    });
    json(res, { id }, 201);
    return;
  }
  if (path === '/admin/scenes') {
    if (needCap('admin:scene:write')) return;
    json(res, paginate(MOCK_SCENES));
    return;
  }
  const sceneItem = /^\/admin\/scenes\/([^/]+)$/.exec(path);
  if (sceneItem) {
    if (needCap('admin:scene:write')) return;
    const idx = MOCK_SCENES.findIndex((s) => s.id === sceneItem[1]);
    if (idx < 0) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '场景不存在'); return; }
    if (method === 'PATCH') {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      Object.assign(MOCK_SCENES[idx], body, { updatedAt: nowIso() });
      json(res, { id: MOCK_SCENES[idx].id });
      return;
    }
    if (method === 'DELETE') {
      MOCK_SCENES.splice(idx, 1);
      json(res, { id: sceneItem[1] });
      return;
    }
    json(res, MOCK_SCENES[idx]);
    return;
  }

  if (path === '/admin/balance/transactions') {
    if (needCap('admin:refund:review')) return;
    // 给财务页一组演示流水，验证「微信号 + 方向语义 + 赠送积分」展示
    const demo = ACCOUNTS.filter((a) => a.balanceCent != null).slice(0, 2);
    const rows = demo.map((a, i) => ({
      id: `at${i + 1}`, accountUserId: a.id, accountWechatId: a.wechatId,
      direction: i === 0 ? 'FREEZE' : 'IN', amountCent: i === 0 ? 28900 : 50000,
      balanceAfterCent: a.balanceCent, bizType: i === 0 ? 'FREEZE' : 'MANUAL_ADJUST',
      bizId: i === 0 ? 'r1' : 'seed', originTxnId: null, operatorId: i === 0 ? null : '1',
      remark: i === 0 ? '报名冻结' : '种子入账',
      createdAt: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    }));
    const bonusAcc = ACCOUNTS.find((a) => (a.bonusCent ?? 0) > 0);
    if (bonusAcc) {
      rows.push({
        id: 'at-bonus', accountUserId: bonusAcc.id, accountWechatId: bonusAcc.wechatId,
        direction: 'IN', amountCent: bonusAcc.bonusCent!, balanceAfterCent: bonusAcc.balanceCent,
        bizType: 'BONUS', bizId: 'seed-bonus', originTxnId: null, operatorId: '1',
        remark: '充值赠送', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      });
    }
    const bizType = (url.searchParams.get('bizType') ?? '').trim();
    const txnKw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const txnFrom = (url.searchParams.get('dateFrom') ?? '').trim();
    const txnTo = (url.searchParams.get('dateTo') ?? '').trim();
    const filtered = rows.filter((t) => (!bizType || t.bizType === bizType)
      && inDayRange(t.createdAt, txnFrom, txnTo)
      && (!txnKw || [t.accountWechatId, t.remark, t.bizType].some((v) => String(v ?? '').toLowerCase().includes(txnKw))));
    json(res, pageArgs(url, filtered));
    return;
  }
  if (path === '/admin/balance/adjustments' && method === 'POST') { if (needCap('admin:balance:adjust:request')) return; json(res, { id: 'adj1', status: 'APPLIED', availableCent: 0 }, 201); return; }
  if (path === '/admin/vote-campaigns') {
    if (method === 'POST') {
      if (needCap('admin:vote:write')) return;
      const body = JSON.parse((await readBody(req)) || '{}') as {
        title?: string; modelId?: string | null; openAt?: string; closeAt?: string; maxVotesPerUser?: number;
        options?: Array<{ name: string; imageUrl?: string | null; sort?: number }>;
      };
      const id = String(ADMIN_VOTE_CAMPAIGNS.length + 1);
      const created: MockVoteCampaign = {
        id,
        modelId: body.modelId ?? null,
        title: body.title ?? '新建投票（草稿）',
        openAt: body.openAt ?? new Date().toISOString(),
        closeAt: body.closeAt ?? new Date().toISOString(),
        status: 'DRAFT',
        maxVotesPerUser: body.maxVotesPerUser ?? 1,
        options: (body.options ?? []).map((o, i) => ({
          id: `n${id}_${i + 1}`,
          campaignId: id,
          name: o.name,
          imageUrl: o.imageUrl ?? null,
          sort: o.sort ?? i,
        })),
        updatedAt: new Date().toISOString(),
      };
      ADMIN_VOTE_CAMPAIGNS.push(created);
      json(res, { id }, 201);
      return;
    }
    if (needCap('admin:vote:write')) return;
    json(res, paginate(ADMIN_VOTE_CAMPAIGNS.map(withVoteStats)));
    return;
  }

  const voteLiveMatch = /^\/admin\/vote-campaigns\/([^/]+)\/live$/.exec(path);
  if (voteLiveMatch) {
    if (needCap('admin:vote:write')) return;
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === voteLiveMatch[1]);
    if (!c) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '投票活动不存在'); return; }
    const tally = tallyOf(c.id);
    const total = votesOf(c.id).length;
    json(res, {
      campaign: { ...c, model: voteModelOf(c, true) },
      totalVotes: total,
      lastVotedAt: lastVotedAtOf(c.id),
      options: c.options.map((o) => ({
        optionId: o.id,
        name: o.name,
        imageUrl: o.imageUrl,
        voteCount: tally.get(o.id) ?? 0,
        ratio: total ? Number(((tally.get(o.id) ?? 0) / total).toFixed(4)) : null,
      })),
      voters: votesOf(c.id).map((v) => ({
        userId: v.userId,
        wechatId: v.wechatId,
        nickname: v.nickname,
        optionId: v.optionId,
        optionName: c.options.find((o) => o.id === v.optionId)?.name ?? '已删除方案',
        votedAt: v.votedAt,
      })),
    });
    return;
  }

  const votePatchMatch = /^\/admin\/vote-campaigns\/([^/]+)$/.exec(path);
  if (votePatchMatch && method === 'PATCH') {
    if (needCap('admin:vote:write')) return;
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === votePatchMatch[1]);
    if (!c) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, '投票活动不存在'); return; }
    if (c.status === 'PUBLISHED') { fail(res, BIZ_CODES.ILLEGAL_TRANSITION, '已发布的投票不能再修改'); return; }
    const body = JSON.parse((await readBody(req)) || '{}') as {
      title?: string; modelId?: string | null; openAt?: string; closeAt?: string; maxVotesPerUser?: number;
      options?: Array<{ id?: string; name: string; imageUrl?: string | null; sort?: number }>;
    };
    const tally = tallyOf(c.id);
    if (body.options) {
      const keep = new Set(body.options.map((o) => o.id).filter(Boolean));
      const blocked = c.options.find((o) => !keep.has(o.id) && (tally.get(o.id) ?? 0) > 0);
      if (blocked) {
        fail(res, BIZ_CODES.ILLEGAL_TRANSITION, `方案「${blocked.name}」已有 ${tally.get(blocked.id) ?? 0} 票，不能删除`);
        return;
      }
      let seq = c.options.length + 1;
      c.options = body.options.map((o, i) => {
        const existing = c.options.find((x) => x.id === o.id);
        return {
          id: existing?.id ?? `n${c.id}_${seq++}`,
          campaignId: c.id,
          name: o.name,
          imageUrl: o.imageUrl ?? null,
          sort: o.sort ?? i,
        };
      });
    }
    if (typeof body.title === 'string') c.title = body.title;
    if (body.modelId !== undefined) c.modelId = body.modelId;
    if (body.openAt) c.openAt = body.openAt;
    if (body.closeAt) c.closeAt = body.closeAt;
    if (typeof body.maxVotesPerUser === 'number') c.maxVotesPerUser = body.maxVotesPerUser;
    c.updatedAt = new Date().toISOString();
    json(res, withVoteStats(c));
    return;
  }

  if (/^\/admin\/vote-campaigns\/[^/]+\/publish$/.test(path)) {
    if (needCap('admin:vote:publish')) return;
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === path.split('/')[3]);
    if (c) c.status = 'PUBLISHED';
    json(res, { id: c?.id ?? path.split('/')[3], status: 'PUBLISHED' });
    return;
  }
  if (/^\/admin\/vote-campaigns\/[^/]+\/open$/.test(path)) {
    if (needCap('admin:vote:write')) return;
    const c = ADMIN_VOTE_CAMPAIGNS.find((x) => x.id === path.split('/')[3]);
    if (c && c.status === 'DRAFT') c.status = 'OPEN';
    json(res, { id: c?.id ?? path.split('/')[3], status: c?.status ?? 'OPEN' });
    return;
  }
  if (path === '/admin/memberships' && method === 'POST') { if (needCap('admin:membership:grant')) return; json(res, { id: 'm9' }, 201); return; }
  if (path === '/admin/audit-logs') {
    if (needCap('admin:audit:read')) return;
    const action = (url.searchParams.get('action') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const rows = AUDIT_LOGS.map((l) => ({
      ...l,
      actorWechatId: ACCOUNTS.find((a) => a.id === l.actorId)?.wechatId ?? null,
    })).filter((l) => (!action || l.action === action)
      && (!kw || [l.actorWechatId, l.action, l.targetType, l.targetId].some((v) => String(v ?? '').toLowerCase().includes(kw))));
    json(res, paginate(rows));
    return;
  }
  if (path === '/admin/permission-logs') {
    if (needCap('admin:permission:log:read')) return;
    const action = (url.searchParams.get('action') ?? '').trim();
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const rows = PERMISSION_LOGS.map((l) => ({
      ...l,
      actorWechatId: ACCOUNTS.find((a) => a.id === l.actorId)?.wechatId ?? null,
      targetWechatId: ACCOUNTS.find((a) => a.id === l.targetId)?.wechatId ?? null,
    })).filter((l) => (!action || l.action === action)
      && (!kw || [l.actorWechatId, l.targetWechatId, l.action, l.targetId].some((v) => String(v ?? '').toLowerCase().includes(kw))));
    json(res, paginate(rows));
    return;
  }

  /* ---------------- 邀请码（后台） ---------------- */
  if (path === '/admin/invite-codes' && method === 'POST') {
    if (needCap('admin:invite:write')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as {
      count?: number; expiresAt?: string | null; note?: string | null;
    };
    const count = Math.max(1, Math.min(50, Number(body.count ?? 1) || 1));
    const codes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const code = randomCode();
      INVITE_CODES.unshift({
        id: String(Date.now() + i), code, status: 'UNUSED', createdBy: acc!.wechatId,
        usedByWechatId: null, usedAt: null,
        expiresAt: body.expiresAt ?? null, note: body.note ?? null, createdAt: nowIso(),
      });
      codes.push(code);
    }
    json(res, { codes, count: codes.length, expiresAt: body.expiresAt ?? null }, 201);
    return;
  }
  const revokeMatch = /^\/admin\/invite-codes\/([^/]+)\/revoke$/.exec(path);
  if (revokeMatch && method === 'POST') {
    if (needCap('admin:invite:write')) return;
    const item = INVITE_CODES.find((c) => c.id === revokeMatch[1]);
    if (!item || item.status !== 'UNUSED') {
      fail(res, BIZ_CODES.INVALID_PARAM, '仅未使用的邀请码可以作废');
      return;
    }
    item.status = 'REVOKED';
    json(res, { id: item.id });
    return;
  }
  if (path === '/admin/invite-codes') {
    if (needCap('admin:invite:read')) return;
    const status = url.searchParams.get('status') ?? '';
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const rows = INVITE_CODES
      .filter((c) => !status || c.status === status)
      .filter((c) => !kw || c.code.toLowerCase().includes(kw)
        || c.createdBy.toLowerCase().includes(kw)
        || (c.usedByWechatId ?? '').toLowerCase().includes(kw))
      .map((c) => ({
        id: c.id, code: c.code, status: c.status,
        createdByWechatId: c.createdBy, usedByWechatId: c.usedByWechatId,
        usedAt: c.usedAt, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt,
      }));
    json(res, paginate(rows));
    return;
  }

  /* ---------------- 用户列表（用户管理页） ---------------- */
  if (/^\/admin\/users\/[^/]+$/.test(path) && method === 'PATCH') {
    if (needCap('admin:membership:grant')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    if (body.roles && (body.roles as string[]).includes('SUPER_ADMIN')) {
      fail(res, BIZ_CODES.FORBIDDEN, '不可授予系统维护角色');
      return;
    }
    json(res, { id: path.split('/')[3] });
    return;
  }

  if (path === '/admin/users/reset-password' && method === 'POST') {
    if (needCap('admin:user:reset-password')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as { wechatId?: string };
    const target = ACCOUNTS.find((a) => a.wechatId === body.wechatId);
    if (!target) { fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, `微信号「${body.wechatId ?? ''}」不存在`); return; }
    if (target.roles.includes('SUPER_ADMIN')) { fail(res, BIZ_CODES.FORBIDDEN, '系统账号不可在后台重置密码'); return; }
    json(res, { wechatId: target.wechatId, temporaryPassword: 'Aw1MockReset2026' });
    return;
  }

  if (path === '/admin/users' && method === 'POST') {
    if (needCap('admin:membership:grant')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as {
      wechatId?: string; nickname?: string; level?: string; roles?: string[]; balanceYuan?: number; bonusYuan?: number;
    };
    if (ACCOUNTS.some((a) => a.wechatId === body.wechatId)) {
      fail(res, BIZ_CODES.INVALID_PARAM, `微信号「${body.wechatId}」已被注册`);
      return;
    }
    const balanceCent = body.balanceYuan ? Math.round(body.balanceYuan * 100) : 0;
    const bonusCent = body.bonusYuan ? Math.round(body.bonusYuan * 100) : 0;
    const created = {
      id: String(Date.now()),
      wechatId: body.wechatId ?? '',
      nickname: body.nickname ?? '',
      level: (body.level ?? 'NONE') as 'NONE' | 'VIP' | 'SVIP',
      levelExpireAt: (body.level ?? 'NONE') === 'NONE' ? null : new Date(Date.now() + 365 * 86400000).toISOString(),
      roles: body.roles ?? [],
      balanceCent: balanceCent + bonusCent > 0 ? balanceCent + bonusCent : null,
      bonusGrantedCent: bonusCent,
      invitedByCode: null,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };
    json(res, created, 201);
    return;
  }

  if (path === '/admin/users') {
    if (needCap('admin:membership:grant')) return;
    const kw = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const lv = (url.searchParams.get('level') ?? '').trim();
    const rows = ACCOUNTS
      // 运维账号不出现在用户列表里，与后端一致
      .filter((a) => !a.roles.includes('SUPER_ADMIN'))
      .filter((a) => (!kw || a.wechatId.toLowerCase().includes(kw) || a.nickname.toLowerCase().includes(kw)))
      .filter((a) => (!lv || a.level === lv))
      .map((a) => ({
        id: a.id,
        wechatId: a.wechatId,
        nickname: a.nickname,
        level: a.level,
        levelExpireAt: a.level === 'NONE' ? null : new Date(Date.now() + 300 * 86400000).toISOString(),
        roles: a.roles,
        balanceCent: a.balanceCent,
        bonusGrantedCent: a.bonusCent ?? 0,
        invitedByCode: INVITE_CODES.find((c) => c.usedByWechatId === a.wechatId)?.code ?? null,
        status: a.frozen ? 'FROZEN' : 'ACTIVE',
        createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
      }));
    json(res, pageArgs(url, rows));
    return;
  }

  /* ---------------- 前台公开设置：报名页客服二维码（无需登录） ---------------- */
  if (path === '/settings/public' && method === 'GET') {
    json(res, { serviceQrUrl: POSTER_SETTINGS.qrUrl });
    return;
  }

  /* ---------------- 海报配置（二维码 + 左上角标题） ---------------- */
  if (path === '/admin/settings/poster') {
    if (needCap('admin:event:write')) return;
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        qrUrl?: string | null; siteQrUrl?: string | null; brandTitle?: string | null;
      };
      POSTER_SETTINGS.qrUrl = body.qrUrl ?? null;
      POSTER_SETTINGS.siteQrUrl = body.siteQrUrl ?? null;
      POSTER_SETTINGS.brandTitle = (body.brandTitle ?? '').trim() || null;
    }
    json(res, {
      qrUrl: POSTER_SETTINGS.qrUrl,
      siteQrUrl: POSTER_SETTINGS.siteQrUrl,
      brandTitle: POSTER_SETTINGS.brandTitle,
    });
    return;
  }

  /* ---------------- 图片上传（Mock 不解析文件，返回同尺寸占位图） ---------------- */
  if (path === '/admin/uploads' && method === 'POST') {
    if (needCap('admin:media:upload')) return;
    await readBody(req);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600"><rect width="100%" height="100%" fill="#FADCD1"/><g fill="#78B3AB"><ellipse cx="240" cy="330" rx="95" ry="70"/><ellipse cx="150" cy="220" rx="34" ry="46"/><ellipse cx="226" cy="170" rx="34" ry="46"/><ellipse cx="300" cy="180" rx="32" ry="44"/><ellipse cx="356" cy="240" rx="30" ry="42"/></g><text x="240" y="470" font-size="22" fill="#5F7F7A" text-anchor="middle" font-family="sans-serif">Mock 已上传</text></svg>`;
    json(res, {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      name: 'mock-upload.png',
      size: 1024,
      mimeType: 'image/png',
    }, 201);
    return;
  }

  if (path === '/admin/exports') {
    if (needCap('admin:export')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as { target?: string };
    const csv = 'id,created_at\n1,2026-11-09\n2,2026-11-09\n';
    json(res, { url: `data:text/csv;charset=utf-8,${encodeURIComponent(`${body.target ?? 'export'}\n${csv}`)}`, traceId: 'mock-trace' });
    return;
  }

  /* ---------------- 会员导入（Mock 不解析真实文件，返回固定演示数据） ---------------- */
  if (path === '/admin/members/import/template') {
    if (needCap('admin:membership:grant')) return;
    const csv = '微信号,昵称,会员等级,有效期至,积分,赠送积分,备注\ncatpaw_vip01,小爪,VIP,2027-06-30,500,100,老会员补录\n';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="member-import-template.csv"');
    res.end(`\uFEFF${csv}`);
    return;
  }
  if (path === '/admin/members/import/preview') {
    if (needCap('admin:membership:grant')) return;
    await readBody(req); // 丢弃 multipart 内容
    json(res, {
      columns: ['微信号', '昵称', '会员等级', '有效期至', '积分', '赠送积分', '备注'],
      unknownColumns: [],
      total: IMPORT_PREVIEW_ROWS.length,
      ok: IMPORT_PREVIEW_ROWS.filter((r) => r.status === 'OK').length,
      warn: IMPORT_PREVIEW_ROWS.filter((r) => r.status === 'WARN').length,
      error: IMPORT_PREVIEW_ROWS.filter((r) => r.status === 'ERROR').length,
      rows: IMPORT_PREVIEW_ROWS,
      fatal: [],
    });
    return;
  }
  if (path === '/admin/members/import/commit' && method === 'POST') {
    if (needCap('admin:membership:grant')) return;
    const body = JSON.parse((await readBody(req)) || '{}') as { rows?: Array<{ row: number; wechatId: string }>; overwrite?: boolean };
    const rows = body.rows ?? [];
    const existed = rows.filter((r) => IMPORT_PREVIEW_ROWS.find((p) => p.row === r.row)?.exists);
    const created = rows.filter((r) => !IMPORT_PREVIEW_ROWS.find((p) => p.row === r.row)?.exists);
    const temporaryPassword = 'Aw1MockImport2026';
    json(res, {
      created: created.length,
      updated: body.overwrite ? existed.length : 0,
      skipped: body.overwrite ? 0 : existed.length,
      failed: 0,
      errors: [],
      credentials: created.map((r) => ({ wechatId: r.wechatId, temporaryPassword })),
    });
    return;
  }

  fail(res, BIZ_CODES.RESOURCE_NOT_FOUND, `Mock 未实现该接口：${method} ${path}`, 404);
}

export function mockApiPlugin(): Plugin {
  return {
    name: 'photo-mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith('/api/v1')) { next(); return; }
        void mockHandler(req, res).catch(() => {
          if (!res.headersSent) fail(res, 5000, 'Mock 处理失败', 500);
        });
      });
    },
  };
}
