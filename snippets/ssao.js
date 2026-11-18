// ssao.js — 半分辨率屏幕空间环境光遮蔽（照 Saltline 的 X6/Y6 改写，已验证 60fps）
// 用途：让物体真正"落地"——护栏压出接触暗部、塔架根部有阴影、墙角不发飘。
//
// 三段：
//   1) depthH：把 rtScene 的 depth 降到半分辨率（texelFetch 抽 2×2 单点，避免线性采样插值出假深度）
//   2) ao：反投影求视空间位置 → 邻域差分求法线 → 半球采样累积遮蔽
//   3) blur + 合成时乘进颜色（放在 tonemap 之前、bloom 之前）

// ---------- 1. 半分辨率深度 ----------
const depthHMat = new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv; uniform sampler2D tDepth;
    void main(){
      ivec2 p = min(ivec2(gl_FragCoord.xy) * 2, textureSize(tDepth, 0) - 1);
      gl_FragColor = vec4(texelFetch(tDepth, p, 0).r, 0.0, 0.0, 1.0);
    }`
});

// ---------- 2. AO ----------
const AO_TAPS = 12;
const aoMat = new THREE.ShaderMaterial({
  uniforms: {
    tDepthH: { value: null }, uNear: { value: 0.1 }, uFar: { value: 3000 },
    uTanHalf: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 0.38 }, uIntensity: { value: 1.0 }, uAspect: { value: 1.777 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    #define AO_TAPS ${AO_TAPS}
    varying vec2 vUv;
    uniform sampler2D tDepthH;
    uniform vec2 uTanHalf, uTexel;
    uniform float uNear, uFar, uRadius, uIntensity, uAspect;
    float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    float linZ(float d){ return (uNear * uFar) / (uFar - d * (uFar - uNear)); }
    vec3 vpos(vec2 uv, float z){ return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }
    void main(){
      float d0 = texture2D(tDepthH, vUv).r;
      float z0 = linZ(d0);
      if (d0 >= 0.99999 || z0 > 400.0) { gl_FragColor = vec4(1.0); return; }
      vec3 P = vpos(vUv, z0);
      // 法线：邻域差分（用 |dz| 较小的一侧，避免跨过轮廓）
      vec2 ox = vec2(uTexel.x * 2.0, 0.0), oy = vec2(0.0, uTexel.y * 2.0);
      float zl = linZ(texture2D(tDepthH, vUv - ox).r), zr = linZ(texture2D(tDepthH, vUv + ox).r);
      float zd = linZ(texture2D(tDepthH, vUv - oy).r), zu = linZ(texture2D(tDepthH, vUv + oy).r);
      vec3 dx = abs(zl - z0) < abs(zr - z0) ? P - vpos(vUv - ox, zl) : vpos(vUv + ox, zr) - P;
      vec3 dy = abs(zd - z0) < abs(zu - z0) ? P - vpos(vUv - oy, zd) : vpos(vUv + oy, zu) - P;
      vec3 n = normalize(cross(dx, dy));

      // ★ 半径和屏幕空间上限都要小：掠射地面上 0.85m/0.16uv 会采到几米外，vv 极小 → 噪声爆炸 → AO 死黑
      float R = uRadius * (0.5 + 0.5 * clamp(z0 / 10.0, 0.0, 1.0));
      float rUv = clamp(R / (2.0 * z0 * uTanHalf.y), 3.0 * uTexel.y, 0.055);
      float R2 = R * R;
      float rot = ign(gl_FragCoord.xy) * 6.2831853;
      float sum = 0.0;
      for (int i = 0; i < AO_TAPS; i++) {
        float a = (float(i) + 0.5) / float(AO_TAPS);
        float th = a * 6.2831853 * 3.0 + rot;
        vec2 oo = vec2(cos(th), sin(th)) * a * rUv; oo.x /= uAspect;
        vec2 uv2 = vUv + oo;
        vec3 v = vpos(uv2, linZ(texture2D(tDepthH, uv2).r)) - P;
        float vv = dot(v, v), vn = dot(v, n);
        float f = max(R2 - vv, 0.0);
        sum += f * f * f * max((vn - (0.02 + 0.012 * z0)) / (vv + 0.01), 0.0);
      }
      float ao = clamp(1.0 - uIntensity * sum * 6.0 / (R2 * R2 * R2 * float(AO_TAPS)), 0.42, 1.0);
      ao = mix(ao, 1.0, smoothstep(180.0, 420.0, z0));
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }`
});

// ---------- 3. 合成 ----------
// comp 里：col *= mix(1.0, texture2D(tAO, uv).r, uAO);   // uAO ≈ 0.9
//         放在取到场景色之后、bloom / tonemap 之前
