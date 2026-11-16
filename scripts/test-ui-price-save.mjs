// 真实 UI 验证：只改一个价格 → 保存应成功（不再被「必须同时提交时段与价格」拦截）。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 19562;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-save-profile`,
  '--window-size=1400,1100',
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

  // 打开编辑弹窗，只改「标准积分」
  const changed = await evaluate(`
    (async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '编辑');
      if (!btn) return 'no-edit';
      btn.click();
      await new Promise(r => setTimeout(r, 3000));
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => (d.textContent||'').includes('编辑场次'));
      if (!dlg) return 'no-dialog';

      // 找「标准积分」那一行的数字输入框
      const labels = [...dlg.querySelectorAll('*')].filter(el =>
        el.children.length === 0 && (el.textContent||'').trim() === '标准积分');
      const label = labels[0];
      if (!label) return 'no-price-label';
      const formItem = label.closest('.el-form-item') || label.parentElement.parentElement;
      const input = formItem.querySelector('input');
      if (!input) return 'no-price-input';

      const before = input.value;
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, String(Number(before) + 1));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      await new Promise(r => setTimeout(r, 400));
      return { before, after: input.value };
    })()
  `);
  console.log('price changed:', JSON.stringify(changed));

  // 保存并观察提示
  const saved = await evaluate(`
    (async () => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => (d.textContent||'').includes('编辑场次'));
      const btn = [...dlg.querySelectorAll('button')].find(b => (b.textContent||'').includes('保存修改'));
      if (!btn) return 'no-save';
      btn.click();
      await new Promise(r => setTimeout(r, 3500));
      const msg = [...document.querySelectorAll('.el-message')].map(m => (m.textContent||'').trim());
      const stillOpen = Boolean([...document.querySelectorAll('.el-dialog')]
        .find(d => (d.textContent||'').includes('编辑场次')));
      return { messages: msg, dialogStillOpen: stillOpen, bodyHasError: (document.body.innerText||'').includes('修改时段必须同时提交') };
    })()
  `);
  console.log('save result:', JSON.stringify(saved));

  // 复核：时段与价格都还在
  const verifyState = await evaluate(`
    fetch('/api/v1/events/10', { credentials: 'include' })
      .then(r => r.json())
      .then(b => ({
        code: b.code,
        sessions: b.data?.sessions?.length,
        prices: b.data?.prices?.map(p => p.level + ':' + p.priceCent),
        feeCent: b.data?.feeCent,
      }))
  `);
  console.log('state:', JSON.stringify(verifyState));
} catch (err) {
  console.log('ERR ' + String(err?.stack ?? err));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
}
