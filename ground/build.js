// build.js — 把 three.cjs 与 app.js 内联成单文件 HTML（Windows / macOS 通用）
//
// 用法：node build.js
// three.js 的查找顺序：
//   1) ./vendor/three.cjs                （仓库自带，优先用这个）
//   2) node_modules/three/build/three.cjs（自己装了 three 的话）
const fs = require('fs');
const path = require('path');

const root = __dirname;

function findThree() {
  const local = path.join(root, 'vendor/three.cjs');
  if (fs.existsSync(local)) return local;
  try { return require.resolve('three/build/three.cjs'); } catch (e) { /* fallthrough */ }
  try {
    const pkg = require.resolve('three/package.json');
    const guess = path.join(path.dirname(pkg), 'build/three.cjs');
    if (fs.existsSync(guess)) return guess;
  } catch (e) { /* fallthrough */ }
  throw new Error('找不到 three.cjs：请在 ground/ 下放 vendor/three.cjs，或 npm i three');
}

const threePath = findThree();
const three = fs.readFileSync(threePath, 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const shell0 = fs.readFileSync(path.join(root, 'src/shell.html'), 'utf8');

// 注意：这两个占位符名字不一样（历史原因），别统一成 B64 后缀
const extras = [['dust', '__DUSTB64__'], ['armlum', '__ARMLUM__']];
let shell = shell0;
for (const [n, token] of extras) {
  const p = path.join(root, 'src/' + n + '.b64');
  const b64 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  shell = shell.split(token).join(b64);
}

const names = ['tex_rock_diff','tex_rock_nor','tex_rock_rough','tex_road_diff','tex_road_nor','tex_road_rough',
  'tex_gnd_diff','tex_gnd_nor','tex_gnd_rough','tex_met_diff','tex_met_nor','tex_met_rough',
  'tex_pnt_diff','tex_pnt_nor','tex_pnt_rough','tex_water_nor','tex_grs_diff','tex_grs_nor'];
for (const n of names) {
  const p = path.join(root, 'src/' + n + '.b64');
  const b64 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  shell = shell.split('__' + n.toUpperCase() + '__').join(b64);
}

for (const [name, src] of [['three', three], ['app', app]]) {
  if (src.includes('</script')) throw new Error(name + ' contains </script');
  if (src.includes('/*__' + (name === 'three' ? 'THREE' : 'APP') + '__*/')) throw new Error('marker collision');
}

let out = shell.split('/*__THREE__*/').join(three);
out = out.split('/*__APP__*/').join(app);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/scene.html'), out);
console.log('built dist/scene.html', (out.length / 1024 / 1024).toFixed(2) + ' MB', '| three:', threePath);
