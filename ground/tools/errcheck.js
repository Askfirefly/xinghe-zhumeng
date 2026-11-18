// errcheck.js — 载入场景并把 console / 异常全打出来（含 shader 编译日志）
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const { chrome: CHROME, args: BASE_ARGS } = require('./_chrome');
const PORT = 9600 + Math.floor(Math.random() * 300);
const HTML = path.resolve(__dirname, '../dist/scene.html');
const QS = process.argv[2] || 't=2400&day=0.50&cam=0,1.55,26&yaw=0&auto=0&hud=0&q=high';
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=d3d11',
  '--force_high_performance_gpu', '--remote-debugging-port=' + PORT, '--window-size=900,560', 'about:blank'], { stdio: 'ignore' });
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
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.type; const a = (m.params.args || []).map(x => x.value !== undefined ? String(x.value).slice(0, 700) : (x.description || x.type)).join(' ');
      console.log(`[console.${t}] ${a}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[EXC]', (d.exception && (d.exception.description || d.exception.value)) || d.text, '@line', d.lineNumber);
    }
    if (m.method === 'Log.entryAdded') console.log('[log]', m.params.entry.level, m.params.entry.text.slice(0, 700));
  });
  const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + HTML.replace(/\\/g, '/') + '?' + QS });
  await sleep(parseInt(process.env.WAIT || '9000', 10));
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({ready:window.__ready,fps:window.__fps,frames:window.__frames})', returnByValue: true });
  console.log('STATE', r.result && r.result.value);
  proc.kill(); process.exit(0);
})().catch(e => { console.error(e); proc.kill(); process.exit(1); });
