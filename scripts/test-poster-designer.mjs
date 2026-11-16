// 用 Chrome DevTools Protocol 驱动真实页面，验证设计器能加载、能拖拽、能保存。
// 不引第三方依赖：直接连 Chrome 的 ws 调试端口，用原生 WebSocket 发 CDP 指令。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// 注意：Windows 把 3292-3391 列为保留端口段，往那段 bind() 会直接失败。
// 这里用 19555（高位、非保留段），与本地 MySQL 迁到 13306 是同一类问题。
const PORT = 19555;
const URL = 'http://localhost:5174/admin/login';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-poster-profile`,
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 45000);
  });
}

async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result?.value;
}

function waitForWs(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onopen = () => resolve(sock);
    sock.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)));
  });
}

try {
  // 等 Chrome 把调试端口起来
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets?.length) break;
    } catch { /* 还没起来 */ }
  }
  if (!targets?.length) throw new Error('Chrome 调试端口未就绪');

  const page = targets.find((t) => t.type === 'page');
  ws = await waitForWs(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const out = { steps: [], errors: [] };
  const step = (name, value) => { out.steps.push({ name, value }); };

  /* ---------- 1. 登录 ---------- */
  await send('Page.navigate', { url: URL });
  await sleep(4000);

  await evaluate(`
    (async () => {
      const inputs = [...document.querySelectorAll('input')];
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const idInput = inputs.find(i => /微信号|账号/.test(i.placeholder || '') || i.type === 'text');
      const pwInput = inputs.find(i => i.type === 'password');
      if (!idInput || !pwInput) return 'inputs-not-found:' + inputs.map(i => i.placeholder + '/' + i.type).join(',');
      setVal(idInput, 'admin_catpaw');
      setVal(pwInput, 'Photo@12345');
      const btn = [...document.querySelectorAll('button')].find(b => /登录|登 录/.test(b.textContent || ''));
      if (!btn) return 'no-login-button';
      btn.click();
      return 'clicked';
    })()
  `);
  await sleep(4500);
  const afterLogin = await evaluate('location.pathname + "|" + (document.body.innerText||"").slice(0,80)');
  step('login', afterLogin);

  /* ---------- 2. 打开场次页 ---------- */
  await send('Page.navigate', { url: 'http://localhost:5174/admin/events' });
  await sleep(4500);
  const eventsPage = await evaluate(`
    (() => {
      const txt = document.body.innerText || '';
      const buttons = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim());
      return { hasExport: buttons.some(b => b.includes('导出海报')), buttonSample: buttons.slice(0, 25), len: txt.length };
    })()
  `);
  step('eventsPage', eventsPage);

  /* ---------- 3. 打开导出弹窗并点「打开设计器」 ---------- */
  const opened = await evaluate(`
    (async () => {
      const btns = [...document.querySelectorAll('button')];
      const exp = btns.find(b => (b.textContent||'').includes('导出海报'));
      if (!exp) return 'no-export-button';
      exp.click();
      await new Promise(r => setTimeout(r, 1200));
      const all = [...document.querySelectorAll('button')];
      const designer = all.find(b => (b.textContent||'').includes('打开设计器'));
      if (!designer) return 'no-designer-button:' + all.map(b=>(b.textContent||'').trim()).filter(Boolean).join('|');
      designer.click();
      await new Promise(r => setTimeout(r, 3500));
      return 'opened';
    })()
  `);
  step('openDesigner', opened);

  /* ---------- 4. 设计器是否真的渲染出画布与区块 ---------- */
  const designerState = await evaluate(`
    (() => {
      const canvas = document.querySelector('.poster-preview');
      const hotspots = [...document.querySelectorAll('.poster-hotspot')];
      const title = [...document.querySelectorAll('.el-dialog__title')].map(t => t.textContent.trim());
      return {
        dialogTitles: title,
        canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
        hotspotCount: hotspots.length,
        labels: hotspots.map(h => (h.querySelector('.poster-hotspot-label')?.textContent || '').trim()).filter(Boolean),
        hasAddPanel: (document.body.innerText||'').includes('添加区块'),
        hasSaveBtn: [...document.querySelectorAll('button')].some(b => (b.textContent||'').includes('保存版式')),
      };
    })()
  `);
  step('designerState', designerState);

  /* ---------- 5. 拖拽一个区块，确认坐标变了 ---------- */
  const dragResult = await evaluate(`
    (async () => {
      const hs = [...document.querySelectorAll('.poster-hotspot')];
      if (!hs.length) return 'no-hotspots';
      const h = hs.find(x => (x.querySelector('.poster-hotspot-label')?.textContent||'').includes('场地')) || hs[0];
      const r = h.getBoundingClientRect();
      const sx = r.left + r.width/2, sy = r.top + r.height/2;
      const before = h.style.left + ',' + h.style.top;
      const down = new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 1, isPrimary: true });
      h.dispatchEvent(down);
      for (let i = 1; i <= 8; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + i*6, clientY: sy + i*4, bubbles: true, pointerId: 1, isPrimary: true }));
        await new Promise(r => setTimeout(r, 25));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 48, clientY: sy + 32, bubbles: true, pointerId: 1, isPrimary: true }));
      await new Promise(r => setTimeout(r, 500));
      return { before, after: h.style.left + ',' + h.style.top, moved: (h.style.left + ',' + h.style.top) !== before };
    })()
  `);
  step('drag', dragResult);

  /* ---------- 6. 保存版式，确认接口 200 且提示出现 ---------- */
  const saveResult = await evaluate(`
    (async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('保存版式'));
      if (!btn) return 'no-save-button';
      btn.click();
      await new Promise(r => setTimeout(r, 2500));
      const body = document.body.innerText || '';
      return { savedToast: /版式已保存/.test(body), snippet: body.slice(0, 160) };
    })()
  `);
  step('save', saveResult);

  /* ---------- 7. 刷新页面，确认版式被持久化（不再是预设） ---------- */
  // 注意：必须走同源相对路径。页面在 localhost:5174，如果这里写 127.0.0.1:3000
  // 就是跨站请求，HttpOnly cookie 不会带上，接口会返回「请先登录」。
  const persisted = await evaluate(`
    (async () => {
      const res = await fetch('/api/v1/admin/settings/poster', { credentials: 'include' });
      const body = await res.json();
      return {
        code: body.code,
        hasLayout: Boolean(body.data && body.data.layout),
        blockCount: body.data?.layout?.blocks?.length ?? 0,
        qrIntact: Boolean(body.data?.qrUrl),
      };
    })()
  `);
  step('persisted', persisted);

  /* ---------- 收尾：恢复预设，不把测试版式留在库里 ---------- */
  const cleanup = await evaluate(`
    (async () => {
      const res = await fetch('/api/v1/admin/settings/poster/layout', {
        method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout: null }),
      });
      return { status: res.status, body: await res.json() };
    })()
  `);
  step('cleanup', cleanup);

  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.log(JSON.stringify({ fatal: String(err?.stack ?? err) }, null, 2));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
}
