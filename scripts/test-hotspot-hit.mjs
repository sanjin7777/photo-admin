// 复现并验证：新增「第二模特图」后，点「第二模特服装」应当选中服装，而不是被大图抢走。
// 同时验证拖动时会出现对齐辅助线。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 19564;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-hit-profile`,
  '--window-size=1500,1000',
  'about:blank',
], { stdio: 'ignore' });

let ws; let msgId = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); if (targets?.length) break; } catch { /* wait */ }
  }
  if (!targets?.length) throw new Error('CDP 未就绪');
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');

  await send('Page.navigate', { url: 'http://localhost:5174/admin/login' });
  await sleep(4500);
  await evaluate(`
    (async () => {
      const inputs = [...document.querySelectorAll('input')];
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
        setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(inputs.find(i => i.type === 'text'), 'admin_catpaw');
      setVal(inputs.find(i => i.type === 'password'), 'Photo@12345');
      [...document.querySelectorAll('button')].find(b => /登录/.test(b.textContent||'')).click();
    })()
  `);
  await sleep(5000);
  await send('Page.navigate', { url: 'http://localhost:5174/admin/events' });
  await sleep(5000);
  await evaluate(`
    (async () => {
      [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('导出海报')).click();
      await new Promise(r => setTimeout(r, 1400));
      [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('打开设计器')).click();
      await new Promise(r => setTimeout(r, 6000));
    })()
  `);
  await sleep(2000);

  /* ---------- 1. 加一个「第二模特图」（会被 push 到数组末尾、拿到最高 z） ---------- */
  const added = await evaluate(`
    (async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('+ 第二模特图'));
      if (!btn) return 'no-add-button';
      btn.click();
      await new Promise(r => setTimeout(r, 2500));
      return 'added';
    })()
  `);
  console.log('add stage2:', added);

  /* ---------- 2. 点「第二模特服装」的中心，看最终选中谁 ---------- */
  const hit = await evaluate(`
    (async () => {
      const hot = (label) => [...document.querySelectorAll('.poster-hotspot')]
        .find(h => (h.querySelector('.poster-hotspot-label')?.textContent||'').trim().startsWith(label));
      const target = hot('第二模特服装') || hot('当日服装');
      if (!target) return 'no-wardrobe-block';
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const el = document.elementFromPoint(cx, cy);
      const topHot = el?.closest?.('.poster-hotspot');
      const topLabel = topHot ? (topHot.querySelector('.poster-hotspot-label')?.textContent||'').trim() : null;

      const panelTitle = () => {
        const heads = [...document.querySelectorAll('.el-card__header')]
          .map(h => (h.textContent||'').trim())
          .filter(t => t && !t.includes('区块图层') && !t.includes('添加区块'));
        return heads[0] ?? null;
      };

      // 普通点击
      el?.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 600));
      const afterPlain = panelTitle();

      // Alt+点击：应能在重叠区块之间循环
      const seen = new Set();
      for (let i = 0; i < 6; i++) {
        el?.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true, altKey: true }));
        await new Promise(r2 => setTimeout(r2, 250));
        const t = panelTitle();
        if (t) seen.add(t);
      }

      return {
        pointOnTop: topLabel,
        afterPlainClick: afterPlain,
        altClickCycle: [...seen],
        skippedBlocks: [...document.querySelectorAll('.poster-hotspot.is-skipped')]
          .map(h => (h.querySelector('.poster-hotspot-label')?.textContent||'').trim()),
        zOrderMatchesDom: (() => {
          // 校验：DOM 顺序应与 z 升序一致（后面的在更上层）
          const hs = [...document.querySelectorAll('.poster-hotspot')];
          return hs.map(h => (h.querySelector('.poster-hotspot-label')?.textContent||'').trim());
        })(),
      };
    })()
  `);
  console.log('hit test:', JSON.stringify(hit, null, 2));

  /* ---------- 3. 拖动一小段，检查是否出现对齐辅助线 ---------- */
  const guideCheck = await evaluate(`
    (async () => {
      const target = [...document.querySelectorAll('.poster-hotspot')]
        .find(h => (h.querySelector('.poster-hotspot-label')?.textContent||'').trim().startsWith('活动标题'));
      if (!target) return 'no-title-block';
      const r = target.getBoundingClientRect();
      const sx = r.left + 10;
      const sy = r.top + 10;
      target.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 1, isPrimary: true }));
      for (let i = 1; i <= 10; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + i * 2, clientY: sy + i * 1, bubbles: true, pointerId: 1, isPrimary: true }));
        await new Promise(r2 => setTimeout(r2, 30));
      }
      const guidesDuring = document.querySelectorAll('.poster-guide').length;
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 20, clientY: sy + 10, bubbles: true, pointerId: 1, isPrimary: true }));
      await new Promise(r2 => setTimeout(r2, 400));
      const guidesAfter = document.querySelectorAll('.poster-guide').length;
      return { guidesDuringDrag: guidesDuring, guidesAfterDrop: guidesAfter };
    })()
  `);
  console.log('guides:', JSON.stringify(guideCheck));

  /* ---------- 4. 关键回归：小卡 z 更高时，点击必须选中小卡 ---------- */
  const zTest = await evaluate(`
    (async () => {
      const byLabel = (label) => [...document.querySelectorAll('.poster-hotspot')]
        .find(h => (h.querySelector('.poster-hotspot-label')?.textContent||'').trim().startsWith(label));
      const panelTitle = () => {
        const heads = [...document.querySelectorAll('.el-card__header')]
          .map(h => (h.textContent||'').trim())
          .filter(t => t && !t.includes('区块图层') && !t.includes('添加区块'));
        return heads[0] ?? null;
      };

      // 选中「第二模特服装」，点「置顶」把它抬到最上层
      const w2 = byLabel('第二模特服装');
      if (!w2) return 'no-wardrobe2';
      const r0 = w2.getBoundingClientRect();
      w2.dispatchEvent(new MouseEvent('click', { clientX: r0.left + 5, clientY: r0.top + 5, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const selBefore = panelTitle();

      const topBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '置顶');
      if (!topBtn) return 'no-top-button';
      topBtn.click();
      await new Promise(r => setTimeout(r, 1200));

      // 再点它自己的中心
      const w2b = byLabel('第二模特服装');
      const r = w2b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const el = document.elementFromPoint(cx, cy);
      el?.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 700));

      return { selectedBeforeTop: selBefore, selectedAfterTopAndClick: panelTitle() };
    })()
  `);
  console.log('z-order regression:', JSON.stringify(zTest));

  // 清理：恢复预设，别把测试版式留在库里
  await evaluate(`
    fetch('/api/v1/admin/settings/poster/layout', {
      method: 'PUT', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: null }),
    }).then(r => r.status)
  `);
} catch (err) {
  console.log('ERR ' + String(err?.stack ?? err));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
}
