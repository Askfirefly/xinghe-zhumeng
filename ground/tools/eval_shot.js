// eval_shot.js — 载入 → 执行一段 JS 改参数 → 截图（不用重新 build 就能试参数）
// 用法: node tools/eval_shot.js <out.png> "<js>" [queryString] [waitMs]
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const { chrome: CHROME, args: BASE_ARGS } = require('./_chrome');
const PORT = 9600 + Math.floor(Math.random() * 300);
const HTML = path.resolve(__dirname, '../dist/scene.html');
const out = process.argv[2];
const JS = process.argv[3] || '';
const QS = process.argv[4] || 't=2400&day=0.50&cam=0,1.55,26&yaw=0&pitch=-0.02&auto=0&hud=0&q=high';
const WAIT = parseInt(process.argv[5] || '2500', 10);
const W = 1280, H = 720;
const proc = spawn(CHROME, [...BASE_ARGS, '--remote-debugging-port=' + PORT, '--window-size=' + W + ',' + H, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let page;
  for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch (e) { } await sleep(150); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let id = 1;
  await new Promise(res => ws.addEventListener('open', res));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[EXC]', (d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  });
  const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + HTML.replace(/\\/g, '/') + '?' + QS });
  for (let i = 0; i < 140; i++) { await sleep(120); const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true }); if (r.result && r.result.value) break; }
  await sleep(900);
  if (JS) {
    const r = await send('Runtime.evaluate', { expression: '(async function(){' + JS + '})()', returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.log('[JSERR]', JSON.stringify(r.exceptionDetails).slice(0, 600));
    else console.log('[js]', JSON.stringify(r.result && r.result.value).slice(0, 400));
  }
  await sleep(WAIT);
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  proc.kill(); process.exit(0);
})().catch(e => { console.error(e); proc.kill(); process.exit(1); });
