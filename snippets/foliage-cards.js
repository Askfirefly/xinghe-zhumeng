// foliage-cards.js — 卡片树冠 + 风摆 + 多物种（已验证）
// 做法：程序化叶片图集 → 多张交叉卡片 → 球面法线 → 风摆注入

/* ---------- 1. 叶片图集（1024–1536²，透明底） ---------- */
function leafTexture(kind) {
  const S = 1536;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const leaf = (x, y, w, h, ang, shade) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const grd = g.createLinearGradient(-w, 0, w, 0);
    grd.addColorStop(0, `rgba(${64*shade|0},${96*shade|0},${44*shade|0},0.97)`);
    grd.addColorStop(0.55, `rgba(${108*shade|0},${148*shade|0},${72*shade|0},0.97)`);
    grd.addColorStop(1, `rgba(${64*shade|0},${96*shade|0},${44*shade|0},0.97)`);
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(0, 0, w, kind === 'narrow' ? h * 0.3 : h, 0, 0, 6.283);
    g.fill();
    g.restore();
  };
  // 主枝 + 逐段叶 + 中心补叶（fill 数量按 kind 调）
  // ...
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- 2. 卡片树冠 ---------- */
function cardCanopy(cards, w, h, cy, spread, seg) {
  const list = [];
  for (let i = 0; i < cards.v; i++) {          // 竖直卡片，绕 Y 均分
    const g = new THREE.PlaneGeometry(w, h, seg, seg);
    g.rotateY((i / cards.v) * Math.PI);
    g.translate((rand() - 0.5) * spread, cy, (rand() - 0.5) * spread);
    list.push(g);
  }
  for (let i = 0; i < cards.t; i++) {          // 倾斜卡片，补顶部体积
    const g = new THREE.PlaneGeometry(w * 0.9, h * 0.8, seg, seg);
    g.rotateX(-Math.PI / 2 + 0.3 + rand() * 0.5);
    g.rotateY(rand() * 3.14);
    g.translate((rand() - 0.5) * spread * 1.4, cy + 0.9, (rand() - 0.5) * spread * 1.4);
    list.push(g);
  }
  const geo = mergeGeos(list);
  // 球面法线：让平面卡片受光接近团块（关键，否则纸片感很强）
  const p = geo.attributes.position.array, n = geo.attributes.normal.array;
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i], dy = p[i+1] - cy, dz = p[i+2];
    const l = Math.hypot(dx, dy, dz) || 1;
    n[i] = dx/l; n[i+1] = dy/l; n[i+2] = dz/l;
  }
  return geo;
}

/* ---------- 3. 材质 + 风摆 ---------- */
const mat = new THREE.MeshStandardMaterial({
  map: leafTex, alphaTest: 0.22, side: THREE.DoubleSide, roughness: 0.9
});
mat.alphaToCoverage = true;     // 远处不掉叶（重要）
mat.onBeforeCompile = (sh) => {
  sh.uniforms.uWindT = windTimeU;
  sh.vertexShader = 'uniform float uWindT;\n' + sh.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
    #ifdef USE_INSTANCING
      vec3 ip = instanceMatrix[3].xyz;
      float sway = sin(uWindT * 1.6 + ip.x * 0.22) * 0.55 + sin(uWindT * 0.93 + ip.z * 0.31) * 0.45;
      float hh = max(transformed.y - 1.2, 0.0);
      transformed.x += sway * hh * 0.026;
      transformed.z += sway * hh * 0.014;
    #endif`
  );
};

// 坑：
// 1. alphaTest 太高（0.45+）会让远处叶片被 mip 吃掉 —— 用 0.22 + alphaToCoverage
// 2. 不做球面法线，卡片看起来是纸片
// 3. 叶片画在纹理中间留白 → 草/树整片消失（quad 太窄，中间面积被光栅化吃掉）
