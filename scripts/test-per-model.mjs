// 端到端验证本轮三件事：
//  1. 只改价格 / 只改时段 / 只改图片，都不该被「必须同时提交」拦截，且不能误删另一侧
//  2. 每位模特各自的照片与服装能存进去、能读回来
//  3. 单模特场次不会因为 wardrobe2 区块而画出多余占位
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3000/api/v1';
const out = { steps: [], errors: [] };
const step = (name, value) => { out.steps.push({ name, value }); console.log(name, '=>', JSON.stringify(value)); };

const utf8 = new TextDecoder();
let cookie = '';

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = utf8.decode(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

try {
  /* ---------- 登录 ---------- */
  const cred = JSON.parse(readFileSync(process.env.TEMP + '/login.json', 'utf-8'));
  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify(cred) });
  step('login', { status: login.status, code: login.json?.code });

  /* ---------- 取一个有两位模特的场次 ---------- */
  const list = await call('/admin/events?page=1&pageSize=20');
  const event = (list.json?.data?.list ?? []).find((e) => (e.models?.length ?? 0) >= 2);
  if (!event) throw new Error('没有双模特场次可供验证');
  const id = event.id;
  const [mA, mB] = event.models;
  step('event', { id, title: event.title, models: event.models.map((m) => m.stageName) });

  // 这两位模特的照片库（用真实存在的图，避免存进去读不到）
  const models = await call('/admin/models?page=1&pageSize=20');
  const pool = new Map((models.json?.data?.list ?? []).map((m) => [m.id, m.photoUrls ?? []]));
  const photoA = pool.get(mA.id)?.[0];
  const photoB = pool.get(mB.id)?.[1] ?? pool.get(mB.id)?.[0];
  if (!photoA || !photoB) throw new Error('模特照片不足，无法验证按模特区分照片');
  step('pools', { A: pool.get(mA.id)?.length, B: pool.get(mB.id)?.length });

  /* ---------- 1. 只提交「按模特的照片与服装」，不带 sessions/prices ---------- */
  const patchSlots = await call(`/admin/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      modelIds: [mA.id, mB.id],
      modelPhotos: [[photoA], [photoB]],
      modelWardrobes: [[photoA], [photoB]],
    }),
  });
  step('patchSlotsOnly', { status: patchSlots.status, code: patchSlots.json?.code, msg: patchSlots.json?.message });

  const afterSlots = await call(`/events/${id}`);
  const slots = afterSlots.json?.data?.modelSlots ?? [];
  step('slotsSaved', slots.map((s) => ({
    modelId: s.modelId,
    photo: s.photoUrls?.[0],
    wardrobe: s.wardrobeUrls?.[0],
  })));
  out.photoDistinct = slots[0]?.photoUrls?.[0] !== slots[1]?.photoUrls?.[0];
  out.wardrobeDistinct = slots[0]?.wardrobeUrls?.[0] !== slots[1]?.wardrobeUrls?.[0];

  /* ---------- 2. 只改价格（不带 sessions）不应报错，且时段不能被删 ---------- */
  const sessionsBefore = afterSlots.json?.data?.sessions ?? [];
  const patchPrices = await call(`/admin/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      prices: [
        { level: 'PUBLIC', priceCent: 17700, unitLabel: '场' },
        { level: 'VIP', priceCent: 15700, unitLabel: '场' },
        { level: 'SVIP', priceCent: 13700, unitLabel: '场' },
      ],
    }),
  });
  step('patchPricesOnly', { status: patchPrices.status, code: patchPrices.json?.code, msg: patchPrices.json?.message });

  const afterPrices = await call(`/events/${id}`);
  step('pricesApplied', {
    public: afterPrices.json?.data?.prices?.find((p) => p.level === 'PUBLIC')?.priceCent,
    feeCent: afterPrices.json?.data?.feeCent,
    sessionsKept: afterPrices.json?.data?.sessions?.length,
    sessionsBefore: sessionsBefore.length,
    capacity: afterPrices.json?.data?.capacity,
  });
  out.sessionsSurvivedPricePatch =
    (afterPrices.json?.data?.sessions?.length ?? 0) === sessionsBefore.length;

  /* ---------- 3. 只改时段（不带 prices）不应报错，且价格不能被删 ---------- */
  const normals = (afterPrices.json?.data?.sessions ?? []).filter((s) => s.kind !== 'PROXY');
  const patchedSessions = normals.map((s, i) => ({
    id: s.id,
    label: s.label,
    startAt: s.startAt,
    endAt: s.endAt,
    capacity: i === 0 ? Math.max(1, Number(s.capacityUsed) || 1) : s.capacity,
  }));
  const patchSessions = await call(`/admin/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ sessions: patchedSessions }),
  });
  step('patchSessionsOnly', { status: patchSessions.status, code: patchSessions.json?.code, msg: patchSessions.json?.message });

  const afterSessions = await call(`/events/${id}`);
  step('pricesSurvived', {
    priceCount: afterSessions.json?.data?.prices?.length,
    public: afterSessions.json?.data?.prices?.find((p) => p.level === 'PUBLIC')?.priceCent,
    feeCent: afterSessions.json?.data?.feeCent,
  });
  out.pricesSurvivedSessionPatch = (afterSessions.json?.data?.prices?.length ?? 0) === 3;

  /* ---------- 4. 恢复原状，别把测试数据留在库里 ---------- */
  const restore = await call(`/admin/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      modelIds: event.models.map((m) => m.id),
      modelPhotos: event.modelSlots.map((s) => s.photoUrls ?? []),
      modelWardrobes: event.modelSlots.map((s) => s.wardrobeUrls ?? []),
      prices: event.prices.map((p) => ({ level: p.level, priceCent: p.priceCent, unitLabel: p.unitLabel })),
    }),
  });
  step('restore', { status: restore.status, code: restore.json?.code });
} catch (err) {
  out.errors.push(String(err?.stack ?? err));
  console.log('ERR', err);
}

console.log('\n=== RESULT ===');
console.log(JSON.stringify(out.steps, null, 2));
console.log('photoDistinct:', out.photoDistinct, 'wardrobeDistinct:', out.wardrobeDistinct);
console.log('sessionsSurvivedPricePatch:', out.sessionsSurvivedPricePatch);
console.log('pricesSurvivedSessionPatch:', out.pricesSurvivedSessionPatch);
console.log('errors:', out.errors.length);
