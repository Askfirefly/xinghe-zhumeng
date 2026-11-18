// build.js — 把 three.cjs / app.js / 行星贴图内联成单文件 HTML
// 用法：node build.js
const fs = require('fs');
const path = require('path');
const root = __dirname;

function findThree() {
  const local = path.join(root, 'vendor/three.cjs');
  if (fs.existsSync(local)) return local;
  try { return require.resolve('three/build/three.cjs'); } catch (e) {}
  throw new Error('找不到 three.cjs：请在 vendor/ 下放 three.cjs，或 npm i three');
}

const threePath = findThree();
const three = fs.readFileSync(threePath, 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
let shell = fs.readFileSync(path.join(root, 'src/shell.html'), 'utf8');

const texNames = ['mercury', 'venusatm', 'earthday', 'earthnight', 'earthclouds', 'mars', 'moon'];
for (const n of texNames) {
  const p = path.join(root, 'src/tex_' + n + '.b64');
  const b64 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  if (!b64) console.warn('warn: 缺贴图 tex_' + n + '.b64（先跑 tools/fetch_tex.py）');
  shell = shell.split('__TEX_' + n.toUpperCase() + '__').join(b64);
}

for (const [name, src] of [['three', three], ['app', app]]) {
  if (src.includes('</script')) throw new Error(name + ' contains </script');
}

let out = shell.split('/*__THREE__*/').join(three);
out = out.split('/*__APP__*/').join(app);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/scene.html'), out);
console.log('built dist/scene.html', (out.length / 1024 / 1024).toFixed(2) + ' MB', '| three:', threePath);