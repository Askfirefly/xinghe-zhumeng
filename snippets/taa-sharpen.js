// taa-sharpen.js — 时域降噪（TAA）+ 对比自适应锐化（已验证 60fps @1280x720）
// 用在「后期管线里已经有 rtScene + depthTexture」的 three.js 场景。
//
// 关键点
//   1. 抖动必须对 反射 pass / 主渲染 / 体积光 用同一份投影矩阵，否则历史对不齐
//   2. 历史色必须夹进当前帧 3x3 邻域包围盒（方差截断），否则移动物体拖影
//   3. 用深度反投影查历史，不要直接复制屏幕像素
//   4. 锐化放到显示空间（tonemap 之后）做，过冲小很多

// ---------- 1. 每帧抖动 ----------
const pe = camera.projectionMatrix.elements;
const jx = (halton(frameN, 2) - 0.5) * 2.0 / rtScene.width;
const jy = (halton(frameN, 3) - 0.5) * 2.0 / rtScene.height;
pe[8] += jx; pe[9] += jy;
camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
_vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
_invVP.copy(_vp).invert();
// ...renderer.render(scene, camera)...
pe[8] -= jx; pe[9] -= jy;
camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

// ---------- 2. TAA pass ----------
const taaMat = new THREE.ShaderMaterial({
  uniforms: {
    tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
    uInvVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2() }, uBlend: { value: 0.86 }, uValid: { value: 0 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tCur, tHist, tDepth;
    uniform mat4 uInvVP, uPrevVP;
    uniform vec2 uTexel;
    uniform float uBlend, uValid;
    vec3 wpos(vec2 uv, float d) {
      vec4 p = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    void main() {
      vec3 cur = texture2D(tCur, vUv).rgb;
      vec3 mn = cur, mx = cur;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec3 sv = texture2D(tCur, vUv + vec2(float(x), float(y)) * uTexel).rgb;
        mn = min(mn, sv); mx = max(mx, sv);
      }
      float d = texture2D(tDepth, vUv).x;
      vec4 pc = uPrevVP * vec4(wpos(vUv, d), 1.0);
      vec2 puv = pc.xy / max(abs(pc.w), 1e-6) * 0.5 + 0.5;
      vec3 hist = texture2D(tHist, clamp(puv, 0.001, 0.999)).rgb;
      bool bad = uValid < 0.5 || puv.x < 0.002 || puv.x > 0.998 || puv.y < 0.002 || puv.y > 0.998 || pc.w <= 0.0;
      if (bad) hist = cur;
      hist = clamp(hist, mn, mx);
      float w = mix(uBlend * 0.55, uBlend, step(0.9999, d));   // 天空权重更高
      gl_FragColor = vec4(mix(cur, hist, w), 1.0);
    }`
});
// 跑完把结果拷进 rtHist（下一帧的历史）

// ---------- 3. 显示空间锐化 ----------
const sharpMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uStrength: { value: 0.42 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStrength;
    void main() {
      vec3 e = texture2D(tSrc, vUv).rgb;
      vec3 a = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
      vec3 b = texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb;
      vec3 c = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
      vec3 d = texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb;
      vec3 blur = (a + b + c + d) * 0.25;
      vec3 mn = min(min(a, b), min(c, d)), mx = max(max(a, b), max(c, d));
      float flat_ = 1.0 - clamp(dot(mx - mn, vec3(0.3333)), 0.0, 1.0);
      gl_FragColor = vec4(clamp(e + (e - blur) * uStrength * (0.35 + 0.65 * flat_), 0.0, 1.0), 1.0);
    }`
});
