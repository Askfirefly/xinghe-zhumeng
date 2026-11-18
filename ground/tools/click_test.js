// click_test.js — 在页面上真实派发一次鼠标点击，验证交互（不是靠直接改状态）
// 用法: node tools/click_test.js <x> <y> "<queryString>"
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const { chrome: CHROME, args: BASE_ARGS } = require('./_chrome');
const PORT = 9600 + Math.floor(Math.random() * 300);
const HTML = path.resolve(__dirname, '../dist/scene.html').split(String.fromCharCode(92)).join('/');
const X = parseInt(process.argv[2] || '640', 10), Y = parseInt(process.argv[3] || '400', 10);
const QS = process.argv[4] || 't=2400&cam=0,1.55,26&yaw=0&pitch=-0.02&auto=0&hud=0&q=high';
const W = 1280, H = 720;
const proc = spawn(CHROME, [...BASE_ARGS,'--remote-debugging-port='+PORT,'--window-size='+W+','+H,'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let page;
  for (let i=0;i<80;i++){ try { const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page=l.find(t=>t.type==='page'); if(page) break; } catch(e){} await sleep(150); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let id=1;
  await new Promise(res => ws.addEventListener('open', res));
  ws.addEventListener('message', ev => { const m=JSON.parse(ev.data);
    if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);return;}
    if (m.method === 'Runtime.exceptionThrown') console.log('[EXC]', JSON.stringify(m.params.exceptionDetails).slice(0,300));
  });
  const send=(method,params={})=>new Promise(res=>{const i=id++;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + HTML + '?' + QS });
  for (let i=0;i<140;i++){ await sleep(120); const r=await send('Runtime.evaluate',{expression:'window.__ready===true',returnByValue:true}); if(r.result&&r.result.value) break; }
  await sleep(1500);
  const before = await send('Runtime.evaluate',{expression:'window.__rocketU ? (window.__rocketU.focus?window.__rocketU.focus.name:"none") : "no rocket"',returnByValue:true});
  console.log('target before click:', before.result.value);
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x:X, y:Y, button:'left', clickCount:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:X, y:Y, button:'left', clickCount:1 });
  await sleep(6500);
  const after = await send('Runtime.evaluate',{expression:'window.__rocketU ? (window.__rocketU.focus?window.__rocketU.focus.name:"none") : "no rocket"',returnByValue:true});
  const ex = await send('Runtime.evaluate',{expression:'window.__rocketU ? window.__rocketU.explode.toFixed(2) : "-"',returnByValue:true});
  console.log('target after click:', after.result.value, ' explode:', ex.result.value);
  const shot = await send('Page.captureScreenshot', { format:'png', fromSurface:true });
  fs.writeFileSync('preview/click_after.png', Buffer.from(shot.data,'base64'));
  console.log('saved preview/click_after.png');
  proc.kill(); process.exit(0);
})().catch(e=>{console.error(e);proc.kill();process.exit(1);});
