// shots.js — 批量出图（一次启动一个浏览器，多机位连拍）
// 用法: node tools/shots.js <outdir> [tag]
// 机位定义见 PRESETS；URL 参数 t/day/q/cam/yaw/pitch/fov
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chrome: CHROME, args: BASE_ARGS } = require('./_chrome');

const OUT = path.resolve(process.argv[2] || 'preview');
const TAG = process.argv[3] || '';
const HTML = path.resolve(__dirname, '../dist/scene.html');
const W = parseInt(process.env.W || '1280', 10), H = parseInt(process.env.H || '720', 10);
const Q = process.env.SQ || 'high';
const PORT = 9600 + Math.floor(Math.random() * 300);

// 0.0=06:00 0.25=12:00 0.5=18:00 0.75=00:00
const PRESETS = [
  { n: 'a_road_forward', p: 't=2400&day=0.487&cam=0,1.55,26&yaw=0&pitch=-0.02&auto=0&hud=0' },
  { n: 'b_sea_left',     p: 't=2400&day=0.487&cam=-6,4.6,-62&yaw=-1.16&pitch=-0.14&auto=0&hud=0' },
  { n: 'c_sea_low',      p: 't=2400&day=0.487&cam=-34,-9.5,-120&yaw=-0.20&pitch=0.00&auto=0&hud=0' },
  { n: 'd_tower_refl',   p: 't=2400&day=0.487&cam=-34,-10.5,-64&yaw=1.02&pitch=0.30&auto=0&hud=0' },
  { n: 'e_night',        p: 't=2400&day=0.86&cam=0,1.55,26&yaw=0&pitch=-0.02&auto=0&hud=0' },
  { n: 'f_ground_macro', p: 't=2400&day=0.487&cam=0.4,1.5,10&yaw=-0.30&pitch=-0.46&auto=0&hud=0' },
  { n: 'g_roadside_sea', p: 't=2400&day=0.487&cam=3.0,3.4,-120&yaw=-1.30&pitch=-0.17&auto=0&hud=0' },
  { n: 'h_midday',       p: 't=2400&day=0.30&cam=0,1.55,26&yaw=0&pitch=-0.02&auto=0&hud=0' },
  { n: 'i_sea_edge',     p: 't=2400&day=0.46&cam=-26,-9.0,-36&yaw=-0.95&pitch=-0.10&auto=0&hud=0' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=d3d11',
  '--force_high_performance_gpu', '--remote-debugging-port=' + PORT, '--window-size=' + W + ',' + H,
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let page;
  for (let i = 0; i < 80; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find(t => t.type === 'page'); if (page) break; } catch (e) { } await sleep(150); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let id = 1;
  await new Promise(res => ws.addEventListener('open', res));
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.ONLY;
  for (const s of PRESETS) {
    if (only && !only.split(',').some(k => s.n.includes(k))) continue;
    const url = 'file:///' + HTML.replace(/\\/g, '/') + '?' + s.p + '&q=' + Q;
    const t0 = Date.now();
    await send('Page.navigate', { url });
    let ready = false;
    for (let i = 0; i < 140; i++) { await sleep(120); const r = await send('Runtime.evaluate', { expression: 'window.__ready===true', returnByValue: true }); if (r.result && r.result.value) { ready = true; break; } }
    await sleep(1500);
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const f = path.join(OUT, (TAG ? TAG + '_' : '') + s.n + '.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`${ready ? 'ok ' : 'TMO'} ${s.n} ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.basename(f)}`);
  }
  proc.kill(); process.exit(0);
})().catch(e => { console.error(e); proc.kill(); process.exit(1); });
