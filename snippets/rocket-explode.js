// rocket-explode.js — 点击模型 → 拆解 / 合拢，部件浮空 + DOM 标签
// 验证：星河追梦 60.2fps（长征五号 8 个部件）
//
// 要点：
//  1) 每个部件是一个 Group，记录 base（原位）与 off（拆解位移），
//     每帧 pos = base + off * smoothstep(explode)，不要用补间库
//  2) 拾取用 Raycaster.intersectObject(root, true)，命中就切换 target
//  3) 标签是 DOM 覆盖层：project(camera) 定位，靠边自动换边，按屏幕 y 排序防重叠
//  4) 拆解时把周围建筑淡出（材质 opacity），否则部件和建筑糊在一起

const rocketU = { explode: 0, target: 0 };
const parts = [/* { obj: Group, base:{x,y,z}, off:{x,y,z}, label, el } */];
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
const _wp = new THREE.Vector3(), _proj = new THREE.Vector3();

renderer.domElement.addEventListener('pointerdown', (ev) => {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  if (_ray.intersectObject(rocketGroup, true).length) {
    rocketU.target = rocketU.target > 0.5 ? 0 : 1;
  }
});

function updateExplode(dt) {
  rocketU.explode += (rocketU.target - rocketU.explode) * Math.min(1, dt * 3.2);
  const e = rocketU.explode * rocketU.explode * (3 - 2 * rocketU.explode);  // smoothstep
  const slots = [];
  for (const p of parts) {
    p.obj.position.set(p.base.x + p.off.x * e, p.base.y + p.off.y * e, p.base.z + p.off.z * e);
    if (!p.el || e < 0.06) { if (p.el) p.el.style.opacity = '0'; continue; }
    p.obj.getWorldPosition(_wp);
    _proj.copy(_wp).project(camera);
    if (_proj.z > 1) { p.el.style.opacity = '0'; continue; }
    const sx = (_proj.x * 0.5 + 0.5) * innerWidth;
    const sy = (-_proj.y * 0.5 + 0.5) * innerHeight;
    const right = sx < 300;                       // 靠左就摆右侧，避免出画
    p.el.classList.toggle('right', right);
    slots.push({ el: p.el, x: sx + (right ? 150 : -150), y: sy });
  }
  // 防重叠：按屏幕 y 排序后强制最小间距
  slots.sort((a, b) => a.y - b.y);
  let lastY = -1e9;
  for (const s of slots) {
    let y = Math.max(s.y, lastY + 30);
    lastY = y;
    s.el.style.left = s.x + 'px'; s.el.style.top = y + 'px';
    s.el.style.opacity = String(Math.min(1, (e - 0.06) * 4));
  }
}

// CSS（引线在标签右侧，.right 时翻到左侧）
const css = `
#rocketLabels{position:fixed;inset:0;pointer-events:none;z-index:5}
.rlabel{position:absolute;transform:translate(-50%,-50%);padding:4px 9px;border-radius:3px;
  background:rgba(8,14,22,.62);border:1px solid rgba(150,200,255,.45);color:#dceaf6;
  font:12px/1.45 "Microsoft YaHei",sans-serif;white-space:nowrap;opacity:0;transition:opacity .25s}
.rlabel::after{content:"";position:absolute;right:-16px;top:50%;width:14px;height:1px;background:rgba(150,200,255,.65)}
.rlabel.right::after{right:auto;left:-16px}`;

// 坑：`const group` 还没建就把代码塞进去 → "Cannot access 'group' before initialization"
//     整个页面白屏。收集周围建筑材质这类事一定要放在容器创建之后。
