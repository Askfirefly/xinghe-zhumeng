/* ============================================================
   暮雨 · 双行道 — Stage 2
   新增
     · 昼夜循环：6 分钟 = 1 天，太阳/月亮升落，星空，天空与光照随时段变化
     · 路灯随黄昏亮起、清晨熄灭
     · 屏幕雨滴：随机溅落 → 滚落拖尾
     · 草随相机无限延展，并加密；地面加入土壤/湿斑/砾石细节
     · 云层加到 5 层，增加层次
     · 太阳方位右移 ≈200px（1600 宽视野），左下角罗盘 + 时间
   ============================================================ */
(function () {
  'use strict';
  const T = window.THREE;

  const Q = new URLSearchParams(location.search);
  const FIXED_T = Q.has('t') ? parseFloat(Q.get('t')) : null;
  const FREEZE = FIXED_T !== null || Q.get('freeze') === '1';
  const QUAL = (Q.get('q') === 'low' || Q.get('q') === 'mid' || Q.get('q') === 'high')
    ? Q.get('q') : (localStorage.getItem('rainroad_quality') || 'mid');
  const LOWQ = QUAL === 'low';
  const VEG = QUAL === 'high' ? 1.35 : (QUAL === 'mid' ? 0.85 : 0.45);
  const NOAUTO = Q.get('auto') === '0';
  const NOREFL = Q.get('refl') === '0';
  const NOPOST = Q.get('post') === '0';
  // 相机移动时启用 TAA，静止时使用 MSAA；?taa=0 可完全关闭。
  const USE_TAA = Q.get('taa') !== '0';
  const NOSHAFTS = Q.get('shafts') === '0';
  const NOBLM = Q.get('bloom') === '0';
  const SHOWHUD = Q.get('hud') !== '0';
  const FIXED_DAY = Q.has('day') ? parseFloat(Q.get('day')) : null;

  const rand = (function (seed) {
    let s = seed >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  })(20261102);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- 1. 渲染器 ---------- */
  const canvas = document.getElementById('scene');
  const renderer = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;

  /* ---------- PCSS 软阴影：改写 three 的 getShadow ---------- */
  (function patchShadowPCSS() {
    const key = 'shadowmap_pars_fragment';
    const src = T.ShaderChunk[key];
    if (!src || src.indexOf('SL_PCSS') >= 0) return;
    const i = src.indexOf('float getShadow( sampler2DShadow');
    if (i < 0) { console.warn('[shadow] chunk layout changed, keep stock PCF'); return; }
    let j = src.indexOf('{', i), depth = 0, end = -1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) return;
    const repl = [
      'float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
      '  /* SL_PCSS: Vogel 圆盘 + IGN 抖动，半径按光源深度轻微放大 */',
      '  float shadow = 1.0;',
      '  float distW = max(shadowCoord.w, 1.0);',
      '  shadowCoord.xyz /= shadowCoord.w;',
      '  shadowCoord.z += shadowBias;',
      '  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;',
      '  bool frustumTest = inFrustum && shadowCoord.z <= 1.0;',
      '  if ( frustumTest ) {',
      '    vec2 texelSize = vec2( 1.0 ) / shadowMapSize;',
      '    float pen = shadowRadius * ( 0.85 + 0.15 * clamp( distW * 0.02, 0.0, 1.0 ) );',
      '    float radius = pen * texelSize.x;',
      '    float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;',
      '    float sum = 0.0;',
      '    for ( int k = 0; k < 16; k ++ ) {',
      '      vec2 o = vogelDiskSample( k, 16, phi ) * radius;',
      '      sum += texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z ) );',
      '    }',
      '    shadow = sum / 16.0;',
      '  }',
      '  return mix( 1.0, shadow, shadowIntensity );',
      '}'
    ].join('\n');
    T.ShaderChunk[key] = src.slice(0, i) + repl + src.slice(end);
    console.log('[shadow] PCSS patch applied');
  })();

  const scene = new T.Scene();
  const FOG = { color: new T.Color(0xb08f7e), density: 0.0118 };
  scene.fog = new T.FogExp2(FOG.color.getHex(), FOG.density);

  const camera = new T.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000);
  window.__scene = scene; window.__renderer = renderer; window.__camera = camera;
  camera.position.set(0.9, 1.55, 14);

  /* ---------- 2. 时间系统 ---------- */
  const DAY_SECONDS = 360;
  let dayT = FIXED_DAY !== null ? FIXED_DAY : 0.487;
  const SUN_AZ_SUNSET = T.MathUtils.degToRad(25.2);

  const SUN_DIR = new T.Vector3(0, 0, -1);
  const MOON_DIR = new T.Vector3(0, 0, 1);
  let sunElev = 0.18;

  function updateCelestial() {
    const elev = Math.sin(dayT * Math.PI * 2) * T.MathUtils.degToRad(70);
    const azim = SUN_AZ_SUNSET + (dayT - 0.5) * Math.PI * 2;
    SUN_DIR.set(
      Math.sin(azim) * Math.cos(elev),
      Math.sin(elev),
      -Math.cos(azim) * Math.cos(elev)
    ).normalize();
    const mElev = clamp(-elev * 0.5, -0.25, 0.62);
    const mAzim = azim + Math.PI;
    MOON_DIR.set(Math.sin(mAzim) * Math.cos(mElev), Math.sin(mElev), -Math.cos(mAzim) * Math.cos(mElev)).normalize();
    sunElev = elev;
  }
  function clockString(d) {
    const h = (d * 24 + 6) % 24;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  /* ---------- 3. 天空 ---------- */
  const skyU = {
    uSunDir: { value: SUN_DIR },
    uMoonDir: { value: MOON_DIR },
    uZenith: { value: new T.Color(0x3f7fc4) },
    uMid: { value: new T.Color(0x6b98cc) },
    uCool: { value: new T.Color(0xd2a08c) },
    uWarm: { value: new T.Color(0xff7a2e) },
    uSunDisk: { value: 1.0 },
    uMoonDisk: { value: 0.0 },
    uNight: { value: 0.0 }
  };

  /* ---- 星座亮星（真实赤经赤纬，不打标签，让人自己认） ---- */
  const CONST_STARS = [
    // 北斗七星
    [11.062, 61.75, 0.62, 1.00, 0.86, 0.64], [11.031, 56.38, 0.55, 0.86, 0.91, 1.00],
    [11.897, 53.69, 0.52, 0.90, 0.93, 1.00], [12.257, 57.03, 0.42, 0.90, 0.93, 1.00],
    [12.900, 55.96, 0.60, 0.90, 0.93, 1.00], [13.399, 54.92, 0.55, 0.90, 0.93, 1.00],
    [13.792, 49.31, 0.58, 0.76, 0.86, 1.00],
    // 猎户座
    [5.919, 7.41, 0.88, 1.00, 0.60, 0.40], [5.242, -8.20, 0.94, 0.70, 0.83, 1.00],
    [5.418, 6.35, 0.56, 0.82, 0.89, 1.00], [5.796, -9.67, 0.50, 0.82, 0.89, 1.00],
    [5.679, -1.94, 0.55, 0.86, 0.91, 1.00], [5.604, -1.20, 0.58, 0.86, 0.91, 1.00],
    [5.533, -0.30, 0.50, 0.90, 0.93, 1.00],
    // 仙后座 W
    [0.675, 56.54, 0.55, 1.00, 0.82, 0.60], [0.153, 59.15, 0.52, 0.95, 0.95, 1.00],
    [0.945, 60.72, 0.52, 0.86, 0.91, 1.00], [1.430, 60.24, 0.45, 0.90, 0.93, 1.00],
    [1.907, 63.67, 0.38, 0.90, 0.93, 1.00],
    // 全天亮星
    [6.752, -16.72, 1.00, 0.76, 0.86, 1.00],   // 天狼
    [18.615, 38.78, 0.85, 0.86, 0.93, 1.00],   // 织女
    [19.846, 8.87, 0.70, 0.95, 0.95, 1.00],    // 牛郎
    [20.690, 45.28, 0.65, 0.95, 0.95, 1.00],   // 天津四
    [2.530, 89.26, 0.62, 1.00, 0.93, 0.80],    // 北极星
    [14.261, 19.18, 0.82, 1.00, 0.72, 0.45],   // 大角
    [5.278, 45.99, 0.78, 1.00, 0.88, 0.66],    // 五车二
    [7.655, 5.22, 0.72, 1.00, 0.95, 0.85]      // 南河三
  ];
  const constDir = [], constCol = [], constMag = [];
  for (const c of CONST_STARS) {
    const ra = c[0] * Math.PI / 12, dec = c[1] * Math.PI / 180;
    constDir.push(new T.Vector3(Math.cos(dec) * Math.cos(ra), Math.sin(dec), Math.cos(dec) * Math.sin(ra)));
    constCol.push(new T.Vector3(c[3], c[4], c[5]));
    constMag.push(c[2]);
  }
  const constStarU = { value: constDir.map((v, i) => new T.Vector4(v.x, v.y, v.z, constMag[i])) };
  const constColU = { value: constCol };
  skyU.uConstStar = constStarU;
  skyU.uConstCol = constColU;

  const dustTex = (() => {
    const el = document.getElementById('dustB64');
    const t = new T.Texture();
    if (el && el.textContent.trim().length > 100) {
      const img = new Image();
      img.onload = () => { t.image = img; t.needsUpdate = true; };
      img.src = 'data:image/png;base64,' + el.textContent.trim();
    }
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.magFilter = T.LinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = T.NoColorSpace;
    return t;
  })();

  const armLumTex = (() => {
    const el = document.getElementById('armLumB64');
    const t = new T.Texture();
    if (el && el.textContent.trim().length > 50) {
      const img = new Image();
      img.onload = () => { t.image = img; t.needsUpdate = true; };
      img.src = 'data:image/png;base64,' + el.textContent.trim();
    }
    t.wrapS = T.RepeatWrapping;
    t.wrapT = T.ClampToEdgeWrapping;
    t.minFilter = T.LinearFilter;
    t.magFilter = T.LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = T.NoColorSpace;
    return t;
  })();

  skyU.tDust = { value: dustTex };
  skyU.tArmLum = { value: armLumTex };

  const skyMat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, fog: false,
    uniforms: Object.assign({
      uSkyRot: { value: new T.Matrix3() },
      uGalPole: { value: new T.Vector3(0.38, 0.22, 0.90).normalize() },
      uTime: { value: 0 },
      uMeteorA: { value: [new T.Vector3(0, 1, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 1, 0)] },
      uMeteorB: { value: [new T.Vector3(0, 1, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 1, 0)] },
      uMeteorT: { value: new Float32Array([-1, -1, -1]) }
    }, skyU),
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSunDir, uMoonDir, uZenith, uMid, uCool, uWarm, uGalPole;
      uniform float uSunDisk, uMoonDisk, uNight, uTime;
      uniform vec4 uConstStar[27];
      uniform vec3 uConstCol[27];
      uniform sampler2D tDust;
      uniform sampler2D tArmLum;
      uniform mat3 uSkyRot;
      uniform vec3 uMeteorA[3], uMeteorB[3];
      uniform float uMeteorT[3];

      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
      float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float vn2(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        float a = h2(i), b = h2(i+vec2(1,0)), c = h2(i+vec2(0,1)), d = h2(i+vec2(1,1));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      float fbm2(vec2 p){ float s=0.0, a=0.5;
        for(int i=0;i<5;i++){ s += a*vn2(p); p = p*2.06 + vec2(7.3,3.9); a *= 0.5; } return s; }

      float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
      float vn3(vec3 p){
        vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        float a = h3(i), b = h3(i+vec3(1,0,0)), c = h3(i+vec3(0,1,0)), d = h3(i+vec3(1,1,0));
        float e = h3(i+vec3(0,0,1)), f1 = h3(i+vec3(1,0,1)), g = h3(i+vec3(0,1,1)), h = h3(i+vec3(1,1,1));
        return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,f1,f.x), mix(g,h,f.x), f.y), f.z);
      }
      float fbm3(vec3 p){ float s=0.0, a=0.55;
        for(int i=0;i<2;i++){ s += a*vn3(p); p = p*2.11 + vec3(3.1,7.7,5.3); a *= 0.5; } return s; }

      // ---- 星场：色温 / 亮度 / 大小 / 星芒 ----
      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }
      vec3 starTint(float t) {
        vec3 c1 = vec3(0.62, 0.74, 1.00);   // O/B 蓝白
        vec3 c2 = vec3(0.97, 0.98, 1.00);   // A  白
        vec3 c3 = vec3(1.00, 0.92, 0.76);   // G  黄白
        vec3 c4 = vec3(1.00, 0.68, 0.46);   // K/M 橙红
        vec3 c = mix(c1, c2, smoothstep(0.0, 0.32, t));
        c = mix(c, c3, smoothstep(0.32, 0.64, t));
        c = mix(c, c4, smoothstep(0.64, 1.0, t));
        return c;
      }
      vec3 starLayer(vec3 dir, float scale, float dens, float seed, float bright,
                     float bandSig, float laneSig) {
        vec3 p = dir * scale + seed;
        vec3 cell = floor(p);
        float bandMask = smoothstep(0.010, 0.85, bandSig);
        float dm = dens * mix(0.28, 1.0, bandMask) * (1.0 + 3.2 * bandSig) * (1.0 - 0.80 * laneSig);
        if (hash13(cell) >= dm) return vec3(0.0);
        vec3 sdir = normalize(cell + hash33(cell + 11.0));
        vec3 dd = dir - sdir;
        float ang = length(dd);
        float mag = pow(hash13(cell + 57.0), 3.2);
        float size = mix(0.00042, 0.00105, mag) * bright;
        float core = exp(-pow(ang / size, 2.0));
        return starTint(hash13(cell + 13.0)) * core * (0.55 + 3.4 * mag);
      }

      void main(){
        vec3 d = normalize(vDir);
        float hz = max(d.y, 0.0);

        vec2 dh = normalize(vec2(d.x, d.z) + 1e-5);
        vec2 sh = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
        float az = max(dot(dh, sh), 0.0);

        vec3 horizon = mix(uCool, uWarm, pow(az, 5.0));
        float hw = exp(-hz * 13.0);
        vec3 col = mix(uZenith, horizon, hw);
        col = mix(col, uMid, smoothstep(0.05, 0.32, hz) * (1.0 - smoothstep(0.32, 0.95, hz)) * 0.38);

        float band = clamp(hw * (1.0 - hw) * 4.0, 0.0, 1.0);
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum * 1.06, lum * 0.99, lum * 0.92), band * 0.50);

        // ---- 银河（旋臂 + 分形乳光 + 尘埃遮挡）----
        vec3 sd = uSkyRot * d;
        vec3 galX = normalize(cross(uGalPole, vec3(0.0, 1.0, 0.0)));
        vec3 galY = cross(uGalPole, galX);
        float glon = atan(dot(sd, galY), dot(sd, galX));
        float glat = dot(sd, uGalPole);
        vec2 gcirc = vec2(cos(glon), sin(glon));
        float galBand = exp(-pow(glat / 0.17, 2.0));
        float horizonFade = smoothstep(0.0, 0.06, d.y);

        float armA = pow(0.5 + 0.5 * cos(glon * 3.0 + glat * 6.0), 3.0);
        float armB = pow(0.5 + 0.5 * cos(glon * 5.0 - glat * 4.0 + 1.7), 4.0);
        float armC = pow(0.5 + 0.5 * cos(glon * 2.0 + glat * 9.0 + 3.1), 2.0);
        float coreGal = exp(-pow(glon / 0.55, 2.0)) * exp(-pow(glat / 0.16, 2.0));
        float wisp = fbm2(gcirc * 3.2 + vec2(0.0, glat * 9.0) + sd.xz * 2.0);

        if (uNight > 0.01) {
          // ---- 银河三层结构：外圈橙红 → 主带亮白 → 中心深紫黑 ----
          // ---- 按参考照片实测的横向剖面重建（指数衰减，不是高斯）----
          // 实测：d=100px 处亮度 0.45L，d=200 处 0.17L → exp(-d/126) 拟合最好
          float dLat = abs(glat);
          float coreB = exp(-dLat / 0.050);
          float mainB = exp(-dLat / 0.256);     // e 折 ≈ 14.7°（再加宽 250px）
          float haloB = exp(-dLat / 0.640);     // 长尾，融进夜空
          // 沿臂的疏密（圆周噪声，无接缝）
          float grain = fbm2(gcirc * 42.0 + vec2(0.0, glat * 110.0));
          float clump = 0.62 + 0.70 * grain;
          // 沿臂亮度：直接用照片提取的一维剖面（周期化）
          float armLum = texture2D(tArmLum, vec2(glon * 0.15915 + 0.5, 0.5)).r;
          float armShape = mix(0.55, 1.45, armLum);
          float armW = (0.42 + 0.30 * armA + 0.18 * armB + 0.10 * armC) * armShape;

          // 尘埃：两层拉伸噪声，条状分叉
          // 尘埃结构：来自参考照片的可平铺纹理 + 一层噪声扰动
          vec2 duv = vec2(glon * 1.2732, glat * 4.2);   // 8/(2π)，整数重复 → 接缝连续
          float dustTex = texture2D(tDust, duv).r;
          float dustN2 = fbm2(gcirc * 11.0 + vec2(0.0, glat * 48.0) + 7.3);
          float dustMask = smoothstep(0.30, 0.78, dustTex * 0.78 + dustN2 * 0.28);
          float lane = exp(-dLat / 0.105) * dustMask;

          // 照片实测色：核心暖白 (93,78,74)，外圈偏冷蓝紫
          vec3 cWarm = vec3(1.00, 0.86, 0.80);
          vec3 cMid = vec3(0.95, 0.87, 0.82);
          vec3 cCool = vec3(0.56, 0.60, 0.74);

          col += cCool * haloB * (0.20 + 0.45 * armA) * 0.030 * uNight * horizonFade;
          col += cMid * mainB * armW * clump * 0.085 * uNight * horizonFade;
          col += cWarm * coreB * armW * 0.075 * uNight * horizonFade;
          // 暗尘埃（深褐）
          col = mix(col, vec3(0.035, 0.024, 0.019), lane * 0.90 * uNight);

          // 旋臂内星密、旋臂外星疏
          float armSig = galBand * (0.25 + 0.30 * armA + 0.20 * armB) * (0.50 + 0.60 * wisp) * armShape;
          armSig += galBand * coreGal * 0.45;
          // 星云 / 星尘：中频团块 + 冷暖分色
          float nebN = fbm2(gcirc * 8.5 + vec2(glat * 16.0, 0.0) + 11.3);
          float nebMask = smoothstep(0.50, 0.86, nebN) * galBand;
          vec3 nebCol = mix(vec3(0.62, 0.30, 0.55), vec3(0.28, 0.52, 0.78),
                            smoothstep(0.35, 0.75, fbm2(gcirc * 3.0 + vec2(glat * 6.0, 0.0) + 5.1)));
          col += nebCol * nebMask * 0.050 * uNight * horizonFade;
          float laneSig = lane;
          vec3 st = starLayer(sd, 300.0, 0.020, 0.0, 1.0, armSig, laneSig)
                  + starLayer(sd, 520.0, 0.0125, 19.0, 0.85, armSig, laneSig)
                  + starLayer(sd, 780.0, 0.0065, 41.0, 1.55, armSig, laneSig)
                  + starLayer(sd, 1500.0, 0.030, 71.0, 0.55, armSig, laneSig) * 1.6;
          col += st * 2.0 * smoothstep(0.35, 0.90, uNight) * horizonFade;

          // 星座亮星（不打标签）
          float constVis = smoothstep(0.30, 0.80, uNight) * horizonFade;
          for (int i = 0; i < 27; i++) {
            vec4 cs = uConstStar[i];
            vec3 cd = sd - cs.xyz;
            float ang = length(cd);
            float size = mix(0.00050, 0.00115, cs.w);
            float core = exp(-pow(ang / size, 2.0));
            col += uConstCol[i] * core * (1.8 + 4.0 * cs.w) * constVis;
          }
        }

        // ---- 流星（只在夜里，尺寸收敛）----
        float meteorVis = smoothstep(0.25, 0.75, uNight);
        for (int i = 0; i < 3; i++) {
          float mt = uMeteorT[i];
          if (mt < 0.0 || meteorVis < 0.01) continue;
          vec3 a = normalize(uMeteorA[i]);
          vec3 b = normalize(uMeteorB[i]);
          vec3 head = normalize(mix(a, b, mt));
          float life = sin(mt * 3.14159);
          float glow = 0.0;
          vec3 tint = vec3(0.0);
          // 8 段尾迹：越靠后越宽、越暗、越偏暖
          for (int k = 0; k < 8; k++) {
            float f = float(k);
            vec3 hp = normalize(mix(head, a, 0.018 * f * (1.0 + 0.35 * f)));
            float dd = acos(clamp(dot(sd, hp), -1.0, 1.0));
            float width = 0.0016 + 0.0012 * f;
            float seg = exp(-pow(dd / width, 2.0)) * (1.0 - 0.09 * f);
            glow += seg;
            tint += seg * mix(vec3(1.0, 0.97, 0.92), vec3(1.0, 0.52, 0.22), f / 8.0);
          }
          // 尾焰颗粒（火花）
          for (int k = 0; k < 7; k++) {
            float fk = float(k) / 7.0;
            vec3 ep = normalize(mix(head, a, 0.03 + fk * 0.30));
            vec3 side = normalize(cross(ep, vec3(0.0, 1.0, 0.0)) + 1e-4);
            float rnd = hash(vec3(fk * 17.0, uTime * 0.7, float(i))) - 0.5;
            float rnd2 = hash(vec3(fk * 9.0, uTime * 0.4, 3.0 + float(i))) - 0.5;
            ep = normalize(ep + side * rnd * 0.030 + vec3(0.0, rnd2 * 0.024, 0.0));
            float dd = acos(clamp(dot(sd, ep), -1.0, 1.0));
            col += vec3(1.0, 0.62, 0.28) * exp(-pow(dd / 0.0018, 2.0)) * (0.45 - 0.05 * fk) * life * horizonFade * meteorVis;
          }

          float headGlow = exp(-pow(acos(clamp(dot(sd, head), -1.0, 1.0)) / 0.011, 2.0));
          float halo = exp(-pow(acos(clamp(dot(sd, head), -1.0, 1.0)) / 0.030, 2.0));
          col += (tint * 3.0 + vec3(1.0, 0.98, 0.94) * headGlow * 9.0) * life * horizonFade * meteorVis;
          col += vec3(0.55, 0.75, 1.0) * halo * 0.16 * life * horizonFade * meteorVis;
        }

        // ================= 云海（照 Saltline：一整片云 + 太阳洞，替掉原来 5 层平面云）=================
        {
          float hh = max(d.y, 0.0);
          vec2 sh2 = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
          float tsun = max(dot(dh, sh2), 0.0);
          float mu = dot(d, uSunDir);
          float dayC = 1.0 - uNight;

          // 视线打到云层平面上的投影（越贴地平线越密，远处自然收束）
          vec2 cuv = d.xz / (hh + 0.085) * vec2(0.62, 0.95);
          vec2 q = cuv + vec2(-0.010, 0.005) * uTime * 0.12;
          float warp = fbm2(q * 0.42 + 7.1);
          vec2 qq = q + (warp - 0.5) * 1.15;
          float dens = fbm2(qq * 1.05 + 3.3);
          dens = mix(dens, fbm2(qq * 2.6 + 11.0), 0.45);
          float body = dens * 0.80 + fbm2(q * 0.17 + 3.7) * 0.34;

          // 夜里留薄一点，别把银河盖死
          float cov = smoothstep(0.50, 0.80, body) * mix(0.16, 1.0, dayC);

          // 云海边缘：朝太阳让开一条燃烧的空隙
          float edge = mix(0.035, 0.30, pow(tsun, 1.6));
          float rag = (vn2(q * 0.9 + 11.0) - 0.5) * 0.16 + (dens - 0.5) * 0.10;
          cov *= smoothstep(edge - 0.035, edge + 0.12, hh + rag * (0.35 + tsun));

          // 太阳处烧一个洞
          float hole = smoothstep(0.972, 0.9985, mu + (dens - 0.5) * 0.012);
          cov *= 1.0 - 0.93 * hole;

          // 云底自阴影：朝太阳方向的密度梯度
          vec2 sd2 = normalize(uSunDir.xz + 1e-5);
          float densS = fbm2(qq + sd2 * 0.22);
          float relief = clamp((dens - densS) * 4.5 + 0.5, 0.0, 1.0);
          float thick = smoothstep(0.45, 0.78, body);
          vec3 coolC = mix(uMid * 0.62, uZenith * 0.40, thick);
          coolC *= 0.55 + 0.95 * relief * relief;
          // 正午的云是被太阳照亮的白积云；只有低太阳才变暗蓝/被烧红
          float highSun = smoothstep(0.12, 0.55, uSunDir.y);
          vec3 litCloud = vec3(0.80, 0.84, 0.90) * (0.45 + 0.75 * relief);
          coolC = mix(coolC, litCloud, highSun * (0.6 + 0.4 * relief));
          coolC *= mix(0.28, 1.0, dayC);                       // 夜里的云只是暗影
          float nearSun = pow(tsun, 5.0) * exp(-max(hh - edge, 0.0) * 4.5) * 0.9
                        + pow(max(mu, 0.0), 7.0) * 0.9;
          float lowSun = pow(1.0 - clamp(uSunDir.y, 0.0, 1.0), 1.6);
          vec3 warmC = (uWarm * vec3(1.30, 0.70, 0.44)) * nearSun
                     * (0.06 + 2.2 * relief * relief * relief) * (1.0 - uNight * 0.88)
                     * mix(0.12, 1.0, lowSun);
          float rimC = cov * (1.0 - cov) * 4.0;
          warmC += vec3(1.0, 0.86, 0.66) * rimC * pow(tsun, 4.0)
                 * (0.5 + 1.6 * pow(max(mu, 0.0), 6.0)) * (1.0 - 0.85 * hole)
                 * (1.0 - uNight * 0.8) * mix(0.35, 1.0, lowSun);
          vec3 cloudC = coolC + warmC;
          vec3 hc2 = mix(uCool, uWarm, pow(tsun, 5.0));
          cloudC = mix(cloudC, hc2 * 0.55 + cloudC * 0.45, exp(-hh * 11.0));
          col = mix(col, cloudC, cov * 0.985);
        }

        // ---- 太阳 ----
        float ang = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
        float rr = ang / 0.036;
        float disk = exp(-pow(rr, 2.2) * 3.2);
        col += vec3(1.0, 0.84, 0.64) * disk * uSunDisk * 2.6;
        // 太阳辉光必须收紧：原来 exp(-rr^2*0.55) 的半宽 ≈ 60°，整片天被糊成白光，
        // 于是没有明暗对比、影子也看不见（这一轮最大的"光影怪"来源）
        col += vec3(1.0, 0.52, 0.26) * exp(-pow(rr, 2.0) * 9.0) * 0.42 * uSunDisk;
        col += vec3(1.0, 0.44, 0.16) * exp(-ang * 26.0) * 1.10 * uSunDisk;

        // ---- 月亮（带环形山暗斑）----
        float mAng = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
        float mr = mAng / 0.020;
        float mdisk = smoothstep(1.15, 0.85, abs(mr)) * 0.95 + exp(-pow(mr, 2.0) * 2.0) * 0.25;
        vec3 mdir = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + 1e-4);
        vec3 mup = cross(mdir, uMoonDir);
        vec2 mp = vec2(dot(d, mdir), dot(d, mup)) / 0.030;
        float craters = 0.82 + 0.18 * fbm2(mp * 3.0 + 11.0);
        float moonRise = smoothstep(-0.02, 0.16, uMoonDir.y);
        col += vec3(0.92, 0.94, 1.0) * mdisk * craters * uMoonDisk * 2.4 * moonRise;
        col += vec3(0.55, 0.66, 0.95) * exp(-mAng * 14.0) * 0.10 * uMoonDisk;

        col = mix(col, vec3(0.66, 0.45, 0.35), exp(-hz * 30.0) * 0.14 * (1.0 - uNight));
        col = mix(col, vec3(0.02, 0.03, 0.05), smoothstep(0.0, -0.06, d.y) * (0.4 + 0.6 * uNight));
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }`
  });
  const sky = new T.Mesh(new T.SphereGeometry(2000, 48, 32), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -100;
  scene.add(sky);

  /* ---------- 4. 光照 ---------- */
  const sunLight = new T.DirectionalLight(0xffffff, 3.0);
  sunLight.castShadow = true;
  const SHADOW_RES = QUAL === 'high' ? 8192 : (QUAL === 'mid' ? 4096 : 2048);
  sunLight.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
  const sc = sunLight.shadow.camera;
  sc.left = -175; sc.right = 175; sc.top = 155; sc.bottom = -155;
  sc.near = 40; sc.far = 460;
  sc.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.09;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.radius = 3.6;
  scene.add(sunLight, sunLight.target);

  const moonLight = new T.DirectionalLight(0x8fb0e8, 0.0);
  scene.add(moonLight, moonLight.target);

  const hemi = new T.HemisphereLight(0x9dbde0, 0x45402c, 1.6);
  const amb = new T.AmbientLight(0x2f4056, 0.55);
  scene.add(amb);
  scene.add(hemi);

  /* ---------- 5. 环境反射 ---------- */
  const cubeRT = new T.WebGLCubeRenderTarget(160, { type: T.HalfFloatType, generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
  const cubeCam = new T.CubeCamera(0.4, 900, cubeRT);
  scene.add(cubeCam);

  const skyOnly = new T.Scene();
  skyOnly.add(new T.Mesh(sky.geometry, skyMat));
  const pmrem = new T.PMREMGenerator(renderer);
  let envRT = null;

  /* ---------- 6. 云（5 层） ---------- */
  const cloudsU = [];
  const cloudDrift = new T.Vector2(0, 0);
  function cloudLayer(o) {
    const u = {
      uDrift: { value: cloudDrift }, uSunDir: { value: SUN_DIR }, uCamPos: { value: camera.position },
      uOpacity: { value: o.opacity }, _baseOpacity: o.opacity, uScale: { value: o.scale }, uSeed: { value: o.seed },
      uBand: { value: o.band }, uCover: { value: o.cover }, uLit: { value: new T.Color(2.0, 1.0, 0.6) }, uShade: { value: new T.Color(0.1, 0.12, 0.2) }
    };
    const mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, side: T.DoubleSide, fog: false,
      uniforms: u,
      vertexShader: `
        varying vec2 vUv; varying vec3 vW;
        void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; varying vec3 vW;
        uniform float uOpacity, uScale, uSeed, uBand, uCover;
        uniform vec3 uLit, uShade;
        uniform vec2 uDrift; uniform vec3 uSunDir, uCamPos;

        float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float vn(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
        }
        float fbm(vec2 p){ float s=0.0, a=0.5;
          for(int i=0;i<6;i++){ s += a*vn(p); p = p*2.03 + vec2(11.3,7.7); a *= 0.5; } return s; }

        void main(){
          vec2 wo = (vW.xz - uDrift) * uScale + uSeed * 31.0;
          float warp = fbm(wo * 0.24 + 1.7);
          float n = fbm(wo * 1.05 + warp * 1.6);
          float cluster = smoothstep(0.36, 0.70, fbm(wo * 0.16 + 9.1));
          float band = sin(dot(wo, normalize(vec2(0.26, 1.0))) * uBand + warp * 2.4);
          float ridge = smoothstep(-0.3, 0.92, band);
          float shape = cluster * (0.22 + 0.40 * ridge + 0.66 * n);

          float dens = smoothstep(uCover, uCover + 0.030, shape) * 0.66
                     + smoothstep(uCover + 0.01, uCover + 0.22, shape) * 0.34;
          float erode = fbm(wo * 3.6 + warp * 2.2 + uSeed);
          dens *= smoothstep(0.08, 0.55, erode) * 0.8 + 0.2;
          dens *= smoothstep(0.0, 0.24, n);

          vec2 e = abs(vUv * 2.0 - 1.0);
          dens *= smoothstep(1.0, 0.5, max(e.x, e.y));
          dens *= smoothstep(3400.0, 700.0, length(vW.xz - uCamPos.xz));

          vec3 v = normalize(vW - uCamPos);
          float fwd = pow(max(dot(v, uSunDir), 0.0), 9.0);

          vec2 towardSun = normalize(uSunDir.xz);
          float nSun = fbm((wo - towardSun * 0.09) * 1.05 + warp * 1.5);
          float selfShadow = clamp(1.0 - (nSun - n) * 4.2, 0.30, 1.0);

          vec3 c = mix(uShade, uLit, clamp(fwd * 1.45 + 0.06, 0.0, 1.0));
          c *= selfShadow;
          c += uLit * pow(fwd, 1.4) * 0.45;

          gl_FragColor = vec4(c, dens * uOpacity);
        }`
    });
    const mesh = new T.Mesh(new T.PlaneGeometry(o.size, o.size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = o.y;
    mesh.renderOrder = -50;
    scene.add(mesh);
    cloudsU.push(u);
    return u;
  }
  const clouds = [
    // 云已经搬进天空 shader 的「云海」里了，这里只留最薄的一层做视差，避免双重云
    cloudLayer({ y: 260, size: 9000, scale: 0.00080, opacity: 0.10, band: 4.0, cover: 0.45, seed: 3.0 })
  ];

  /* ---------- 7. 地面（湿土 + 碎石：真实 PBR 双尺度采样，三向错位破平铺） ---------- */
  const groundU = {
    uSunDir: { value: SUN_DIR }, uSunCol: { value: new T.Color(1, 0.7, 0.5) },
    uAmb: { value: new T.Color(0.3, 0.38, 0.5) }, uAmbI: { value: 1.0 },
    uSkyTop: { value: new T.Color(0x1b2a4a) }, uSkyHor: { value: new T.Color(0xff9a52) },
    uFogColor: { value: FOG.color }, uFogDensity: { value: FOG.density }, uCamPos: { value: camera.position },
    tGndDiff: { value: null }, tGndNor: { value: null }, tGndRough: { value: null },
    uClipOn: { value: 0 }, uClipY: { value: -1e9 },
    uLampPos: { value: Array.from({ length: 6 }, () => new T.Vector3()) },
    uLampCol: { value: Array.from({ length: 6 }, () => new T.Vector3()) },
    uLampN: { value: 0 }
  };
  const ground = new T.Mesh(new T.PlaneGeometry(3000, 3000), new T.ShaderMaterial({
    uniforms: groundU,
    vertexShader: `
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vW;
      uniform vec3 uSunDir, uSunCol, uAmb, uFogColor, uCamPos, uSkyTop, uSkyHor;
      uniform sampler2D tGndDiff, tGndNor, tGndRough;
      uniform float uClipOn, uClipY;
      uniform vec3 uLampPos[6]; uniform vec3 uLampCol[6]; uniform int uLampN;
      uniform float uAmbI, uFogDensity;

      float hash(vec2 p){ p = fract(p*vec2(127.1, 311.7)); p += dot(p, p+34.7); return fract(p.x*p.y); }
      float vn(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      float fbm(vec2 p){ float s=0.0, a=0.5;
        for(int i=0;i<4;i++){ s += a*vn(p); p = p*2.07 + vec2(5.3,9.1); a *= 0.5; } return s; }

      vec2 rot2(vec2 p, float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c)*p; }
      float lum(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }

      void main(){
        if (uClipOn > 0.5 && vW.y < uClipY) discard;
        vec2 p = vW.xz;
        float dist = length(uCamPos.xz - p);

        // ---- 三尺度错位采样：破掉肉眼可见的网格重复 ----
        vec2 uvA = rot2(p, 0.0)        * 0.105;   // 9.5 m
        vec2 uvB = rot2(p, 0.647)      * 0.0345;  // 29 m（大尺度色斑）
        vec2 uvC = rot2(p, 1.902)      * 0.42;    // 2.4 m（近处颗粒）
        vec3 tA = texture2D(tGndDiff, uvA).rgb;
        vec3 tB = texture2D(tGndDiff, uvB).rgb;
        vec3 tC = texture2D(tGndDiff, uvC).rgb;
        float nearW = 1.0 - smoothstep(9.0, 34.0, dist);

        // 基色：湿土偏暗，色相由贴图携带，亮度用宏噪声拉开
        float macro = fbm(p * 0.0125 + 4.0);
        vec3 soil = mix(vec3(0.075, 0.062, 0.048), vec3(0.155, 0.128, 0.092), macro);
        soil *= (0.30 + 1.55 * lum(tA * 2.2));           // 细节明暗（高对比）
        soil *= (0.66 + 0.72 * lum(tB * 1.9));           // 大尺度斑块
        soil = mix(soil, soil * vec3(0.62, 0.55, 0.46), smoothstep(0.55, 0.95, lum(tB * 2.4)) * 0.55);
        soil = mix(soil, soil * (0.72 + 0.62 * tC.rgb), nearW * 0.55);  // 近处颗粒（保留贴图色相）
        soil *= 0.94 + 0.14 * tA.g;

        // 车辙外侧的泥土略暖、路肩旁略冷（靠植被）
        float verge = smoothstep(4.2, 7.0, abs(p.x)) * (1.0 - smoothstep(9.5, 26.0, abs(p.x)));
        soil = mix(soil, soil * vec3(0.86, 0.94, 0.80), verge * 0.5);

        // ---- 大尺度脏化（中景原来是一片均匀土黄）----
        float mL = fbm(p * 0.0055 + 91.0);                 // ~180 m 的土质分区
        float mM = fbm(p * 0.022  + 51.0);                 // ~45 m 的斑块
        float soilPatch = smoothstep(0.32, 0.78, mL * 0.62 + mM * 0.38);
        soil = mix(soil * vec3(0.86, 0.87, 0.90), soil * vec3(1.10, 1.02, 0.88), soilPatch);
        // 砾石带：只在近处提一点亮度，远处不加（否则中景一片发白、像水面）
        float gravel = smoothstep(0.60, 0.88, fbm(p * 0.13 + 17.0)) * (1.0 - smoothstep(25.0, 90.0, dist));
        soil = mix(soil, soil * vec3(1.16, 1.10, 1.02), gravel * 0.45);
        // 干湿再分一层（大尺度）
        float dryMac = smoothstep(0.45, 0.80, fbm(p * 0.010 + 131.0));
        soil *= mix(0.80, 0.98, dryMac);
        // 中景整体压暗一点，别跟水抢亮度

        // ---- 潮湿：连片水膜压暗 + 局部反光 ----
        float wet = smoothstep(0.42, 0.74, fbm(p * 0.075 + 21.0));
        float puddle = smoothstep(0.62, 0.86, fbm(p * 0.052 + 33.0)) * (1.0 - smoothstep(20.0, 70.0, dist));
        soil *= mix(1.0, 0.52, wet * 0.85 + puddle * 0.5);

        // 苔藓/枯草（只在路肩附近，远处不需要）
        float moss = smoothstep(0.60, 0.86, fbm(p * 0.42 + 7.0)) * (1.0 - smoothstep(8.0, 26.0, dist));
        soil = mix(soil, vec3(0.062, 0.086, 0.034), moss * 0.55);
        float dry = smoothstep(0.66, 0.90, fbm(p * 0.19 + 51.0)) * (1.0 - smoothstep(16.0, 48.0, dist));
        soil = mix(soil, vec3(0.135, 0.118, 0.070), dry * 0.35);

        // ---- 法线：贴图双尺度扰动（世界平面切线基） ----
        vec3 nA = texture2D(tGndNor, uvA).xyz * 2.0 - 1.0;
        vec3 nC = texture2D(tGndNor, uvC).xyz * 2.0 - 1.0;
        vec2 dn = nA.xy * 1.35 + nC.xy * 0.55 * nearW;
        vec3 N = normalize(vec3(dn.x, 1.0, dn.y));

        // ---- 光照 ----
        float diff = max(dot(N, uSunDir), 0.0);
        // 路灯：uLampCol 是按「亮度色」给的（最大 160），这里先归一化再按平方反比衰减，
        // 否则六个灯一叠加就把路面烧成白板（这一版踩过的坑 #2）
        vec3 lamp = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          if (i >= uLampN) break;
          vec3 dl = uLampPos[i] - vW;
          float d2 = dot(dl, dl) + 6.0;
          lamp += (uLampCol[i] / 60.0) * (max(dot(N, normalize(dl)), 0.0) / (d2 * 0.22));
        }
        float ao = mix(0.78, 1.0, smoothstep(0.30, 0.72, fbm(p * 0.9 + 13.0)));
        vec3 col = soil * (uAmb * uAmbI * ao + uSunCol * diff + lamp * 1.15);

        // ---- 湿面镜反：天空 + 路灯 ----
        vec3 V = normalize(uCamPos - vW);
        vec3 Hv = normalize(uSunDir + V);
        float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
        vec3 skyRef = mix(uSkyHor, uSkyTop, clamp(V.y * 1.3 + 0.25, 0.0, 1.0));
        float wetMask = clamp(wet * 0.75 + puddle * 1.1, 0.0, 1.0);
        col = mix(col, skyRef * 0.20, wetMask * (0.03 + fres * 0.18));
        float roughv = texture2D(tGndRough, uvA).r;
        float gloss = mix(260.0, 60.0, roughv);
        float spec = pow(max(dot(N, Hv), 0.0), gloss) * (0.10 + 0.45 * wetMask);
        col += vec3(1.0, 0.90, 0.78) * min(spec * 0.55, 0.28);
        // 路灯光斑（湿地面最出戏的地方）——归一化到 [0,1] 并硬限幅，
        // 六个灯叠加也不会把地面烧成白板
        float lampSpec = 0.0;
        for (int i = 0; i < 6; i++) {
          if (i >= uLampN) break;
          vec3 dl = normalize(uLampPos[i] - vW);
          float s2 = pow(max(dot(N, normalize(dl + V)), 0.0), 90.0);
          lampSpec += (uLampCol[i].r / 160.0) * s2;
        }
        col += vec3(1.0, 0.94, 0.86) * min(lampSpec, 1.0) * wetMask * 0.16;

        float f = 1.0 - exp(-uFogDensity*uFogDensity*dist*dist);
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
        col = min(col, vec3(3.2));                 // 硬护栏：任何项算歪都不会烧成白板
        gl_FragColor = vec4(col, 1.0);
      }`
  }));
  window.__ground = ground;
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;

  scene.add(ground);
  /* ---------- 左侧海面（路面为堤道，梯形护坡下沉到海平面） ---------- */
  const SEA_LEVEL = -14.0;
  const SEA_SHORE_X = -12.0;     // 护坡起点（留出 5 m 路肩）
  const SEA_SLOPE = 1.45;        // 护坡坡度（≈55°）
  const pebbleFragmentPars = `
    vec2 gpuPebbleHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.xx + p3.yz) * p3.zy);
    }
    vec4 gpuPebbleBed(vec2 meter) {
      vec2 grid = meter * 11.0;
      vec2 base = floor(grid), f = fract(grid);
      float nearest = 10.0;
      vec2 chosen = vec2(0.0), chosenId = vec2(0.0);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 offset = vec2(float(i), float(j));
          vec2 id = base + offset;
          vec2 rnd = gpuPebbleHash(id);
          vec2 shape = gpuPebbleHash(id + 7.3);
          vec2 center = offset + 0.06 + rnd * 0.88;
          vec2 delta = f - center;
          float angle = shape.y * 6.2831853;
          float cs = cos(angle), sn = sin(angle);
          delta = mat2(cs, -sn, sn, cs) * delta;
          delta *= mix(vec2(0.82, 1.18), vec2(1.18, 0.82), shape.x);
          float d = length(delta);
          if (d < nearest) { nearest = d; chosen = rnd; chosenId = id; }
        }
      }
      float radius = mix(0.44, 0.65, chosen.x);
      float q = nearest / radius;
      float dome = pow(max(1.0 - q * q, 0.0), 0.48);
      float gap = smoothstep(0.79, 1.05, q);
      float tint = gpuPebbleHash(chosenId + 17.1).x;
      vec3 color = mix(vec3(0.07, 0.085, 0.09), vec3(0.46, 0.43, 0.36), pow(chosen.y, 1.25));
      color = mix(color, color * vec3(0.88, 0.96, 1.08), tint * 0.48);
      color *= (0.76 + tint * 0.46) * (1.0 - gap * 0.25);
      float lod = smoothstep(0.28, 1.0, max(fwidth(grid.x), fwidth(grid.y)));
      color = mix(color, vec3(0.27, 0.29, 0.27), lod);
      return vec4(color, dome * (1.0 - lod));
    }
    vec3 gpuPebbleNormal(vec3 surfPos, vec3 surfNorm, float height, float scale) {
      vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
      vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
      float det = dot(sx, r1);
      vec2 dh = vec2(dFdx(height), dFdy(height)) * scale;
      vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
      return normalize(abs(det) * surfNorm - grad);
    }
  `;
  const pebbleNightU = { value: 0 };
  const pebbleLightsFragment = T.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
     if (UNROLLED_LOOP_INDEX == 0) directLight.color *= 1.0 - uPebbleNight * 0.995;`
  );

  (function makeSea() {
    // 1) 地面几何：左侧下沉成护坡
    const gg = new T.PlaneGeometry(1600, 3000, 120, 160);
    gg.rotateX(-Math.PI / 2);
    gg.translate(800 - 7.0 - 5.0, 0, 0);   // 左边缘落在 x = -12（正好接堤顶，不能再往左铺，否则盖住护坡）
    gg.computeVertexNormals();
    ground.geometry.dispose();
    ground.geometry = gg;
    ground.rotation.x = 0;
    ground.position.y = -0.06;

    // 1.5) 护坡网格（从路肩陡降到海面）：岩石 PBR + 沿坡 UV + 潮湿带
    (function embankment() {
      const Z0 = 140, Z1 = -760, DZ = 5;
      const xTop = -12.0, yTop = 0.05, xBot = -21.6, yBot = -15.0;
      const pos = [], nor = [], idx = [], uvs = [];
      let n = 0;
      const rowPts = [];
      for (let z = Z0; z >= Z1; z -= DZ) {
        const jit = () => (rand() - 0.5) * 0.55;
        const row = [
          [xTop, yTop, z],
          [xBot + jit(), yBot + jit() * 0.5, z + jit() * 0.4],
          [(xTop + xBot) * 0.5 + jit() * 1.2, (yTop + yBot) * 0.5 + jit(), z]
        ];
        rowPts.push(row);
        for (const [px, py, pz] of row) { pos.push(px, py, pz); nor.push(0, 0, 0); }
        uvs.push(z * 0.115, (yTop - yTop) * 0.115, z * 0.115, (yTop - yBot) * 0.115, z * 0.115, (yTop - (yTop + yBot) * 0.5) * 0.115);
        n += 3;
      }
      for (let i = 0; i < n / 3 - 1; i++) {
        const a = i * 3, b = (i + 1) * 3;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
        idx.push(a, b, a + 2, a + 2, b, b + 2);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const u = {
        uTime: { value: 0 }, uNight: { value: 0 }, uWaterY: { value: SEA_LEVEL },
        uSunDir: { value: SUN_DIR }, uSunCol: { value: new T.Color(1, 0.72, 0.5) },
        uAmb: { value: new T.Color(0.26, 0.33, 0.44) }, uSkyTop: { value: new T.Color(0x1b2a4a) },
        uSkyHor: { value: new T.Color(0xff9a52) }, uFogColor: { value: FOG.color },
        uFogDensity: { value: FOG.density }, uCamPos: { value: camera.position }
      };
      const m = new T.ShaderMaterial({
        uniforms: u,
        vertexShader: `
          varying vec3 vW; varying vec2 vUv; varying vec3 vN;
          void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: 'precision highp float;\n' + pebbleFragmentPars + `
          varying vec3 vW; varying vec2 vUv; varying vec3 vN;
          uniform float uTime, uNight, uWaterY, uFogDensity;
          uniform vec3 uSunDir, uSunCol, uAmb, uSkyTop, uSkyHor, uFogColor, uCamPos;
          float hash(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+34.7); return fract(p.x*p.y); }
          float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
            return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
          float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vn(p); p=p*2.05+7.1; a*=0.5;} return s; }
          void main(){
            float dist = length(uCamPos - vW);
            vec4 pebble = gpuPebbleBed(vec2(vW.z, (-vW.x - 12.0) * 1.84));
            vec3 base = pebble.rgb * 0.82;
            vec3 N = gpuPebbleNormal(vW, normalize(vN), pebble.a, 0.035);

            float diff = max(dot(N, uSunDir), 0.0);
            vec3 col = base * (uAmb + uSunCol * diff * 1.15);

            // 潮线：越靠近水面越湿、越暗、越亮反光
            float hAbove = vW.y - uWaterY;
            float wetBand = 1.0 - smoothstep(0.0, 4.5, hAbove);
            float splash = 1.0 - smoothstep(0.0, 1.6, hAbove);
            col *= mix(1.0, 0.46, wetBand);
            col = mix(col, col * vec3(0.72, 0.86, 0.92), wetBand * 0.35);

            vec3 V = normalize(uCamPos - vW);
            vec3 Hv = normalize(uSunDir + V);
            float rough = 0.88 - wetBand * 0.24;
            float spec = pow(max(dot(N, Hv), 0.0), mix(110.0, 42.0, rough)) * (0.08 + wetBand * 0.42);
            col += uSunCol * spec * 0.28;
            vec3 skyRef = mix(uSkyHor, uSkyTop, clamp(V.y * 1.1 + 0.2, 0.0, 1.0));
            col = mix(col, skyRef * 0.6, wetBand * 0.16);

            // 白沫在潮线附近
            float foam = splash * smoothstep(0.45, 0.85, fbm(vW.xz * 0.35 + vec2(uTime * 0.25, 0.0)));
            col = mix(col, vec3(0.72, 0.78, 0.80) * (1.0 - uNight * 0.55), foam * 0.55);

            float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
            col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: T.DoubleSide
      });
      const emb = new T.Mesh(g, m);
      emb.receiveShadow = true; emb.castShadow = false;
      scene.add(emb);
      window.__emb = emb;
      window.__embU = u;

      (function riprap() {
        const bedMat = new T.MeshStandardMaterial({
          color: 0x858983, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.08
        });
        bedMat.onBeforeCompile = sh => {
          sh.uniforms.uPebbleNight = pebbleNightU;
          sh.vertexShader = 'varying vec3 vPebbleWorld;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
            #include <begin_vertex>
            vPebbleWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          `);
          sh.fragmentShader = 'varying vec3 vPebbleWorld;\nuniform float uPebbleNight;\n' + pebbleFragmentPars + sh.fragmentShader
            .replace('#include <lights_fragment_begin>', pebbleLightsFragment)
            .replace('#include <color_fragment>', `
              #include <color_fragment>
              vec4 pebble = gpuPebbleBed(vPebbleWorld.xz);
              float pebbleHeight = pebble.a;
              diffuseColor.rgb *= pebble.rgb;
            `).replace('#include <normal_fragment_maps>', `
              #include <normal_fragment_maps>
              normal = gpuPebbleNormal(-vViewPosition, normal, pebbleHeight, 0.020);
            `).replace('#include <lights_physical_fragment>', `
              #include <lights_physical_fragment>
              material.specularColor = vec3(0.008);
              material.specularF90 = 0.08;
            `).replace('#include <opaque_fragment>', `
              outgoingLight += diffuseColor.rgb * uPebbleNight * vec3(0.48, 0.60, 0.82);
              #include <opaque_fragment>
            `);
        };
        bedMat.customProgramCacheKey = () => 'rainroad-pebble-bed-v1';
        const bed = new T.Mesh(new T.PlaneGeometry(5.9, 900), bedMat);
        bed.rotation.x = -Math.PI / 2;
        bed.position.set(-9.05, -0.047, -310);
        bed.receiveShadow = true;
        scene.add(bed);
        window.__pebbleBed = bed;

        function pebbleGeometry(variant) {
          const geo = new T.IcosahedronGeometry(1, 1);
          const vertices = geo.attributes.position;
          const normals = [];
          const phase = variant * 1.73;
          for (let i = 0; i < vertices.count; i++) {
            const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
            const swell = 1.0 + 0.15 * Math.sin(x * 3.7 + phase + z * 1.9) * Math.cos(y * 2.8 - z * 2.2 + phase)
              + 0.055 * Math.sin(x * 8.1 + y * 5.3 + z * 4.7 + phase);
            const px = x * swell * (1.0 + 0.05 * Math.sin(y * 4.0 + phase));
            const py = Math.max(-0.44, y * swell * (0.72 + variant * 0.035));
            const pz = z * swell * (1.0 + 0.04 * Math.cos(x * 3.4 + phase));
            vertices.setXYZ(i, px, py, pz);
            const n = new T.Vector3(px, py * 1.50, pz).normalize();
            normals.push(n.x, n.y, n.z);
          }
          geo.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
          return geo;
        }

        const mat = new T.MeshStandardMaterial({ color: 0x858983, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.08 });
        mat.onBeforeCompile = sh => {
          sh.uniforms.uPebbleNight = pebbleNightU;
          sh.vertexShader = `
            varying vec3 vRockPos;
            varying vec3 vRockWorld;
            varying float vRockSeed;
          ` + sh.vertexShader.replace('#include <begin_vertex>', `
            #include <begin_vertex>
            vRockPos = position;
            vRockSeed = 0.0;
            vec4 rockWorld = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              rockWorld = instanceMatrix * rockWorld;
              vRockSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
            #endif
            vRockWorld = (modelMatrix * rockWorld).xyz;
          `);
          sh.fragmentShader = `
            varying vec3 vRockPos;
            varying vec3 vRockWorld;
            varying float vRockSeed;
            uniform float uPebbleNight;
          ` + sh.fragmentShader.replace('#include <lights_fragment_begin>', pebbleLightsFragment).replace('#include <color_fragment>', `
            #include <color_fragment>
            vec3 rp = vRockPos * 3.2 + vRockSeed * 5.7;
            float bend = sin(rp.z * 1.7 + rp.x * 0.8) * 0.72 + sin(rp.y * 2.1) * 0.28;
            float seam = abs(sin(rp.x * 1.4 + rp.y * 2.0 + rp.z * 1.1 + bend));
            float vein = 1.0 - smoothstep(0.035, 0.15, seam);
            float grain = fract(sin(dot(floor(vRockPos * 43.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float fleck = smoothstep(0.82, 0.97, grain);
            float wet = 1.0 - smoothstep(-13.2, -9.4, vRockWorld.y);
            float mottle = 0.5 + 0.5 * sin(rp.x * 1.7 + sin(rp.z * 2.2) + rp.y * 0.9);
            float rockAA = 1.0 - smoothstep(0.10, 0.65, max(fwidth(vRockPos.x), fwidth(vRockPos.y)));
            diffuseColor.rgb *= mix(0.90, 0.76 + grain * 0.28, rockAA) * (0.72 + mottle * 0.40) * (1.0 - fleck * 0.34 * rockAA);
            diffuseColor.rgb *= mix(vec3(1.0), vec3(0.56, 0.64, 0.70), vein * 0.48 * rockAA);
            diffuseColor.rgb *= 1.0 - wet * 0.22;
          `).replace('#include <roughnessmap_fragment>', `
            #include <roughnessmap_fragment>
            float rockWet = 1.0 - smoothstep(-13.2, -9.4, vRockWorld.y);
            roughnessFactor = mix(roughnessFactor, 0.66, rockWet * 0.55);
          `).replace('#include <lights_physical_fragment>', `
            #include <lights_physical_fragment>
            material.roughness = max(material.roughness, 0.88);
            material.specularColor = vec3(0.008);
            material.specularF90 = 0.08;
          `).replace('#include <opaque_fragment>', `
            outgoingLight += diffuseColor.rgb * uPebbleNight * vec3(0.48, 0.60, 0.82);
            #include <opaque_fragment>
          `);
        };
        mat.customProgramCacheKey = () => 'rainroad-riprap-v2';
        const count = LOWQ ? 12000 : 42000;
        const group = new T.Group();
        const meshes = [];
        for (let variant = 0; variant < 4; variant++) {
          const perVariant = Math.ceil((count - variant) / 4);
          const mesh = new T.InstancedMesh(pebbleGeometry(variant), mat, perVariant);
          mesh.receiveShadow = true;
          mesh.castShadow = false;
          mesh.frustumCulled = false;
          meshes.push(mesh);
          group.add(mesh);
        }
        const ray = new T.Ray();
        const down = new T.Vector3(0, -1, 0), up = new T.Vector3(0, 1, 0);
        const surface = new T.Vector3(), pos = new T.Vector3(), sc = new T.Vector3(), normal = new T.Vector3();
        const triA = new T.Vector3(), triB = new T.Vector3(), triC = new T.Vector3();
        const edgeA = new T.Vector3(), edgeB = new T.Vector3();
        const q = new T.Quaternion(), qAlign = new T.Quaternion(), qYaw = new T.Quaternion();
        const m = new T.Matrix4(), color = new T.Color();
        const embPos = g.attributes.position.array, embIdx = g.index.array;
        ray.direction.copy(down);
        function locateSlope(x, z) {
          ray.origin.set(x, 2, z);
          const center = clamp(Math.floor((Z0 - z) / DZ), 0, rowPts.length - 2);
          const first = Math.max(0, center - 1), last = Math.min(rowPts.length - 2, center + 1);
          for (let row = first; row <= last; row++) {
            for (let k = row * 12; k < row * 12 + 12; k += 3) {
              let p = embIdx[k] * 3;
              triA.set(embPos[p], embPos[p + 1], embPos[p + 2]);
              p = embIdx[k + 1] * 3;
              triB.set(embPos[p], embPos[p + 1], embPos[p + 2]);
              p = embIdx[k + 2] * 3;
              triC.set(embPos[p], embPos[p + 1], embPos[p + 2]);
              if (!ray.intersectTriangle(triA, triB, triC, false, surface)) continue;
              edgeA.subVectors(triB, triA);
              edgeB.subVectors(triC, triA);
              normal.crossVectors(edgeA, edgeB).normalize();
              if (normal.y < 0) normal.negate();
              return true;
            }
          }
          return false;
        }
        for (let i = 0; i < count; i++) {
          const variant = i % 4, index = Math.floor(i / 4), mesh = meshes[variant];
          const z = 48 - Math.pow(rand(), 2.0) * 456;
          const onTop = rand() < 0.82;
          const shoreBias = Math.pow(rand(), 1.35);
          const x = onTop ? -6.35 - rand() * 5.45 : -12.18 - shoreBias * 8.1;
          if (onTop) {
            surface.set(x, -0.047, z);
            normal.copy(up);
          } else if (!locateSlope(x, z)) {
            m.makeScale(0, 0, 0);
            mesh.setMatrixAt(index, m);
            continue;
          }
          const sizeRoll = rand();
          const radius = sizeRoll < 0.008 ? 0.14 + rand() * 0.06
            : (sizeRoll < 0.19 ? 0.07 + rand() * 0.06 : 0.020 + rand() * 0.055);
          sc.set(radius * (0.72 + rand() * 0.58), radius * (0.38 + rand() * 0.26), radius * (0.75 + rand() * 0.65));
          pos.copy(surface).addScaledVector(normal, sc.y * 0.34);
          qAlign.setFromUnitVectors(up, normal);
          qYaw.setFromAxisAngle(up, rand() * Math.PI * 2);
          q.multiplyQuaternions(qAlign, qYaw);
          m.compose(pos, q, sc);
          mesh.setMatrixAt(index, m);
          color.setHSL(0.07 + rand() * 0.065, 0.025 + rand() * 0.075, 0.05 + Math.pow(rand(), 1.5) * 0.48);
          mesh.setColorAt(index, color);
        }
        for (const mesh of meshes) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.needsUpdate = true;
        }
        scene.add(group);
        window.__embankmentRocks = { group, meshes, count };
      })();
    })();

    // 1.8) 浪花粒子（沿岸抛洒的白沫）——独立 uniforms，别再引用不存在的裁剪变量
    (function spray() {
      const N = 2600;
      const pos = new Float32Array(N * 3), sd = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const z = 130 - rand() * 820;
        const x = -20.6 - rand() * 7.0;
        pos[i * 3] = x;
        pos[i * 3 + 1] = SEA_LEVEL - 0.3;
        pos[i * 3 + 2] = z;
        sd[i * 3] = rand();
        sd[i * 3 + 1] = rand();
        sd[i * 3 + 2] = rand();
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new T.Float32BufferAttribute(sd, 3));
      const sprayU = { uTime: { value: 0 }, uNight: { value: 0 }, uFogColor: { value: FOG.color } };
      const m = new T.ShaderMaterial({
        uniforms: sprayU, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        vertexShader: `
          attribute vec3 aSeed;
          uniform float uTime;
          varying float vA; varying float vY;
          void main(){
            float t = fract(uTime * 0.30 + aSeed.x);
            vec3 p = position;
            p.y += sin(t * 3.14159) * (1.3 + aSeed.y * 3.2);
            p.x += (aSeed.z - 0.5) * 3.4 * t;
            p.z += (aSeed.y - 0.5) * 2.2 * t;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp((210.0 + aSeed.y * 300.0) / max(-mv.z, 1.0), 2.0, 52.0);
            vA = (1.0 - t) * (0.50 + 0.50 * aSeed.z);
            vY = p.y;
          }`,
        fragmentShader: `
          precision highp float;
          varying float vA; varying float vY;
          uniform float uNight;
          uniform vec3 uFogColor;
          void main(){
            vec2 d = gl_PointCoord - 0.5;
            float r = length(d);
            float a = smoothstep(0.5, 0.03, r) * vA;
            vec3 c = mix(vec3(0.92, 0.95, 0.97), uFogColor, clamp(vY * 0.02 + 0.1, 0.0, 0.5));
            gl_FragColor = vec4(c * (1.0 - uNight * 0.55), a * 0.55);
          }`
      });
      const pts = new T.Points(g, m);
      pts.frustumCulled = false;
      scene.add(pts);
      window.__sprayU = sprayU;
    })();

    // 2) 海面网格
    const seaGeo = new T.PlaneGeometry(5200, 5200, 1, 1);
    seaGeo.rotateX(-Math.PI / 2);
    const seaU = {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
      uMoonDir: { value: new T.Vector3(0, 1, 0) },
      uSunColor: { value: new T.Color(1.0, 0.86, 0.66) },
      uSkyTop: { value: new T.Color(0x1b2a4a) },
      uSkyHorizon: { value: new T.Color(0xff9a52) },
      uFogColor: { value: FOG.color },
      uFogDensity: { value: FOG.density },
      uNight: { value: 0 },
      uShoreX: { value: -21.0 },
      uWindDir: { value: new T.Vector2(0.74, 0.67) },
      uChop: { value: 1.0 },
      uReflValid: { value: 0.0 },
      uReflTexel: { value: new T.Vector2(1 / 640, 1 / 360) },
      uRes: { value: new T.Vector2(1280, 720) },
      uDbg: { value: 0.0 },
      tReflect: { value: null },
      tSeaNor: { value: null },
      uTexMatrix: { value: new T.Matrix4() }
    };
    const seaMat = new T.ShaderMaterial({
      uniforms: seaU,
      vertexShader: `
        varying vec3 vW;
        varying vec4 vRefl;
        uniform mat4 uTexMatrix;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vRefl = uTexMatrix * w;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vW;
        varying vec4 vRefl;
        uniform float uTime, uNight, uShoreX, uChop, uReflValid, uDbg, uFogDensity;
        uniform vec3 uSunDir, uMoonDir, uSunColor, uSkyTop, uSkyHorizon, uFogColor;
        uniform vec2 uWindDir, uReflTexel, uRes;
        uniform sampler2D tReflect;
        uniform sampler2D tSeaNor;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { s += noise(p) * a; p = p * 2.03 + 3.7; a *= 0.5; }
          return s;
        }
        vec3 texN(vec2 uv){ return texture2D(tSeaNor, uv).xyz * 2.0 - 1.0; }

        vec3 skyAt(vec3 d, float night) {
          float up = clamp(d.y * 1.15 + 0.06, 0.0, 1.0);
          vec3 c = mix(uSkyHorizon, uSkyTop, pow(up, 0.55));
          c = mix(c, c * 0.32 + uSkyHorizon * 0.10, night * 0.85);
          return c;
        }

        void main() {
          vec2 p = vW.xz;
          vec3 V = normalize(cameraPosition - vW);
          float dist = length(cameraPosition - vW);
          float t = uTime;
          vec2 wd = normalize(uWindDir + vec2(1e-4));

          // ---------- 1. 涌浪：三个方向的正弦脊 + 风致各向异性 ----------
          vec2 d1 = wd;
          vec2 d2 = normalize(wd + vec2(-0.62, 0.78));
          vec2 d3 = normalize(wd + vec2(0.86, -0.51));
          float a1 = dot(p, d1) * 0.135 + t * 0.42;
          float a2 = dot(p, d2) * 0.285 + t * 0.71;
          float a3 = dot(p, d3) * 0.62  + t * 1.15;
          float a4 = dot(p, d1) * 1.35  + t * 1.90;
          float h = sin(a1) * 0.60 + sin(a2) * 0.34 + sin(a3) * 0.16 + sin(a4) * 0.07;
          vec2 gs = d1 * cos(a1) * 0.135 * 0.60
                  + d2 * cos(a2) * 0.285 * 0.34
                  + d3 * cos(a3) * 0.62  * 0.16
                  + d1 * cos(a4) * 1.35  * 0.07;

          // ---------- 2. 细节法线：双尺度滚动贴图 ----------
          float nearF = 1.0 - smoothstep(25.0, 190.0, dist);
          float midF  = 1.0 - smoothstep(150.0, 900.0, dist);
          vec3 n1 = texN(p * 0.085 + wd * (t * 0.045) + vec2(fbm(p * 0.5 + t * 0.05) * 0.02, 0.0));
          vec3 n2 = texN(p * 0.022 - wd * (t * 0.016) + vec2(0.0, fbm(p * 0.3 - t * 0.03) * 0.01));
          vec3 n3 = texN(p * 0.31 + wd * (t * 0.11));
          vec2 dn = gs * (0.42 * uChop)
                  + n2.xy * 0.30 * midF
                  + n1.xy * 0.17 * nearF
                  + n3.xy * 0.075 * nearF * nearF;
          vec3 N = normalize(vec3(dn.x, 1.0, dn.y));

          // ---------- 3. 菲涅尔 / 天空反射 ----------
          float NdV = clamp(dot(N, V), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 skyRef = skyAt(R, uNight);

          // ---------- 4. 平面反射：法线扰动 + 距离模糊 ----------
          vec3 refl = skyRef;
          vec3 reflRaw = skyRef;
          vec2 ndcDbg = vec2(0.0);
          if (uReflValid > 0.5) {
            vec2 suv = gl_FragCoord.xy / uRes;
            // 法线扰动：近处气泡波纹大，远处趋于平静
            float amp = 0.020 / (1.0 + dist * 0.012) + 0.0035;
            suv += N.xz * amp;
            // 单次 mip-LOD 采样：远处（对应粗糙）/掠射角自动变模糊，比固定 5 tap 更接近盐线的做法
            float graz = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
            float lod = clamp(log2(1.0 + dist * 0.30) + graz * 1.2 - 0.4, 0.0, 6.0);
            refl = texture2D(tReflect, suv, lod).rgb;
            reflRaw = refl;
            ndcDbg = suv;
            // 贴地平线时平面反射不可靠（会采到天空的暗带），退回解析天空
            float rh = clamp(R.y, 0.0, 1.0);
            refl = mix(skyRef, refl, smoothstep(0.015, 0.20, rh));
          }

          // ---------- 5. 水体吸收 ----------
          vec3 deep = mix(vec3(0.016, 0.040, 0.058), vec3(0.032, 0.082, 0.088),
                          smoothstep(uShoreX - 90.0, uShoreX + 6.0, p.x));
          deep *= 1.0 - uNight * 0.55;
          float sunUp = clamp(dot(N, uSunDir), 0.0, 1.0);
          vec3 body = deep * (0.22 + 0.55 * sunUp);
          // 逆光透射（浪尖发亮）
          float sss = pow(clamp(dot(V, -normalize(vec3(N.x, 0.35, N.z))), 0.0, 1.0), 4.0);
          body += uSunColor * sss * smoothstep(0.25, 0.85, h) * 0.10 * (1.0 - uNight * 0.7);

          vec3 col = mix(body, refl, clamp(F * 1.08, 0.0, 1.0));

          // ---------- 6. 阳光/月光镜面 ----------
          vec3 Hv = normalize(uSunDir + V);
          float rough = 1.0 - 0.75 * smoothstep(0.4, 0.95, h);
          float sp = pow(max(dot(N, Hv), 0.0), mix(30.0, 1100.0, rough));
          float glitFade = 1.0 - smoothstep(180.0, 1400.0, dist) * 0.75;
          col += uSunColor * sp * 3.4 * glitFade * (1.0 - uNight * 0.65);
          // 月亮高光（夜间）
          vec3 Hm = normalize(uMoonDir + V);
          float spm = pow(max(dot(N, Hm), 0.0), 620.0);
          col += vec3(0.62, 0.70, 0.86) * spm * 1.5 * uNight;

          // ---------- 7. 浪尖泡沫 + 近岸白沫 ----------
          float crest = smoothstep(0.92, 1.18, h + 0.18 * fbm(p * 0.9 + t * 0.4));
          float cMask = crest * (0.25 + 0.75 * nearF);
          col = mix(col, vec3(0.68, 0.74, 0.78) * (1.0 - uNight * 0.55), cMask * 0.28);

          float shDist = abs(p.x - uShoreX - 1.5);
          float shore = exp(-pow(shDist / 4.5, 2.0));
          float sf = fbm(p * vec2(0.9, 0.22) + vec2(t * 0.55, t * 0.10));
          float surf = shore * smoothstep(0.42, 0.92, sf);
          // 拍岸的一波波白线（朝岸推进）
          float band = sin(p.x * 1.35 + t * 1.6 + fbm(p * 0.25) * 2.0);
          surf *= 0.35 + 0.85 * smoothstep(0.45, 0.98, band);
          col = mix(col, vec3(0.70, 0.76, 0.79) * (1.0 - uNight * 0.55), clamp(surf, 0.0, 0.34));

          // ---------- 8. 雨点涟漪 ----------
          float rip = fbm(p * 3.4 + vec2(t * 1.3, -t * 1.1));
          col += vec3(0.030, 0.034, 0.038) * smoothstep(0.70, 0.96, rip) * nearF;

          // ---------- 9. 远处融进雾/地平线 ----------
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist * 1.6);
          col = mix(col, uFogColor * mix(0.75, 1.05, uNight), clamp(fogF, 0.0, 1.0) * 0.92);
          float hz = smoothstep(1200.0, 2600.0, dist);
          col = mix(col, mix(uFogColor, uSkyHorizon, 0.45), hz * 0.85);

          if (uDbg > 4.5 && uDbg < 5.5) col = reflRaw;
          else if (uDbg > 5.5 && uDbg < 6.5) col = vec3(ndcDbg * 0.5 + 0.5, 0.0);
          else if (uDbg > 0.5 && uDbg < 1.5) col = refl;
          else if (uDbg > 1.5 && uDbg < 2.5) col = N * 0.5 + 0.5;
          else if (uDbg > 2.5 && uDbg < 3.5) col = vec3(F);
          else if (uDbg > 3.5) col = vec3(h * 0.5 + 0.5);

          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const sea = new T.Mesh(seaGeo, seaMat);
    sea.position.set(0, SEA_LEVEL, 0);
    sea.renderOrder = 1;
    scene.add(sea);
    window.__seaU = seaU;
    window.__sea = sea;
  })();

  /* ---------- 海面平面反射（Reflector 算法：镜像相机 + 斜裁剪投影） ---------- */
  const reflCam = new T.PerspectiveCamera();
  const _rN = new T.Vector3(0, 1, 0);
  const _rP = new T.Vector3(0, SEA_LEVEL, 0);
  const _rView = new T.Vector3(), _rTarget = new T.Vector3(), _rLookAt = new T.Vector3();
  const _rRot = new T.Matrix4(), _rUp = new T.Vector3();
  const _rPlane = new T.Plane(), _rClip = new T.Vector4(), _rQ = new T.Vector4();
  const _texMat = new T.Matrix4();

  function updateReflection() {
    const cam = camera;
    const cp = cam.position;
    _rView.subVectors(_rP, cp);
    if (_rView.dot(_rN) > 0) return false;          // 相机在水面下，不反射

    _rRot.extractRotation(cam.matrixWorld);
    _rView.reflect(_rN).negate().add(_rP);

    _rLookAt.set(0, 0, -1).applyMatrix4(_rRot).add(cp);
    _rTarget.subVectors(_rP, _rLookAt).reflect(_rN).negate().add(_rP);

    reflCam.position.copy(_rView);
    _rUp.set(0, 1, 0).applyMatrix4(_rRot).reflect(_rN);
    reflCam.up.copy(_rUp);
    reflCam.lookAt(_rTarget);
    reflCam.near = cam.near;
    reflCam.far = cam.far;
    reflCam.updateMatrixWorld();
    reflCam.matrixWorldInverse.copy(reflCam.matrixWorld).invert();
    reflCam.projectionMatrix.copy(cam.projectionMatrix);

    // ★ 先把「未扰动」的投影矩阵烘进纹理矩阵（Reflector 的顺序；反了投影就对不上）
    _texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    _texMat.multiply(reflCam.projectionMatrix);
    _texMat.multiply(reflCam.matrixWorldInverse);

    if (window.__noClip) return true;   // 调试：跳过斜裁剪，检查 RT 里到底有没有内容
    // 斜裁剪近平面（把近平面压到水面上，水下几何天然被裁）
    _rPlane.setFromNormalAndCoplanarPoint(_rN, _rP);
    _rPlane.applyMatrix4(reflCam.matrixWorldInverse);
    _rClip.set(_rPlane.normal.x, _rPlane.normal.y, _rPlane.normal.z, _rPlane.constant);
    const pm = reflCam.projectionMatrix;
    _rQ.x = (Math.sign(_rClip.x) + pm.elements[8]) / pm.elements[0];
    _rQ.y = (Math.sign(_rClip.y) + pm.elements[9]) / pm.elements[5];
    _rQ.z = -1.0;
    _rQ.w = (1.0 + pm.elements[10]) / pm.elements[14];
    const dot = _rClip.x * _rQ.x + _rClip.y * _rQ.y + _rClip.z * _rQ.z + _rClip.w * _rQ.w;
    _rClip.multiplyScalar(2.0 / dot);
    pm.elements[2] = _rClip.x;
    pm.elements[6] = _rClip.y;
    pm.elements[10] = _rClip.z + 1.0;
    pm.elements[14] = _rClip.w;
    return true;
  }
  window.__updateReflection = updateReflection;

  /* ---------- 8. 路面 ---------- */
  function asphaltTextures() {
    const S = 2048;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#3a3b41'; g.fillRect(0, 0, S, S);

    // 粗骨料
    for (let i = 0; i < 55000; i++) {
      const v = 40 + Math.floor(rand() * 105);
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.14 + rand() * 0.55})`;
      const r = 0.6 + rand() * 3.4;
      g.fillRect(rand() * S, rand() * S, r, r);
    }
    // 细砂
    for (let i = 0; i < 55000; i++) {
      const v = 26 + Math.floor(rand() * 70);
      g.fillStyle = `rgba(${v},${v},${v},${0.08 + rand() * 0.28})`;
      g.fillRect(rand() * S, rand() * S, 0.7, 0.7);
    }
    // 裂缝
    for (let i = 0; i < 26; i++) {
      let x = rand() * S, y = rand() * S;
      g.strokeStyle = `rgba(14,14,16,${0.35 + rand() * 0.4})`;
      g.lineWidth = 0.8 + rand() * 1.4;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 26; k++) {
        x += (rand() - 0.5) * 42; y += (rand() - 0.3) * 42;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // 车辙（两条深色带）
    [-0.34, 0.34].forEach(off => {
      const cxp = S * (0.5 + off);
      const gx = g.createLinearGradient(cxp - S * 0.09, 0, cxp + S * 0.09, 0);
      gx.addColorStop(0, 'rgba(0,0,0,0)');
      gx.addColorStop(0.5, 'rgba(0,0,0,0.28)');
      gx.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gx; g.fillRect(0, 0, S, S);
    });
    // 油污斑
    for (let i = 0; i < 40; i++) {
      const x = rand() * S, y = rand() * S, r = 20 + rand() * 90;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(8,8,10,${0.20 + rand() * 0.25})`);
      rg.addColorStop(1, 'rgba(8,8,10,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    const map = new T.CanvasTexture(c);
    map.colorSpace = T.SRGBColorSpace;
    map.wrapS = map.wrapT = T.RepeatWrapping;
    map.repeat.set(2.2, 44);
    map.anisotropy = 16;

    // 法线（Sobel，从同一张高度图）
    const NS = 1024;
    const small = document.createElement('canvas'); small.width = small.height = NS;
    small.getContext('2d').drawImage(c, 0, 0, NS, NS);
    const d = small.getContext('2d').getImageData(0, 0, NS, NS).data;
    const nc = document.createElement('canvas'); nc.width = nc.height = NS;
    const nctx = nc.getContext('2d');
    const img = nctx.createImageData(NS, NS);
    const lum = (x, y) => {
      x = (x + NS) % NS; y = (y + NS) % NS;
      const i = (y * NS + x) * 4;
      return (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    };
    const strength = 4.2;
    for (let y = 0; y < NS; y++) {
      for (let x = 0; x < NS; x++) {
        const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
        const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
        const nx = -dx, ny = -dy, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        const i = (y * NS + x) * 4;
        img.data[i] = (nx / l * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    nctx.putImageData(img, 0, 0);
    const normal = new T.CanvasTexture(nc);
    normal.wrapS = normal.wrapT = T.RepeatWrapping;
    normal.repeat.copy(map.repeat);
    normal.anisotropy = 16;

    // 粗糙度：整体很粗，湿痕处更亮（更光滑）
    const c2 = document.createElement('canvas'); c2.width = c2.height = 1024;
    const g2 = c2.getContext('2d');
    g2.fillStyle = '#dcdcdc'; g2.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 260; i++) {
      const x = rand() * 1024, w = 6 + rand() * 60, a = 0.05 + rand() * 0.22;
      const gx = g2.createLinearGradient(x, 0, x + w, 0);
      gx.addColorStop(0, 'rgba(0,0,0,0)');
      gx.addColorStop(0.5, `rgba(70,70,70,${a})`);
      gx.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = gx; g2.fillRect(x, 0, w, 1024);
    }
    const rough = new T.CanvasTexture(c2);
    rough.wrapS = rough.wrapT = T.RepeatWrapping;
    rough.repeat.set(1.2, 9);
    return { map, normal, rough };
  }

  /* ---------- 内联 PBR 贴图（WebP / JPEG 自适应） ---------- */
  var MAXANISO = 8;
  function b64Tex(id, repeat, srgb, repeatY) {
    if (MAXANISO === 8 && renderer.capabilities.getMaxAnisotropy) {
      MAXANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    }
    const el = document.getElementById(id);
    const t = new T.Texture();
    if (el && el.textContent.trim().length > 100) {
      const b = el.textContent.trim();
      const mime = b.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { t.image = img; t.needsUpdate = true; };
      img.src = 'data:' + mime + ';base64,' + b;
    }
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(repeat, repeatY === undefined ? repeat : repeatY);
    t.anisotropy = MAXANISO;
    if (srgb) t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  const asphalt = asphaltTextures();
  // 地面 PBR 贴图
  (function bindGroundTex() {
    groundU.tGndDiff.value = b64Tex('tex_gnd_diff', 1, true);
    groundU.tGndNor.value = b64Tex('tex_gnd_nor', 1, false);
    groundU.tGndRough.value = b64Tex('tex_gnd_rough', 1, false);
    if (window.__seaU) window.__seaU.tSeaNor.value = b64Tex('tex_water_nor', 1, false);
  })();

  /* ---- 路面：干净的湿沥青（真实 PBR + 水膜清漆） ---- */
  const ROAD_TILE_X = 3.0, ROAD_TILE_Y = 150;
  const roadDiff = b64Tex('tex_road_diff', ROAD_TILE_X, true, ROAD_TILE_Y);
  const roadNor = b64Tex('tex_road_nor', ROAD_TILE_X, false, ROAD_TILE_Y);
  const roadRough = b64Tex('tex_road_rough', ROAD_TILE_X, false, ROAD_TILE_Y);
  const roadMat = new T.MeshPhysicalMaterial({
    map: roadDiff,
    normalMap: roadNor,
    normalScale: new T.Vector2(0.34, 0.34),
    roughnessMap: roadRough, roughness: 0.86, metalness: 0.0,
    color: 0xffffff, envMapIntensity: 0.34,
    specularIntensity: 0.16, specularColor: 0xb9bec6,
    clearcoat: 0.10, clearcoatRoughness: 0.46,
    clearcoatNormalMap: roadNor, clearcoatNormalScale: new T.Vector2(0.08, 0.08)
  });
  // 注意：别在 onBeforeCompile 里强写 material.clearcoat —— 那会把阳光高光放大到 linear 20+，
  // 整条路直接烧白（这一版踩过的坑）。湿感只靠 roughness + 轻微清漆。
  const ROAD_LEN = 460, ROAD_W = 7.6;
  const road = new T.Mesh(new T.PlaneGeometry(ROAD_W, ROAD_LEN, 1, 40), roadMat);
  window.__road = road;
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0, -180);
  road.receiveShadow = true;
  scene.add(road);
  window.__roadMat = roadMat;

  /* ---- 路肩：碎石 + 泥土 + 积水（湿面高光） ---- */
  (function shoulder() {
    const sDiff = b64Tex('tex_gnd_diff', 1.2, true, 190);
    const sNor = b64Tex('tex_gnd_nor', 1.2, false, 190);
    const sRough = b64Tex('tex_gnd_rough', 1.2, false, 190);
    const mat = new T.MeshPhysicalMaterial({
      map: sDiff, normalMap: sNor, normalScale: new T.Vector2(0.9, 0.9),
      roughnessMap: sRough, roughness: 0.95, metalness: 0.0,
      color: 0x9c968a, envMapIntensity: 0.35,
      clearcoat: 0.18, clearcoatRoughness: 0.42
    });
    [-1, 1].forEach(s => {
      const sh = new T.Mesh(new T.PlaneGeometry(1.15, ROAD_LEN), mat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(s * (ROAD_W / 2 + 0.57), 0.004, -180);
      sh.receiveShadow = true;
      scene.add(sh);
    });
    window.__shoulderMat = mat;
  })();
  function lineBox(w, l, x, z, y) {
    const m = new T.Mesh(new T.PlaneGeometry(w, l),
      new T.MeshStandardMaterial({ color: 0xb9b2a0, roughness: 0.78, envMapIntensity: 0.25 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    return m;
  }
  scene.add(lineBox(0.14, ROAD_LEN, -3.42, -180, 0.006));
  scene.add(lineBox(0.14, ROAD_LEN, 3.42, -180, 0.006));
  for (let z = 30; z > -400; z -= 11) scene.add(lineBox(0.13, 4.4, 0, z, 0.006));

  /* ---------- 9. 护栏 ---------- */
  function buildRail(side) {
    const g = new T.Group();
    const x = side * (ROAD_W / 2 + 1.05);
    const H = 0.78;
    const prof = [
      [0.00, 0.155], [0.055, 0.125], [0.055, 0.045], [0.005, 0.0],
      [0.055, -0.045], [0.055, -0.125], [0.00, -0.155]
    ];
    const zStart = road.position.z + ROAD_LEN * 0.5;
    const zEnd = road.position.z - ROAD_LEN * 0.5, step = 2.0;
    const stations = Math.floor((zStart - zEnd) / step) + 1;
    const pos = [], idx = [];
    for (let s = 0; s < stations; s++) {
      const z = zStart - s * step;
      for (let p = 0; p < prof.length; p++) pos.push(x + side * prof[p][0], H + prof[p][1], z);
    }
    for (let s = 0; s < stations - 1; s++) {
      for (let p = 0; p < prof.length - 1; p++) {
        const a = s * prof.length + p, b = a + 1, c = a + prof.length, d = c + 1;
        if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const rail = new T.Mesh(geo, new T.MeshStandardMaterial({
      color: 0x9aa1a5, metalness: 0.32, roughness: 0.72, envMapIntensity: 0.28,
      side: T.DoubleSide
    }));
    rail.castShadow = true; rail.receiveShadow = true;
    g.add(rail);

    const postGeo = new T.BoxGeometry(0.10, 0.95, 0.11);
    const postMat = new T.MeshStandardMaterial({ color: 0x767d81, metalness: 0.3, roughness: 0.78 });
    const count = Math.floor((zStart - zEnd) / 4) + 1;
    const posts = new T.InstancedMesh(postGeo, postMat, count);
    const M = new T.Matrix4();
    for (let i = 0; i < count; i++) {
      M.makeTranslation(x + side * 0.12, 0.42, zStart - i * 4);
      posts.setMatrixAt(i, M);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true; posts.receiveShadow = true;
    g.add(posts);
    return g;
  }
  scene.add(buildRail(-1));
  scene.add(buildRail(1));

  /* ---------- 植被：多物种 + 细叶 + 配色分层 ---------- */
  const windTimeU = { value: 0 };

  function mergeGeos(list) {
    const pos = [], nor = [], uv = [], idx = [], leafSeeds = [];
    let base = 0;
    for (const g of list) {
      const p = g.attributes.position.array, n = g.attributes.normal.array;
      const u = g.attributes.uv ? g.attributes.uv.array : null;
      for (let i = 0; i < p.length; i++) pos.push(p[i]);
      for (let i = 0; i < n.length; i++) nor.push(n[i]);
      if (u) for (let i = 0; i < u.length; i++) uv.push(u[i]);
      const verts = p.length / 3;
      for (let i = 0; i < verts; i++) leafSeeds.push(g.userData.leafSeed || 0);
      if (g.index) {
        const ix = g.index.array;
        for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
      } else {
        for (let i = 0; i < verts; i++) idx.push(base + i);
      }
      base += verts;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    if (uv.length) out.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    out.setAttribute('aLeafSeed', new T.Float32BufferAttribute(leafSeeds, 1));
    out.setIndex(idx);
    return out;
  }

  const FOLIAGE_TYPES = { broad: 0, narrow: 1, needle: 2, fern: 3 };
  const foliageFragmentPars = `
    varying vec2 vLeafUv;
    varying float vLeafSeed;
    float gpuLeafHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    vec2 gpuLeafRot(vec2 p, float a) {
      float c = cos(a), s = sin(a);
      return mat2(c, -s, s, c) * p;
    }
    vec4 gpuFoliage(vec2 uv, float seed, float species) {
      vec2 cells = species < 0.5 ? vec2(30.0, 26.0) :
        (species < 1.5 ? vec2(24.0, 30.0) :
        (species < 2.5 ? vec2(30.0, 36.0) : vec2(20.0, 18.0)));
      vec2 grid = uv * cells;
      vec2 base = floor(grid);
      vec2 p = (uv - 0.5) * 2.0;
      float angle = atan(p.y, p.x);
      float contour = 0.90 + 0.06 * sin(angle * 5.0 + seed * 4.1)
        + 0.03 * sin(angle * 9.0 - seed * 2.3);
      float envelope = 1.0 - smoothstep(contour - 0.32, contour + 0.08, length(p));
      float best = 0.0;
      vec3 color = vec3(1.0);
      float aa = max(fwidth(grid.x), fwidth(grid.y)) * 0.72 + 0.002;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 id = base + vec2(float(i), float(j));
          float r0 = gpuLeafHash(id + seed * 17.13);
          float r1 = gpuLeafHash(id + seed * 31.71 + 7.2);
          float r2 = gpuLeafHash(id + seed * 11.37 + 19.8);
          float r3 = gpuLeafHash(id + seed * 47.77 + 3.1);
          vec2 center = id + vec2(r0, r1);
          vec2 q = grid - center;
          float len = species < 0.5 ? mix(0.82, 1.08, r2) :
            (species < 1.5 ? mix(0.82, 1.10, r2) :
            (species < 2.5 ? mix(0.92, 1.22, r2) : mix(0.78, 1.06, r2)));
          float wid = species < 0.5 ? mix(0.32, 0.42, r3) :
            (species < 1.5 ? mix(0.16, 0.23, r3) :
            (species < 2.5 ? mix(0.09, 0.14, r3) : mix(0.18, 0.25, r3)));
          float a = species < 0.5 ? r2 * 6.2831853 :
            (species < 1.5 ? (r2 - 0.5) * 2.40 + sin(id.y * 0.7) * 0.28 :
            (species < 2.5 ? (r2 - 0.5) * 1.55 :
            (mod(id.y, 2.0) * 2.0 - 1.0) * 1.02 + (r2 - 0.5) * 0.35));
          q = gpuLeafRot(q, a);
          float along = clamp(q.y / len + 0.5, 0.0, 1.0);
          float profile = pow(max(sin(along * 3.1415926), 0.0), 0.72);
          float widthAt = wid * profile * (0.92 - along * 0.12);
          float d = max(abs(q.x) - widthAt, abs(q.y) - len * 0.5);
          vec2 insideMin = step(vec2(0.0), id);
          vec2 insideMax = step(id, cells - 1.0);
          float valid = insideMin.x * insideMin.y * insideMax.x * insideMax.y;
          valid *= step(0.035, r0);
          float leaf = (1.0 - smoothstep(-aa, aa, d)) * valid * envelope;
          if (leaf > best) {
            best = leaf;
            float shade = 0.58 + 0.44 * r3;
            color = vec3(
              shade * (0.86 + along * 0.16),
              shade * (0.96 + r1 * 0.10),
              shade * (0.66 + along * 0.18));
            float mid = (1.0 - smoothstep(0.010, 0.032, abs(q.x)))
              * (1.0 - smoothstep(len * 0.43, len * 0.49, abs(q.y)));
            float lateral = abs(fract(along * 6.0 + abs(q.x) / max(wid, 0.001) * 0.62) - 0.5);
            float veins = mid + (1.0 - smoothstep(0.025, 0.070, lateral)) * 0.24;
            color = mix(color, vec3(1.30, 1.23, 0.78), clamp(veins, 0.0, 1.0) * 0.32);
          }
        }
      }
      return vec4(color, best);
    }
  `;

  function injectFoliageVertex(sh) {
    sh.uniforms.uWindT = windTimeU;
    sh.vertexShader = `
      uniform float uWindT;
      attribute float aLeafSeed;
      varying vec2 vLeafUv;
      varying float vLeafSeed;
    ` + sh.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vLeafUv = uv;
      vLeafSeed = aLeafSeed;
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
        vLeafSeed += fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
        float gust = sin(uWindT * 0.74 + ip.x * 0.11 + ip.z * 0.07) * 0.62
          + sin(uWindT * 1.37 + ip.z * 0.19) * 0.38;
        float height = max(transformed.y - 0.7, 0.0);
        transformed.x += gust * height * 0.030;
        transformed.z += gust * height * 0.015;
        float flutter = sin(uWindT * 5.7 + aLeafSeed * 19.0 + transformed.y * 1.9)
          + sin(uWindT * 8.9 + transformed.x * 2.3 + transformed.z * 1.7);
        transformed.x += flutter * 0.020 * (0.3 + height * 0.08);
        transformed.z += flutter * 0.012 * (0.3 + height * 0.08);
      #endif
    `);
  }

  function cardCanopy(cards, w, h, cy, spread, seg) {
    const list = [];
    for (let i = 0; i < cards.v; i++) {
      const g = new T.PlaneGeometry(w, h, seg, seg);
      g.rotateY((i / cards.v) * Math.PI + (rand() - 0.5) * 0.18);
      g.translate((rand() - 0.5) * spread * 0.35, cy + (rand() - 0.5) * h * 0.10, (rand() - 0.5) * spread * 0.35);
      g.userData.leafSeed = rand();
      list.push(g);
    }
    for (let i = 0; i < cards.t; i++) {
      const g = new T.PlaneGeometry(w * 0.9, h * 0.8, seg, seg);
      g.rotateX(-Math.PI / 2 + 0.3 + rand() * 0.5);
      g.rotateY(rand() * 3.14);
      g.translate((rand() - 0.5) * spread * 0.65, cy + (rand() - 0.5) * h * 0.22, (rand() - 0.5) * spread * 0.65);
      g.userData.leafSeed = rand();
      list.push(g);
    }
    const geo = mergeGeos(list);
    const p = geo.attributes.position.array, n = geo.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i], dy = p[i + 1] - cy, dz = p[i + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      n[i] = dx / l; n[i + 1] = dy / l; n[i + 2] = dz / l;
    }
    return geo;
  }

  const transU = { value: 0.52 };
  const transTintU = { value: new T.Color(1.0, 1.0, 0.72) };
  window.__transU = transU;
  function foliageMaterial(kind, tint) {
    const species = FOLIAGE_TYPES[kind] ?? 0;
    const m = new T.MeshStandardMaterial({
      alphaTest: 0.26, side: T.DoubleSide,
      roughness: 0.74, metalness: 0.0, color: tint || 0xffffff
    });
    m.alphaToCoverage = true;
    m.userData.gpuFoliage = kind;
    m.onBeforeCompile = (sh) => {
      injectFoliageVertex(sh);
      sh.uniforms.uTransAmt = transU;
      sh.uniforms.uTransTint = transTintU;
      sh.uniforms.uLeafSpecies = { value: species };
      sh.fragmentShader = foliageFragmentPars + `
        uniform float uTransAmt;
        uniform vec3 uTransTint;
        uniform float uLeafSpecies;
      ` + sh.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec4 gpuLeaf = gpuFoliage(vLeafUv, vLeafSeed, uLeafSpecies);
        diffuseColor.rgb *= gpuLeaf.rgb;
        diffuseColor.a *= gpuLeaf.a;
      `).replace('#include <lights_fragment_end>', `
        #include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 Vv = normalize(vViewPosition);
          vec3 Lv = directionalLights[0].direction;
          float back = pow(clamp(dot(Vv, -Lv), 0.0, 1.0), 2.6);
          reflectedLight.directDiffuse += diffuseColor.rgb * uTransTint * back * uTransAmt * 0.65;
        }
        #endif
      `);
    };
    m.customProgramCacheKey = () => 'rainroad-gpu-leaf-v2';
    return m;
  }

  function foliageDepthMaterial(kind) {
    const species = FOLIAGE_TYPES[kind] ?? 0;
    const m = new T.MeshDepthMaterial({
      depthPacking: T.RGBADepthPacking, side: T.DoubleSide, alphaTest: 0.26
    });
    m.onBeforeCompile = (sh) => {
      injectFoliageVertex(sh);
      sh.uniforms.uLeafSpecies = { value: species };
      sh.fragmentShader = foliageFragmentPars + `
        uniform float uLeafSpecies;
      ` + sh.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        diffuseColor.a *= gpuFoliage(vLeafUv, vLeafSeed, uLeafSpecies).a;
      `);
    };
    m.customProgramCacheKey = () => 'rainroad-gpu-leaf-depth-v2';
    return m;
  }

  function barkMaterial(color) {
    const m = new T.MeshStandardMaterial({ color: color || 0x4a3829, roughness: 0.94 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = `
        varying vec3 vBarkPos;
        varying float vBarkSeed;
      ` + sh.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vBarkPos = position;
        vBarkSeed = 0.0;
        #ifdef USE_INSTANCING
          vBarkSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #endif
      `);
      sh.fragmentShader = `
        varying vec3 vBarkPos;
        varying float vBarkSeed;
        float gpuBarkHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float gpuBarkNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gpuBarkHash(i), gpuBarkHash(i + vec2(1.0, 0.0)), f.x),
            mix(gpuBarkHash(i + vec2(0.0, 1.0)), gpuBarkHash(i + vec2(1.0)), f.x), f.y);
        }
      ` + sh.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        float barkAngle = atan(vBarkPos.z, vBarkPos.x);
        float broad = gpuBarkNoise(vec2(barkAngle * 2.8 + vBarkSeed * 9.0, vBarkPos.y * 0.72));
        float ridge = 0.5 + 0.5 * sin(barkAngle * 20.0 + broad * 7.0 + vBarkPos.y * 0.85);
        float fissure = gpuBarkNoise(vec2(barkAngle * 8.0 + broad * 2.0, vBarkPos.y * 3.8));
        float groove = pow(0.5 + 0.5 * sin(barkAngle * 32.0 + broad * 9.0 + sin(vBarkPos.y * 0.9) * 2.0), 14.0);
        diffuseColor.rgb *= 0.52 + broad * 0.56 + ridge * 0.20;
        diffuseColor.rgb *= 1.0 - smoothstep(0.64, 0.91, fissure) * 0.44;
        diffuseColor.rgb *= 1.0 - groove * 0.38;
      `).replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (broad - 0.5) * 0.16, 0.72, 1.0);
      `).replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        vec3 barkUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vec3 barkTangent = normalize(cross(barkUp, normal) + vec3(0.00001));
        normal = normalize(normal + barkTangent * (ridge - 0.5) * 0.38);
      `);
    };
    m.customProgramCacheKey = () => 'rainroad-gpu-bark-v1';
    return m;
  }

  function treeTrunk(height, baseRadius, topRadius) {
    const parts = [];
    const trunk = new T.CylinderGeometry(topRadius, baseRadius, height, 24, 14);
    const trunkPos = trunk.attributes.position;
    for (let i = 0; i < trunkPos.count; i++) {
      const x = trunkPos.getX(i), y = trunkPos.getY(i), z = trunkPos.getZ(i);
      const a = Math.atan2(z, x);
      const relief = 1 + Math.sin(a * 11 + y * 2.7) * 0.035 + Math.sin(a * 23 - y * 1.3) * 0.018;
      trunkPos.setXYZ(i, x * relief, y, z * relief);
    }
    trunk.computeVertexNormals();
    trunk.translate(0, height * 0.5, 0);
    parts.push(trunk);
    const up = new T.Vector3(0, 1, 0);
    function limb(a, b, r0, r1) {
      const dir = b.clone().sub(a);
      const geo = new T.CylinderGeometry(r1, r0, dir.length(), 10, 2);
      const q = new T.Quaternion().setFromUnitVectors(up, dir.normalize());
      const m = new T.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new T.Vector3(1, 1, 1));
      geo.applyMatrix4(m);
      parts.push(geo);
    }
    for (let i = 0; i < 6; i++) {
      const a = i * 2.399963;
      const y = height * (0.48 + i * 0.047);
      const reach = height * (0.24 - i * 0.012);
      limb(new T.Vector3(0, y, 0), new T.Vector3(Math.cos(a) * reach, y + height * 0.22, Math.sin(a) * reach),
        baseRadius * 0.48, topRadius * 0.25);
    }
    return mergeGeos(parts);
  }

  // 配色分层：近处深绿、中景黄绿、远处偏蓝灰
  function layerTint(z, base) {
    const t = clamp((-z - 20) / 160, 0, 1);              // 0 近 → 1 远
    const c = new T.Color(base);
    const far = new T.Color(0x4a5a52);
    return c.lerp(far, t * 0.55);
  }

  window.__gpuVegetation = { windTimeU, trees: [] };
  function scatterSpecies(opt) {
    const { geoCanopy, geoTrunk, kind, count: countIn, offMin, offMax, scaleMin, scaleMax,
      tint, trunkColor, castShadow = true, row = 0 } = opt;
    const count = Math.max(6, Math.round(countIn * VEG));
    const trunkMat = barkMaterial(trunkColor);
    const canMat = foliageMaterial(kind, 0xffffff);
    const trunks = geoTrunk ? new T.InstancedMesh(geoTrunk, trunkMat, count) : null;
    const canopies = new T.InstancedMesh(geoCanopy, canMat, count);
    canopies.customDepthMaterial = foliageDepthMaterial(kind);
    const M = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), sc = new T.Vector3(), pos = new T.Vector3();
    const tmpCol = new T.Color();
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const z = row ? 42 - (row - 1) * 3.5 - i * (442 / Math.max(1, count - 1)) + (rand() - 0.5) * 1.1
        : 46 - t * 420 - rand() * 10;
      const side = row ? 1 : ((i % 2 === 0) ? -1 : 1);
      const off = offMin + rand() * (offMax - offMin);
      const s = scaleMin + rand() * (scaleMax - scaleMin);
      e.set(0, rand() * 6.283, 0);
      q.setFromEuler(e);
      sc.set(s, s * (0.9 + rand() * 0.35), s);
      pos.set(side * off, -0.05, z);
      if (pos.x < 6.0) sc.set(0.0001, 0.0001, 0.0001);   // 左半侧是海，全部清除
      const pdx = pos.x - 65, pdz = pos.z + 168;
      if (pdx * pdx + pdz * pdz < 118 * 118) sc.set(0.0001, 0.0001, 0.0001);   // 发射场禁止植被
      M.compose(pos, q, sc);
      if (trunks) trunks.setMatrixAt(i, M);
      canopies.setMatrixAt(i, M);
      // 颜色：物种色 × 距离分层 × 随机明度
      tmpCol.copy(layerTint(z, tint));
      const g0 = 0.62 + rand() * 0.5;
      tmpCol.multiplyScalar(g0);
      tmpCol.g *= 1.0 + (rand() - 0.5) * 0.12;
      canopies.setColorAt(i, tmpCol);
    }
    if (trunks) {
      trunks.castShadow = castShadow; trunks.receiveShadow = true;
      trunks.frustumCulled = false;
      scene.add(trunks);
    }
    canopies.castShadow = castShadow; canopies.receiveShadow = true;
    canopies.frustumCulled = false;
    scene.add(canopies);
    window.__gpuVegetation.trees.push({ kind, canopies, trunks });
    return canopies;
  }

  // A 阔叶树
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 6, t: 4 }, 5.2, 4.8, 5.2, 1.2, 5),
    geoTrunk: treeTrunk(6.4, 0.29, 0.11),
    kind: 'broad', count: LOWQ ? 22 : 52, offMin: 10.5, offMax: 12.0, scaleMin: 0.90, scaleMax: 1.28,
    tint: 0x7c945d, row: 1
  });
  // B 高瘦树
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 5, t: 3 }, 3.4, 6.2, 6.2, 0.7, 5),
    geoTrunk: treeTrunk(7.8, 0.23, 0.095),
    kind: 'narrow', count: LOWQ ? 16 : 34, offMin: 18.0, offMax: 20.0, scaleMin: 0.85, scaleMax: 1.22,
    tint: 0x71895b, row: 2
  });
  // C 针叶树
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 5, t: 3 }, 3.0, 6.8, 4.6, 0.5, 5),
    geoTrunk: treeTrunk(5.6, 0.25, 0.10),
    kind: 'needle', count: LOWQ ? 12 : 26, offMin: 27.0, offMax: 30.0, scaleMin: 0.90, scaleMax: 1.25,
    tint: 0x4f6a52, row: 3
  });
  // D 蕨类灌木
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 4, t: 3 }, 3.2, 2.4, 1.4, 0.6, 4),
    geoTrunk: null,
    kind: 'fern', count: LOWQ ? 90 : 340, offMin: 6.2, offMax: 42, scaleMin: 0.6, scaleMax: 1.3,
    tint: 0x6f8a52, castShadow: false
  });
  // E 干枝灌木
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 4, t: 2 }, 2.6, 2.0, 1.2, 0.5, 4),
    geoTrunk: null,
    kind: 'broad', count: LOWQ ? 60 : 260, offMin: 8, offMax: 55, scaleMin: 0.5, scaleMax: 1.1,
    tint: 0x6b7a4a, castShadow: false
  });
  // F 外延田野灌木（远、低、暗）
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 3, t: 2 }, 4.0, 2.8, 1.0, 0.5, 3),
    geoTrunk: null,
    kind: 'broad', count: LOWQ ? 180 : 620, offMin: 24, offMax: 165, scaleMin: 0.55, scaleMax: 1.3,
    tint: 0x56673f, castShadow: false
  });
  // G 远处林线（压住地平线，制造纵深）
  scatterSpecies({
    geoCanopy: cardCanopy({ v: 3, t: 2 }, 6.0, 7.0, 6.0, 0.4, 3),
    geoTrunk: null,
    kind: 'broad', count: LOWQ ? 26 : 74, offMin: 70, offMax: 175, scaleMin: 1.0, scaleMax: 1.8,
    tint: 0x445243, castShadow: false
  });

  /* ---------- 火箭发射场（长征五号 + 文昌式脐带塔，10 倍尺度） ---------- */
  (function launchSite() {
    const PAD_X = 65, PAD_Z = -168;
    const SCALE = 1.0;          // 真实尺寸：长征五号 57 m

    function mergeAll(list) {
      const pos = [], nor = [], uv = [], idx = [];
      let base = 0;
      for (const g of list) {
        const p = g.attributes.position.array, n = g.attributes.normal.array;
        const u = g.attributes.uv ? g.attributes.uv.array : null;
        for (let i = 0; i < p.length; i++) pos.push(p[i]);
        for (let i = 0; i < n.length; i++) nor.push(n[i]);
        if (u) for (let i = 0; i < u.length; i++) uv.push(u[i]);
        const verts = p.length / 3;
        if (g.index) { const ix = g.index.array; for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base); }
        else { for (let i = 0; i < verts; i++) idx.push(base + i); }
        base += verts;
      }
      const out = new T.BufferGeometry();
      out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
      if (uv.length) out.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      out.setIndex(idx);
      return out;
    }

    const _up = new T.Vector3(0, 1, 0), _dir = new T.Vector3(), _q = new T.Quaternion(), _m = new T.Matrix4();
    function bar(a, b, w, h) {
      _dir.subVectors(b, a);
      const len = _dir.length();
      if (len < 1e-4) return new T.BoxGeometry(w, 0.001, h);
      const g = new T.BoxGeometry(w, len, h);
      _q.setFromUnitVectors(_up, _dir.clone().normalize());
      _m.compose(a.clone().add(b).multiplyScalar(0.5), _q, new T.Vector3(1, 1, 1));
      g.applyMatrix4(_m);
      return g;
    }
    const boxAt = (x, y, z, sx, sy, sz) => { const g = new T.BoxGeometry(sx, sy, sz); g.translate(x, y, z); return g; };
    const cylAt = (x, y, z, r1, r2, h, seg) => { const g = new T.CylinderGeometry(r1, r2, h, seg || 20); g.translate(x, y, z); return g; };
    const ringAt = (y, r, h, seg) => cylAt(0, y, 0, r, r, h, seg || 32);

    /* ---- 发射场专用程序化 PBR：所有表面都经过自定义 GLSL，而非默认材质 ---- */
    function applyPadShader(mat, cfg) {
      mat.userData.padShader = cfg;
      mat.onBeforeCompile = shader => {
        shader.uniforms.uPadKind = { value: cfg.kind };
        shader.uniforms.uPadScale = { value: cfg.scale };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vPadPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPadPos = position;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
            varying vec3 vPadPos;
            uniform float uPadKind;
            uniform float uPadScale;
            float padHash(vec3 p) {
              return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            }
          `)
          .replace('#include <color_fragment>', `#include <color_fragment>
            vec3 padCell = floor(vPadPos * uPadScale);
            float padGrain = padHash(padCell);
            float padBroad = 0.5 + 0.5 * sin(vPadPos.y * 0.19 + sin(vPadPos.x * 0.31) + vPadPos.z * 0.13);
            float padBrush = 0.5 + 0.5 * sin((vPadPos.y + vPadPos.x * 0.07) * uPadScale * 5.0);
            float padTone = 0.94 + padGrain * 0.10;
            if (uPadKind < 0.5) {
              padTone = 0.82 + padGrain * 0.15 + padBroad * 0.10;
            } else if (uPadKind < 1.5) {
              padTone = 0.91 + padGrain * 0.075 + padBroad * 0.055;
            } else if (uPadKind < 2.5) {
              padTone = 0.86 + padGrain * 0.08 + padBrush * 0.13;
            } else if (uPadKind < 3.5) {
              float padStreak = pow(0.5 + 0.5 * sin(atan(vPadPos.z, vPadPos.x) * 31.0), 12.0);
              padTone = 0.975 + padGrain * 0.035 - padStreak * 0.018 + padBroad * 0.012;
            } else if (uPadKind < 4.5) {
              padTone = 0.86 + padGrain * 0.12 + padBroad * 0.09;
            }
            diffuseColor.rgb *= padTone;
          `)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
            roughnessFactor = clamp(roughnessFactor * (0.91 + padGrain * 0.17 + padBrush * 0.035), 0.08, 1.0);
          `);
      };
      mat.customProgramCacheKey = () => 'rainroad-pad-v2';
    }
    function industrial(color, roughness, metalness, kind, scale, extra) {
      const mat = new T.MeshStandardMaterial(Object.assign({ color, roughness, metalness }, extra || {}));
      applyPadShader(mat, { kind, scale });
      return mat;
    }
    function cloneIndustrial(mat) {
      const copy = mat.clone();
      if (mat.userData.padShader) applyPadShader(copy, mat.userData.padShader);
      return copy;
    }
    function luminous(color, energy) {
      return new T.ShaderMaterial({
        uniforms: { uLampColor: { value: new T.Color(color) }, uLampEnergy: { value: energy }, uLampOpacity: { value: 1 } },
        vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 uLampColor; uniform float uLampEnergy; uniform float uLampOpacity;
          void main(){
            gl_FragColor = vec4(uLampColor * uLampEnergy, uLampOpacity);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`
      });
    }

    const M = {
      concrete: industrial(0x8d908c, 0.94, 0.03, 0, 3.2),
      concreteDark: industrial(0x555b5d, 0.92, 0.08, 0, 4.6),
      steel: industrial(0x8796a0, 0.66, 0.62, 2, 8.0),
      steelDark: industrial(0x303c46, 0.58, 0.78, 2, 9.0),
      steelLight: industrial(0xa8b4b8, 0.48, 0.72, 2, 11.0),
      body: industrial(0xf0f1ed, 0.58, 0.08, 3, 18.0),
      boost: industrial(0xe8ebe8, 0.62, 0.07, 3, 16.0),
      dark: industrial(0x1b2229, 0.46, 0.62, 2, 12.0),
      red: industrial(0xb4232b, 0.52, 0.18, 4, 9.0),
      nozzle: industrial(0x292d33, 0.36, 0.90, 2, 15.0, { side: T.DoubleSide }),
      orange: industrial(0xd76a1b, 0.54, 0.46, 4, 8.0),
      blue: industrial(0x426b88, 0.57, 0.52, 1, 7.0),
      back: industrial(0x899da7, 0.69, 0.38, 1, 5.5),
      hinge: industrial(0x3e4a52, 0.38, 0.86, 2, 13.0),
      safety: industrial(0xd5b638, 0.55, 0.38, 4, 10.0),
      glass: industrial(0x243c4c, 0.22, 0.58, 2, 4.0, { emissive: 0x161b1d, emissiveIntensity: 0.45 }),
      lamp: luminous(0xffe6b0, 1.35),
      deckGlow: luminous(0xc9a86e, 0.85)
    };

    function pbrTex(id, srgb, rep) {
      const el = document.getElementById(id);
      const t = new T.Texture();
      if (el && el.textContent.trim().length > 100) {
        const img = new Image();
        img.onload = () => { t.image = img; t.needsUpdate = true; };
        img.src = 'data:image/jpeg;base64,' + el.textContent.trim();
      }
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(rep, rep);
      t.anisotropy = 4;
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      return t;
    }
    const metD = pbrTex('tex_met_diff', true, 2), metN = pbrTex('tex_met_nor', false, 2), metR = pbrTex('tex_met_rough', false, 2);
    const pntD = pbrTex('tex_pnt_diff', true, 3), pntN = pbrTex('tex_pnt_nor', false, 3), pntR = pbrTex('tex_pnt_rough', false, 3);
    M.body.normalMap = pntN; M.body.roughnessMap = pntR;
    M.boost.normalMap = pntN; M.boost.roughnessMap = pntR;
    M.steel.map = metD; M.steel.normalMap = metN; M.steel.roughnessMap = metR;
    M.steelDark.map = metD; M.steelDark.normalMap = metN; M.steelDark.roughnessMap = metR;

    /* ---- 贴图：国旗 + 中国航天 ---- */
    function flagTexture() {
      const W = 360, H = 240;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#de2910'; g.fillRect(0, 0, W, H);
      const star = (cx, cy, r, rot) => {
        g.beginPath();
        for (let i = 0; i < 5; i++) {
          const a1 = rot + i * Math.PI * 2 / 5 - Math.PI / 2, a2 = a1 + Math.PI / 5;
          g.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
          g.lineTo(cx + Math.cos(a2) * r * 0.382, cy + Math.sin(a2) * r * 0.382);
        }
        g.closePath(); g.fillStyle = '#ffde00'; g.fill();
      };
      star(W * 0.17, H * 0.30, H * 0.15, 0);
      for (const [sx, sy] of [[0.33, 0.10], [0.40, 0.20], [0.40, 0.34], [0.33, 0.44]]) {
        star(W * sx, H * sy, H * 0.05, 0.35);
      }
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    }
    function textTexture(txt) {
      const W = 512, H = 128;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#c8102e';
      g.font = 'bold 82px "Microsoft YaHei", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, W / 2, H / 2 + 4);
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    }

    function flagCHN() {
      const W = 300, H = 300;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#de2910'; g.fillRect(60, 20, 180, 120);
      const star = (cx, cy, r, rot) => {
        g.beginPath();
        for (let i = 0; i < 5; i++) {
          const a1 = rot + i * Math.PI * 2 / 5 - Math.PI / 2, a2 = a1 + Math.PI / 5;
          g.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
          g.lineTo(cx + Math.cos(a2) * r * 0.382, cy + Math.sin(a2) * r * 0.382);
        }
        g.closePath(); g.fillStyle = '#ffde00'; g.fill();
      };
      star(60 + 180 * 0.17, 20 + 120 * 0.30, 120 * 0.15, 0);
      for (const [sx, sy] of [[0.33, 0.10], [0.40, 0.20], [0.40, 0.34], [0.33, 0.44]]) {
        star(60 + 180 * sx, 20 + 120 * sy, 120 * 0.05, 0.35);
      }
      g.fillStyle = '#1a1a1a';
      g.font = 'bold 54px sans-serif'; g.textAlign = 'center';
      g.fillText('CHN', W / 2, 230);
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    }
    function cascText() {
      const W = 260, H = 620;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      // CASC 圆标
      g.strokeStyle = '#1a4f9c'; g.lineWidth = 7;
      g.beginPath(); g.arc(W / 2, 90, 56, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#1a4f9c'; g.font = 'bold 46px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('CASC', W / 2, 90);
      // 中国航天 竖排
      g.fillStyle = '#1a1a1a'; g.font = 'bold 92px "Microsoft YaHei", sans-serif';
      const txt = '中国航天';
      for (let i = 0; i < txt.length; i++) g.fillText(txt[i], W / 2, 230 + i * 100);
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    }

    const parts = [];
    const add = (geo, mat) => parts.push({ geo, mat });

    /* ================= 发射区 ================= */
    add(boxAt(0, 0.9, 0, 15, 1.8, 13), M.concrete);
    add(boxAt(0, 0.35, 0, 12, 0.7, 10.5), M.concreteDark);
    // 导流槽
    for (const sgn of [-1, 1]) {
      const g = new T.BoxGeometry(3.2, 0.7, 9);
      g.rotateZ(sgn * 0.5); g.translate(sgn * 2.4, 0.9, 0);
      add(g, M.concreteDark);
    }
    add(boxAt(0, 1.9, 0, 5.6, 0.4, 6.4), M.steelDark);          // 台面
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(cylAt(sx * 2.0, 1.5, sz * 2.4, 0.13, 0.16, 2.2, 10), M.steelDark);
    }
    // 喷水环
    add(ringAt(2.2, 3.4, 0.16, 32), M.steelLight);

    /* ================= 发射工位：移动平台 + 背塔 + 两侧摆杆塔 ================= */
    const TH = 100.0;             // 塔高
    const PADTOP = 8.0;           // 移动发射平台顶面高度

    /* ---- 1) 底部大型移动发射平台（灰色箱体）---- */
    const baseParts = [];
    baseParts.push(boxAt(0, 4.0, 0, 34, 8.0, 26));                    // 主箱体
    baseParts.push(boxAt(0, 8.4, 0, 30, 0.8, 22));                    // 台面
    // 侧面桁架加强
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const x = -14 + i * 7;
        baseParts.push(boxAt(x, 4.0, sz * 13.2, 1.2, 7.6, 0.7));
      }
      baseParts.push(boxAt(0, 7.4, sz * 13.2, 30, 0.7, 0.7));
      baseParts.push(boxAt(0, 1.2, sz * 13.2, 30, 0.7, 0.7));
    }
    // 底部台车（履带式）
    for (const sz of [-1, 1]) {
      baseParts.push(boxAt(0, 0.9, sz * 9.0, 36, 1.8, 5.0));
    }
    add(mergeAll(baseParts), M.concreteDark);

    // 平台上的橙色设备箱
    const eqParts = [];
    for (const sx of [-1, 1]) {
      eqParts.push(boxAt(sx * 13, 9.6, 6.5, 5.0, 2.4, 4.0));
      eqParts.push(boxAt(sx * 13, 9.6, -6.5, 5.0, 2.4, 4.0));
    }
    eqParts.push(boxAt(0, 9.6, 11.0, 8.0, 2.2, 2.6));
    add(mergeAll(eqParts), M.orange);

    /* ---- 2) 火箭背后的固定服务塔（灰色多层建筑）---- */
    const backParts = [];
    const BW = 15.0, BD = 8.0, BZ = -12.0;   // 宽 / 深 / 中心 z
    // 四角立柱
    for (const sx of [-1, 1]) for (const dz of [-1, 1]) {
      backParts.push(boxAt(sx * BW, 4 + TH * 0.5, BZ + dz * BD, 2.0, TH, 2.0));
    }
    // 每层楼板 + 外墙板（带开口感：交替深浅）
    // 背面 + 两侧连续外墙；正面只留窗台，露出内部
    // 背面/两侧：不砌实墙，改成立柱 + 横梁的开放桁架（照片里是通透钢结构）
    for (let i = -5; i <= 5; i++) {
      backParts.push(boxAt(i * 2.9, 4 + TH * 0.5, BZ - BD + 0.5, 0.34, TH, 0.34));   // 背立柱
    }
    for (let i = -1; i <= 1; i++) {
      for (const sgn of [-1, 1]) {
        backParts.push(boxAt(sgn * (BW - 0.5), 4 + TH * 0.5, BZ + i * BD, 0.34, TH, 0.34));  // 侧立柱
      }
    }
    for (let lv = 0; lv <= 12; lv++) {
      const y = 8 + lv * (TH - 8) / 12;
      backParts.push(boxAt(0, y - 0.35, BZ - BD + 0.5, BW * 2, 0.28, 0.28));        // 背横梁
      for (const sgn of [-1, 1]) backParts.push(boxAt(sgn * (BW - 0.5), y - 0.35, BZ, 0.28, BD * 2, 0.28));
      // 斜撑
      if (lv < 12) {
        const y2 = 8 + (lv + 1) * (TH - 8) / 12;
        for (const sgn of [-1, 1]) {
          backParts.push(bar(new T.Vector3(sgn * (BW - 0.5), y, BZ - BD + 0.5), new T.Vector3(sgn * (BW - 0.5), y2, BZ + BD - 0.5), 0.16, 0.16));
        }
      }
    }
    for (let lv = 0; lv <= 10; lv++) {
      const y = 8 + lv * (TH - 8) / 10;
      backParts.push(boxAt(0, y, BZ, BW * 2, 0.8, BD * 2));
      backParts.push(boxAt(0, y + 0.9, BZ + BD - 0.6, BW * 2, 1.0, 0.6));
      backParts.push(boxAt(-BW * 0.45, y + 2.4, BZ + 2.0, 0.5, 4.8, 0.5));
      backParts.push(boxAt(BW * 0.45, y + 2.4, BZ + 2.0, 0.5, 4.8, 0.5));
    }
    // 内部：楼层栏杆 + 设备柜 + 斜梯
    for (let lv = 0; lv <= 10; lv++) {
      const y = 8 + lv * (TH - 8) / 10;
      backParts.push(boxAt(0, y + 1.85, BZ + BD - 1.1, BW * 1.9, 0.12, 0.12));
      for (let k = -4; k <= 4; k++) backParts.push(cylAt(k * 3.2, y + 0.9, BZ + BD - 1.1, 0.07, 0.07, 1.9, 5));
      backParts.push(boxAt(-BW + 1.6, y + 1.85, BZ, 0.12, 0.12, BD * 1.6));
      backParts.push(boxAt(BW - 1.6, y + 1.85, BZ, 0.12, 0.12, BD * 1.6));
      backParts.push(boxAt(-BW * 0.55, y + 2.2, BZ - BD * 0.45, 4.0, 3.6, 2.2));
      backParts.push(boxAt(BW * 0.55, y + 1.9, BZ - BD * 0.45, 3.4, 3.0, 2.2));
      if (lv < 10) {
        backParts.push(bar(new T.Vector3(BW * 0.2, y + 0.4, BZ + 1.0),
                           new T.Vector3(BW * 0.2, y + (TH - 8) / 10 - 0.4, BZ - 2.0), 0.5, 1.4));
      }
    }
    for (let lv = 0; lv <= 10; lv++) {
      const y = 8 + lv * (TH - 8) / 10;
      backParts.push(boxAt(0, y + 3.2, BZ + BD - 0.1, BW * 1.7, 1.1, 0.25));
    }
    // 开放式中央竖井：导轨、立柱与检修平台，不再是一整块实心灰墙
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      backParts.push(boxAt(sx * 3.0, 4 + TH * 0.5, BZ + BD * 0.2 + sz * 2.0, 0.48, TH, 0.48));
    }
    for (const sx of [-1, 1]) {
      backParts.push(boxAt(sx * 2.1, 4 + TH * 0.5, BZ + BD * 0.2 - 1.7, 0.18, TH, 0.18));
    }
    for (let i = -3; i <= 3; i++) {
      backParts.push(boxAt(i * 4.2, 4 + TH * 0.5, BZ + BD - 0.9, 0.55, TH, 0.55));
    }
    add(mergeAll(backParts), M.back);
    const winParts = [];
    for (let lv = 0; lv <= 10; lv++) {
      const y = 8 + lv * (TH - 8) / 10;
      winParts.push(boxAt(0, y + 3.2, BZ + BD - 0.05, BW * 1.7, 1.1, 0.22));
    }
    add(mergeAll(winParts), M.glass);

    /* ---- 3) 两侧回转服务塔：桁架、检修臂、回转支承与液压驱动 ---- */
    const armPivots = [];
    const actuators = [];
    const mechanisms = new T.Group();
    mechanisms.name = 'tower-actuators';
    function actuatorMesh(r, mat) {
      const geo = new T.CylinderGeometry(r, r, 1, 12);
      geo.translate(0, 0.5, 0);
      const mesh = new T.Mesh(geo, mat);
      mesh.castShadow = true;
      mechanisms.add(mesh);
      return mesh;
    }
    function addActuator(pivot, sgn, y) {
      const fixed = new T.Vector3(pivot.position.x + sgn * 5.2, y, pivot.position.z + 6.8);
      const moving = new T.Vector3(-sgn * 2.7, y, 5.0);
      const barrel = actuatorMesh(0.34, M.orange);
      const rod = actuatorMesh(0.15, M.steelLight);
      const eyeA = new T.Mesh(new T.SphereGeometry(0.52, 12, 8), M.hinge);
      const eyeB = eyeA.clone();
      eyeA.position.copy(fixed); mechanisms.add(eyeA, eyeB);
      actuators.push({ pivot, fixed, moving, barrel, rod, eyeB });
    }
    for (const sgn of [-1, 1]) {
      const cx = sgn * 19.0;
      const hz = -5.5;
      const pivot = new T.Group();
      pivot.position.set(cx, 0, hz);
      const bp = [], orangeBp = [], darkBp = [], glowBp = [];
      const place = (list, g) => { g.translate(-cx, 0, -hz); list.push(g); return g; };
      const P = g => place(bp, g), PO = g => place(orangeBp, g), PD = g => place(darkBp, g), PG = g => place(glowBp, g);
      for (const dz of [-5, 5]) for (const dx of [-3.4, 3.4]) {
        P(boxAt(cx + dx, 4 + TH * 0.5, dz, 1.05, TH, 1.05));
        PD(boxAt(cx + dx, 7.0, dz, 1.65, 5.2, 1.65));
      }
      for (let lv = 0; lv <= 12; lv++) {
        const y = 8 + lv * (TH - 8) / 12;
        P(boxAt(cx, y, 0, 7.8, 0.24, 10.8));
        for (const z of [-5.35, 5.35]) {
          P(boxAt(cx, y + 1.55, z, 7.8, 0.12, 0.12));
          P(boxAt(cx, y + 0.82, z, 7.8, 0.08, 0.08));
          for (const dx of [-3.55, 0, 3.55]) P(boxAt(cx + dx, y + 0.8, z, 0.10, 1.6, 0.10));
        }
        for (const dx of [-3.45, 3.45]) {
          PD(boxAt(cx + dx, y + 0.32, 5.05, 0.72, 0.64, 0.12));
          for (const bx of [-0.22, 0.22]) PD(cylAt(cx + dx + bx, y + 0.32, 5.14, 0.075, 0.075, 0.10, 6));
        }
        PG(boxAt(cx, y + 0.20, 5.12, 5.8, 0.08, 0.12));
        if (lv < 12) {
          const y2 = 8 + (lv + 1) * (TH - 8) / 12;
          for (const z of [-5, 5]) {
            P(bar(new T.Vector3(cx - 3.4, y, z), new T.Vector3(cx + 3.4, y2, z), 0.22, 0.22));
            P(bar(new T.Vector3(cx + 3.4, y, z), new T.Vector3(cx - 3.4, y2, z), 0.22, 0.22));
          }
          for (const dx of [-3.4, 3.4]) {
            P(bar(new T.Vector3(cx + dx, y, -5), new T.Vector3(cx + dx, y2, 5), 0.18, 0.18));
            P(bar(new T.Vector3(cx + dx, y, 5), new T.Vector3(cx + dx, y2, -5), 0.18, 0.18));
          }
        }
      }
      // 五层伸缩检修臂：橙色格栅台面、蓝色三角桁架、深色接触垫
      for (let i = 0; i < 5; i++) {
        const y = 20 + i * 16;
        P(boxAt(sgn * 10.8, y - 0.12, 0, 13.0, 0.30, 4.8));
        PO(boxAt(sgn * 10.8, y + 0.08, 0, 12.5, 0.10, 4.35));
        PD(boxAt(sgn * 4.15, y + 0.10, 0, 0.65, 1.15, 3.4));
        for (const z of [-2.35, 2.35]) {
          P(boxAt(sgn * 10.8, y + 1.55, z, 13.0, 0.16, 0.16));
          P(boxAt(sgn * 10.8, y + 0.20, z, 13.0, 0.18, 0.18));
          for (let j = 0; j < 4; j++) {
            const x0 = sgn * (4.5 + j * 3.15), x1 = sgn * (4.5 + (j + 1) * 3.15);
            P(boxAt(x0, y + 0.85, z, 0.13, 1.55, 0.13));
            P(bar(new T.Vector3(x0, y + 0.22, z), new T.Vector3(x1, y + 1.52, z), 0.14, 0.14));
            P(bar(new T.Vector3(x0, y + 1.52, z), new T.Vector3(x1, y + 0.22, z), 0.14, 0.14));
          }
        }
        for (let j = 0; j < 11; j++) PO(boxAt(sgn * (4.9 + j * 1.16), y + 0.16, 0, 0.07, 0.05, 4.2));
      }
      // 随塔运动的脐带管线、卡箍和检修灯
      for (let k = 0; k < 3; k++) {
        PO(cylAt(cx + sgn * (3.9 + k * 0.36), 4 + TH * 0.49, -4.55, 0.14, 0.14, TH * 0.96, 8));
      }
      for (let lv = 0; lv < 12; lv++) {
        const y = 10 + lv * (TH - 8) / 12;
        PD(boxAt(cx + sgn * 4.25, y, -4.55, 1.25, 0.18, 0.42));
      }
      // 回转齿圈与齿牙
      P(cylAt(cx, 8.0, hz, 2.12, 2.12, 0.55, 32));
      for (let i = 0; i < 28; i++) {
        const a = i / 28 * Math.PI * 2;
        const tooth = new T.BoxGeometry(0.34, 0.34, 0.58);
        tooth.rotateY(-a); tooth.translate(cx + Math.cos(a) * 2.12, 8.0, hz + Math.sin(a) * 2.12);
        P(tooth);
      }
      const armMesh = new T.Mesh(mergeAll(bp), M.blue);
      const accentMesh = new T.Mesh(mergeAll(orangeBp), M.orange);
      const darkMesh = new T.Mesh(mergeAll(darkBp), M.hinge);
      const glowMesh = new T.Mesh(mergeAll(glowBp), M.deckGlow);
      armMesh.castShadow = accentMesh.castShadow = darkMesh.castShadow = true;
      pivot.add(armMesh, accentMesh, darkMesh, glowMesh);
      // 固定竖轴、轴承座和驱动电机不随塔架转动
      const fixed = [
        cylAt(cx, 4 + TH * 0.5, hz, 0.62, 0.62, TH * 0.96, 18),
        cylAt(cx, 7.55, hz, 2.55, 2.55, 0.48, 32),
        boxAt(cx, 5.3, hz, 5.8, 1.0, 5.8)
      ];
      add(mergeAll(fixed), M.hinge);
      add(boxAt(cx + sgn * 3.25, 7.7, hz + 0.4, 2.1, 1.55, 1.65), M.orange);
      for (const yy of [11, 21]) {
        add(cylAt(cx, yy, hz, 1.12, 1.12, 0.38, 24), M.steelLight);
        addActuator(pivot, sgn, yy);
      }
      armPivots.push({ pivot, sgn });
    }
    const towerU = { open: 0, target: 0, from: 0, elapsed: 0, duration: 12, moving: false };
    window.__towerU = towerU;
    function setTowerTarget(value, immediate) {
      const target = clamp(value, 0, 1);
      towerU.from = towerU.open;
      towerU.target = target;
      towerU.elapsed = 0;
      towerU.duration = Math.max(2.4, 12 * Math.abs(target - towerU.open));
      towerU.moving = Math.abs(target - towerU.open) > 0.0001;
      if (immediate || !towerU.moving) { towerU.open = target; towerU.moving = false; }
    }
    window.__setTower = setTowerTarget;
    const actB = new T.Vector3(), actD = new T.Vector3(), actDir = new T.Vector3();
    function updateActuators() {
      for (const a of actuators) {
        actB.copy(a.moving).applyAxisAngle(_up, a.pivot.rotation.y).add(a.pivot.position);
        actD.subVectors(actB, a.fixed);
        const len = Math.max(0.1, actD.length());
        actDir.copy(actD).multiplyScalar(1 / len);
        a.barrel.position.copy(a.fixed);
        a.barrel.quaternion.setFromUnitVectors(_up, actDir);
        a.barrel.scale.set(1, len * 0.62, 1);
        a.rod.position.copy(a.fixed).addScaledVector(actDir, len * 0.45);
        a.rod.quaternion.copy(a.barrel.quaternion);
        a.rod.scale.set(1, len * 0.55, 1);
        a.eyeB.position.copy(actB);
      }
    }

    /* ---- 4) 橙色管路 ---- */
    const pipeParts = [];
    for (const sgn of [-1, 1]) {
      const px = sgn * 21.5;
      for (let k = 0; k < 3; k++) {
        pipeParts.push(cylAt(px + k * 1.0, 4 + TH * 0.5, 0, 0.32, 0.32, TH * 0.98, 8));
      }
    }
    add(mergeAll(pipeParts), M.orange);

    /* ---- 5) 塔架平台小灯 ---- */
    const lampParts = [];
    for (let lv = 1; lv <= 12; lv++) {
      const y = 8 + lv * (TH - 8) / 12;
      for (const x of [-12, -6, 0, 6, 12]) {
        lampParts.push(boxAt(x, y + 0.9, BZ + BD - 0.25, 0.5, 0.25, 0.5));
      }
    }
    add(mergeAll(lampParts), M.lamp);

    /* ---- 6) 降温降噪系统（导流槽 + 喷水环 + 喷口）---- */
    const coolParts = [];
    // 导流锥（火箭正下方）
    coolParts.push(cylAt(0, 5.6, 0, 3.0, 6.5, 3.2, 20));
    // 喷水环（环绕发射台）
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      coolParts.push(cylAt(Math.cos(a) * 13, 8.9, Math.sin(a) * 13, 0.18, 0.18, 1.6, 6));
    }
    // 导流槽两侧
    for (const sgn of [-1, 1]) {
      const g = new T.BoxGeometry(4, 2.4, 22);
      g.rotateZ(sgn * 0.42); g.translate(sgn * 5.5, 6.2, 0);
      coolParts.push(g);
    }
    add(mergeAll(coolParts), M.steelLight);

    /* ---- 6.5) 照明：塔内点光 + 地面泛光 ---- */
    const padLights = [];
    for (let i = 0; i < 4; i++) {
      const pl = new T.PointLight(0xffd9a8, 460, 42, 1.9);
      pl.position.set(0, 22 + i * 22, BZ + 3.0);
      padLights.push(pl);
    }
    for (const sgn of [-1, 1]) {
      const sp = new T.SpotLight(0xfff0d8, 1100, 150, 0.55, 0.55, 1.8);
      sp.position.set(sgn * 24, 10, 16);
      sp.target.position.set(0, 40, 0);
      padLights.push(sp, sp.target);
    }
    // 固定背塔的平台灯带；侧塔灯带已随各自铰架运动
    const deckGlow = [];
    for (let lv = 0; lv <= 12; lv++) {
      const y = 8 + lv * (TH - 8) / 12;
      deckGlow.push(boxAt(0, y + 0.28, BZ + BD - 0.2, BW * 1.65, 0.10, 0.18));
    }
    add(mergeAll(deckGlow), M.deckGlow);

    /* ---- 7) 四座避雷塔（参考图 3：又高又细、无横担、顶部一根尖针）---- */
    const mastParts = [];
    const mastTipParts = [];
    function pylon(cx, cz, H) {
      const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const bw = 3.4, tw = 0.75;                // 底宽 / 顶宽（细长）
      const half = y => { const t = y / H; return bw * Math.pow(1 - t, 0.72) + tw * t; };
      const SEG = 12;
      // 四条主材
      for (const [ax, az] of legs) {
        for (let k = 0; k < SEG; k++) {
          const y0 = H * k / SEG, y1 = H * (k + 1) / SEG;
          const r0 = half(y0), r1 = half(y1);
          mastParts.push(bar(new T.Vector3(cx + ax * r0, y0, cz + az * r0),
                             new T.Vector3(cx + ax * r1, y1, cz + az * r1), 0.30, 0.30));
        }
      }
      // 每段水平横材 + X 交叉斜材
      for (let k = 0; k <= SEG; k++) {
        const y = H * k / SEG, r = half(y);
        for (let i = 0; i < 4; i++) {
          const a = legs[i], b = legs[(i + 1) % 4];
          mastParts.push(bar(new T.Vector3(cx + a[0] * r, y, cz + a[1] * r),
                             new T.Vector3(cx + b[0] * r, y, cz + b[1] * r), 0.16, 0.16));
        }
        if (k < SEG) {
          const y2 = H * (k + 1) / SEG, r2 = half(y2);
          for (let i = 0; i < 4; i++) {
            const a = legs[i], b = legs[(i + 1) % 4];
            mastParts.push(bar(new T.Vector3(cx + a[0] * r, y, cz + a[1] * r),
                               new T.Vector3(cx + b[0] * r2, y2, cz + b[1] * r2), 0.12, 0.12));
            mastParts.push(bar(new T.Vector3(cx + b[0] * r, y, cz + b[1] * r),
                               new T.Vector3(cx + a[0] * r2, y2, cz + a[1] * r2), 0.12, 0.12));
          }
        }
      }
      // 顶部避雷针（细长尖针 + 红白航空标志）
      mastParts.push(bar(new T.Vector3(cx, H, cz), new T.Vector3(cx, H + 9, cz), 0.16, 0.16));
      for (let i = 0; i < 3; i++) {
        mastTipParts.push(boxAt(cx, H + 2.2 + i * 2.6, cz, 0.34, 1.2, 0.34));
      }
      mastTipParts.push(boxAt(cx, H + 9.2, cz, 0.30, 0.5, 0.30));
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      pylon(sx * 44, sz * 38, 100);
    }
    add(mergeAll(mastParts), M.steelDark);
    add(mergeAll(mastTipParts), M.red);

    /* ================= 长征五号（可拆解 + 内部结构） =================
       参考：CZ-5 芯一级 5 m / 31 m（前液氧·后液氢，2×YF-77）；
              二级 5 m / 10 m（2×YF-75D）；助推 3.35 m / 27 m（液氧·煤油，1×YF-100）；
              整流罩 5.2 m / 12.5 m（钝卵形头锥） */
    const RC = 2.72, RB = 1.82, RF = 2.84;      // 整体加粗约 8%
    const BASE = 9.0;
    const H_CORE = 31.0, H_UP = 12.5, H_FAIR_CYL = 10.0, H_FAIR_NOSE = 5.5, H_BOOST = 27.0;
    const Y_CORE = BASE, Y_UP = BASE + H_CORE, Y_FAIR = Y_UP + H_UP;

    /* ---- 内部结构专用程序化材质 ---- */
    M.mli = industrial(0xc9a227, 0.34, 0.85, 2, 18.0);
    M.tank = industrial(0xd9d7d2, 0.42, 0.42, 2, 13.0);
    M.inner = industrial(0x6e7378, 0.55, 0.52, 2, 12.0);
    M.pipe = industrial(0xa2653a, 0.45, 0.72, 2, 15.0);
    M.turb = industrial(0x3a3d42, 0.4, 0.85, 2, 16.0);
    M.bell = industrial(0x2a2b30, 0.35, 0.9, 2, 17.0, { side: T.DoubleSide });
    M.seam = industrial(0x8f999e, 0.64, 0.32, 2, 14.0);
    M.bottle = industrial(0xcfd3d6, 0.35, 0.65, 2, 16.0);
    M.servo = industrial(0x8a5a2a, 0.42, 0.75, 2, 14.0);
    M.brk = industrial(0x9aa0a6, 0.6, 0.48, 2, 12.0);
    M.sat = industrial(0xd8d5cc, 0.5, 0.32, 1, 9.0);
    M.panel = industrial(0x2c3f6b, 0.32, 0.6, 2, 12.0);

    /* ---- 贴图 ---- */
    function decalFlag() {
      const W = 360, H = 300;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#de2910'; g.fillRect(80, 18, 200, 134);
      const star = (cx, cy, r, rot) => {
        g.beginPath();
        for (let i = 0; i < 5; i++) {
          const a1 = rot + i * Math.PI * 2 / 5 - Math.PI / 2, a2 = a1 + Math.PI / 5;
          g.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
          g.lineTo(cx + Math.cos(a2) * r * 0.382, cy + Math.sin(a2) * r * 0.382);
        }
        g.closePath(); g.fillStyle = '#ffde00'; g.fill();
      };
      star(112, 52, 22, 0);
      for (const [sx, sy] of [[144, 30], [158, 44], [158, 62], [144, 74]]) star(sx, sy, 7.5, 0.35);
      g.fillStyle = '#111'; g.font = 'bold 58px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('CHN', W / 2, 214);
      return new T.CanvasTexture(c);
    }
    function decalName() {
      const W = 128, H = 512;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#12161c';
      g.font = 'bold 86px "Microsoft YaHei", "SimHei", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      ['中', '国', '航', '天'].forEach((ch, i) => g.fillText(ch, W / 2, 70 + i * 122));
      return new T.CanvasTexture(c);
    }
    function decalLongMarch() {
      const W = 512, H = 260;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      // 红色「5」圆环标
      g.strokeStyle = '#cf2233'; g.lineWidth = 9;
      g.beginPath(); g.arc(W / 2, 86, 56, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#cf2233'; g.font = 'bold 92px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('5', W / 2, 90);
      g.font = 'bold 40px "Arial Narrow", Arial, sans-serif';
      g.fillText('LONG MARCH', W / 2, 190);
      return new T.CanvasTexture(c);
    }
    function decalCasc() {                        // 蓝圈 CASC 标
      const S = 256;
      const c = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d');
      g.clearRect(0, 0, S, S);
      g.strokeStyle = '#2b4a8b'; g.lineWidth = 10;
      g.beginPath(); g.arc(S / 2, S / 2, 104, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#2b4a8b'; g.beginPath();
      g.moveTo(S / 2, 46); g.lineTo(S / 2 + 52, S - 66); g.lineTo(S / 2 - 52, S - 66); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.beginPath();
      g.moveTo(S / 2, 104); g.lineTo(S / 2 + 24, S - 96); g.lineTo(S / 2 - 24, S - 96); g.closePath(); g.fill();
      return new T.CanvasTexture(c);
    }
    function decalCZ5() {                         // 助推器上的 CZ-5
      const W = 128, H = 512;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#2a2f36'; g.font = 'bold 62px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      ['C', 'Z', '-', '5'].forEach((ch, i) => g.fillText(ch, W / 2, 60 + i * 96));
      return new T.CanvasTexture(c);
    }
    function decalChecker() {
      const S = 128;
      const c = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d');
      const n = 8, q = S / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        g.fillStyle = ((x + y) & 1) ? '#c8102e' : '#f2f0ec';
        g.fillRect(x * q, y * q, q, q);
      }
      const t = new T.CanvasTexture(c);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.colorSpace = T.SRGBColorSpace;
      return t;
    }
    const MK = (map, tr) => industrial(0xffffff, 0.55, 0.02, 5, 12.0, { map, transparent: !!tr, alphaTest: tr ? 0.45 : 0, polygonOffset: true, polygonOffsetFactor: -1 });
    const matFlag = MK(decalFlag(), true), matName = MK(decalName(), true);
    const matLM = MK(decalLongMarch(), true), matCasc = MK(decalCasc(), true), matCZ5 = MK(decalCZ5(), true);
    const chkTex = decalChecker();

    /* ---- 部件容器 ---- */
    const rocketGroup = new T.Group();
    rocketGroup.name = 'rocket';
    const ROCKET_RADIAL = 1.20, ROCKET_VERTICAL = 1.46;
    rocketGroup.scale.set(ROCKET_RADIAL, ROCKET_VERTICAL, ROCKET_RADIAL);
    rocketGroup.position.y = BASE * (1 - ROCKET_VERTICAL);
    const rocketParts = [];

    function newPart(name, label, base) {
      const g = new T.Group();
      g.position.set(base.x, base.y, base.z);
      g.userData.__part = null;                     // 回填
      rocketGroup.add(g);
      const inner = new T.Group();
      inner.visible = false;
      g.add(inner);
      const LY = name === 'fairing' ? 6 : (name === 'upper' ? 5 : (name === 'core' ? 15 : 13));
      const rec = { name, label, obj: g, inner, base: { ...base }, slot: { ...base, ry: 0 }, el: null, shellMats: [], matMap: new Map(), t: 0, target: 0, labelY: LY };
      g.userData.__part = rec;
      rocketParts.push(rec);
      return rec;
    }
    const _T = (geo, x, y, z) => { geo.translate(x, y, z); return geo; };

    function addShell(rec, geo, mat) {
      geo.translate(-rec.base.x, -rec.base.y, -rec.base.z);   // 几何按绝对坐标建，这里换回部件局部
      let m = rec.matMap.get(mat.uuid);
      if (!m) { m = cloneIndustrial(mat); rec.matMap.set(mat.uuid, m); rec.shellMats.push(m); rec.obj.add(new T.Mesh(geo, m)); }
      else rec.obj.add(new T.Mesh(geo, m));
      const mesh = rec.obj.children[rec.obj.children.length - 1];
      mesh.castShadow = true;
      return mesh;
    }
    function addInner(rec, geo, mat) {
      geo.translate(-rec.base.x, -rec.base.y, -rec.base.z);
      const mesh = new T.Mesh(geo, mat);
      mesh.castShadow = true;
      rec.inner.add(mesh);
      return mesh;
    }
    // 贮箱：柱段 + 两个椭球封头
    function addTank(rec, x, y0, z, r, cylH, mat, domeK) {
      const dh = (domeK || 0.62) * r;
      addInner(rec, _T(new T.CylinderGeometry(r, r, cylH, 28, 1, true), x, y0 + cylH * 0.5, z), mat);
      const up = new T.SphereGeometry(r, 28, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
      up.scale(1, dh / r, 1); up.translate(x, y0 + cylH, z);
      addInner(rec, up, mat);
      const dn = new T.SphereGeometry(r, 28, 10, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5);
      dn.scale(1, dh / r, 1); dn.translate(x, y0, z);
      addInner(rec, dn, mat);
      return cylH + dh * 2;
    }
    function addBell(rec, x, y, z, r1, r2, h) {
      const g = new T.CylinderGeometry(r1, r2, h, 32, 1, true);
      g.translate(x, y - h * 0.5, z);
      addShell(rec, g, M.bell);
      const cooling = [];
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        cooling.push(bar(
          new T.Vector3(x + Math.cos(a) * (r1 + 0.012), y - 0.08, z + Math.sin(a) * (r1 + 0.012)),
          new T.Vector3(x + Math.cos(a) * (r2 + 0.012), y - h + 0.05, z + Math.sin(a) * (r2 + 0.012)),
          0.022, 0.022
        ));
      }
      const rim = new T.TorusGeometry(r2, 0.035, 6, 32);
      rim.rotateX(Math.PI / 2); rim.translate(x, y - h, z);
      cooling.push(rim);
      addShell(rec, mergeAll(cooling), M.steelLight);
      addInner(rec, _T(new T.CylinderGeometry(r2 * 0.42, r2 * 0.42, 0.35, 16), x, y + 0.15, z), M.turb);
    }
    // 增压气瓶（COPV）：柱段 + 两个半球
    function addCOPV(rec, x, y, z, r, h) {
      addInner(rec, _T(new T.CylinderGeometry(r, r, h, 14), x, y, z), M.bottle);
      for (const sgn of [1, -1]) {
        const sp = new T.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
        if (sgn < 0) sp.rotateX(Math.PI);
        sp.translate(x, y + sgn * h * 0.5, z);
        addInner(rec, sp, M.bottle);
      }
    }
    // 摆动伺服：机架 → 喷管的两根作动筒
    function addServo(rec, ex, ey, ez, baseR) {
      for (let k = 0; k < 2; k++) {
        const a = (k ? 1 : -1) * 0.55;
        addPipe(rec, [
          new T.Vector3(ex + Math.cos(a) * baseR, ey + 1.25, ez + Math.sin(a) * baseR),
          new T.Vector3(ex + Math.cos(a) * 0.34, ey + 0.35, ez + Math.sin(a) * 0.34)
        ], 0.075);
        addInner(rec, _T(new T.BoxGeometry(0.13, 0.2, 0.13), ex + Math.cos(a) * baseR, ey + 1.32, ez + Math.sin(a) * baseR), M.brk);
      }
    }
    function addPipe(rec, pts, r) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = new T.Vector3().subVectors(b, a);
        const len = d.length();
        if (len < 1e-3) continue;
        const g = new T.CylinderGeometry(r, r, len, 8);
        const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), d.clone().normalize());
        const m = new T.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new T.Vector3(1, 1, 1));
        g.applyMatrix4(m);
        addInner(rec, g, M.pipe);
      }
    }

    function surfaceBox(w, h, d, a, r, y, cx, cz) {
      const g = new T.BoxGeometry(w, h, d);
      g.rotateY(a);
      g.translate(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r);
      return g;
    }
    function addAirframeDetails(rec, cx, cz, y0, radius, height, sections, stringers) {
      const seams = [], ribs = [], borders = [], hatches = [], rivets = [], conduits = [];
      for (let j = 1; j < sections; j++) {
        const y = y0 + height * j / sections;
        seams.push(cylAt(cx, y, cz, radius + 0.014, radius + 0.014, 0.032, 48));
      }
      for (let i = 0; i < stringers; i++) {
        const a = i / stringers * Math.PI * 2;
        ribs.push(cylAt(cx + Math.sin(a) * (radius + 0.018), y0 + height * 0.5,
          cz + Math.cos(a) * (radius + 0.018), 0.014, 0.014, height * 0.96, 5));
      }
      for (const a of [1.12, 2.72, 4.36]) {
        for (const fy of [0.28, 0.66]) {
          const y = y0 + height * fy;
          borders.push(surfaceBox(0.64, 0.90, 0.035, a, radius + 0.025, y, cx, cz));
          hatches.push(surfaceBox(0.56, 0.82, 0.035, a, radius + 0.052, y, cx, cz));
          for (const tx of [-0.22, 0.22]) for (const ty of [-0.33, 0.33]) {
            const g = new T.SphereGeometry(0.035, 6, 4);
            g.translate(cx + Math.sin(a) * (radius + 0.082) + Math.cos(a) * tx,
              y + ty, cz + Math.cos(a) * (radius + 0.082) - Math.sin(a) * tx);
            rivets.push(g);
          }
        }
      }
      for (const a of [1.75, 4.85]) {
        const x = cx + Math.sin(a) * (radius + 0.075), z = cz + Math.cos(a) * (radius + 0.075);
        conduits.push(cylAt(x, y0 + height * 0.48, z, 0.042, 0.042, height * 0.82, 7));
        for (let j = 1; j < sections * 2; j++) {
          const y = y0 + height * j / (sections * 2);
          conduits.push(surfaceBox(0.20, 0.09, 0.11, a, radius + 0.07, y, cx, cz));
        }
      }
      addShell(rec, mergeAll(seams), M.seam);
      addShell(rec, mergeAll(ribs), M.body);
      addShell(rec, mergeAll(borders), M.seam);
      addShell(rec, mergeAll(hatches), M.body);
      addShell(rec, mergeAll(rivets), M.steelLight);
      addShell(rec, mergeAll(conduits), M.steelLight);
    }

    /* ================= ① 整流罩 ================= */
    const pFair = newPart('fairing', '卫星整流罩 · Ø5.2 m / 15.5 m', { x: 0, y: Y_FAIR, z: 0 });
    addShell(pFair, cylAt(0, Y_FAIR + H_FAIR_CYL * 0.5, 0, RF, RF, H_FAIR_CYL, 40), M.body);
    addShell(pFair, (() => {
      const pts = [], N = 10, rTip = 0.34;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        pts.push(new T.Vector2(rTip + (RF - rTip) * Math.pow(Math.cos(t * Math.PI * 0.5), 0.72), t * H_FAIR_NOSE));
      }
      const g = new T.LatheGeometry(pts, 40);
      g.translate(0, Y_FAIR + H_FAIR_CYL, 0);
      return g;
    })(), M.body);
    addShell(pFair, (() => { const g = new T.SphereGeometry(0.34, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5); g.translate(0, Y_FAIR + H_FAIR_CYL + H_FAIR_NOSE, 0); return g; })(), M.body);
    addShell(pFair, cylAt(0, Y_FAIR + 0.4, 0, RF * 1.006, RF * 1.006, 0.8, 40), M.dark);
    for (const ang of [0.28, Math.PI + 0.28]) {
      const g = new T.BoxGeometry(0.10, H_FAIR_CYL, 0.10);
      g.rotateY(ang); g.translate(Math.cos(ang) * RF, Y_FAIR + H_FAIR_CYL * 0.5, Math.sin(ang) * RF);
      addShell(pFair, g, M.steelLight);
    }
    addShell(pFair, _T(new T.PlaneGeometry(2.2, 1.85), 0, Y_FAIR + 6.2, RF + 0.02), matFlag);
    addAirframeDetails(pFair, 0, 0, Y_FAIR, RF, H_FAIR_CYL, 4, 12);
    // 内部：卫星 + 适配器 + 分离机构
    addInner(pFair, _T(new T.CylinderGeometry(RF * 0.52, RF * 0.62, 1.6, 24, 1, true), 0, Y_FAIR + 1.2, 0), M.inner);
    addInner(pFair, _T(new T.BoxGeometry(2.2, 3.0, 2.2), 0, Y_FAIR + 4.0, 0), M.sat);
    addInner(pFair, _T(new T.BoxGeometry(1.6, 1.2, 1.6), 0, Y_FAIR + 6.1, 0), M.sat);
    for (const sgn of [-1, 1]) {
      addInner(pFair, _T(new T.BoxGeometry(0.08, 2.6, 1.6), sgn * 1.6, Y_FAIR + 4.0, 0), M.panel);
    }
    addInner(pFair, _T(new T.CylinderGeometry(0.12, 0.12, 1.4, 10), 0, Y_FAIR + 7.2, 0), M.inner);

    /* ================= ② 芯二级（氢氧） ================= */
    const pUp = newPart('upper', '氢氧二级 · Ø5 m / 12.5 m · 2×YF-75D', { x: 0, y: Y_UP, z: 0 });
    addShell(pUp, cylAt(0, Y_UP + H_UP * 0.5, 0, RC, RC, H_UP, 40), M.body);
    addShell(pUp, ringAt(Y_UP + 0.9, RC + 0.012, 0.075, 40), M.seam);
    addShell(pUp, _T(new T.PlaneGeometry(1.55, 1.55), 0, Y_UP + 9.6, RC + 0.02), matCasc);
    addShell(pUp, _T(new T.PlaneGeometry(1.35, 4.6), 0, Y_UP + 5.4, RC + 0.02), matName);
    addAirframeDetails(pUp, 0, 0, Y_UP, RC, H_UP, 4, 12);
    // 内部：液氢箱（下、大）、液氧箱（上、小）、共底、2 台 YF-75D
    addTank(pUp, 0, Y_UP + 1.0, 0, RC * 0.86, 3.4, M.mli);           // LH2
    addTank(pUp, 0, Y_UP + 6.0, 0, RC * 0.80, 2.2, M.tank);          // LOX
    addInner(pUp, _T(new T.CylinderGeometry(RC * 0.9, RC * 0.9, 0.16, 28), 0, Y_UP + 5.6, 0), M.inner);  // 共底
    for (const sx of [-1.05, 1.05]) {
      addBell(pUp, sx, Y_UP + 0.9, 0, 0.30, 0.62, 1.5);
      addInner(pUp, _T(new T.BoxGeometry(0.5, 0.7, 0.5), sx * 1.7, Y_UP + 1.6, 0), M.turb);
    }
    addPipe(pUp, [new T.Vector3(-1.7, Y_UP + 2.0, 0.5), new T.Vector3(-1.7, Y_UP + 5.0, 0.5), new T.Vector3(-1.2, Y_UP + 5.6, 0.3)], 0.09);
    addPipe(pUp, [new T.Vector3(1.7, Y_UP + 6.4, -0.4), new T.Vector3(1.55, Y_UP + 3.4, -0.6), new T.Vector3(1.2, Y_UP + 1.6, -0.4)], 0.075);
    addCOPV(pUp, 0.0, Y_UP + 3.4, -1.35, 0.2, 0.7);
    addCOPV(pUp, 0.0, Y_UP + 3.4, 1.35, 0.2, 0.7);
    for (const sx of [-1.05, 1.05]) addServo(pUp, sx, Y_UP + 0.9, 0, 1.3);

    /* ================= ③ 芯一级（5 m 模块） ================= */
    const pCore = newPart('core', '芯一级 · Ø5 m / 31 m · 2×YF-77', { x: 0, y: Y_CORE, z: 0 });
    addShell(pCore, cylAt(0, Y_CORE + H_CORE * 0.5, 0, RC, RC, H_CORE, 48), M.body);
    // 只有两道很细的对接缝（照片里箭体是干净的，不该有一圈圈亮箍）
    for (const dy of [11.0, 23.0]) addShell(pCore, ringAt(Y_CORE + dy, RC + 0.012, 0.075, 48), M.seam);
    addShell(pCore, cylAt(0, Y_CORE + 1.6, 0, RC * 1.015, RC * 1.04, 3.2, 48), M.steelDark);
    // 红色「5」+ LONG MARCH：芯级顶部（紧贴二级下方）
    addShell(pCore, _T(new T.PlaneGeometry(3.4, 1.75), 0, Y_CORE + 27.6, RC + 0.02), matLM);
    addAirframeDetails(pCore, 0, 0, Y_CORE + 3.2, RC, H_CORE - 3.2, 7, 16);
    // 内部：前液氧箱（12 m）+ 后液氢箱（14 m，带镀铝薄膜）+ 承力桁架 + 2 台 YF-77
    addTank(pCore, 0, Y_CORE + 17.5, 0, RC * 0.86, 8.4, M.tank);      // LOX
    addTank(pCore, 0, Y_CORE + 2.6, 0, RC * 0.86, 11.2, M.mli);       // LH2
    addInner(pCore, _T(new T.CylinderGeometry(RC * 0.9, RC * 0.9, 0.18, 32), 0, Y_CORE + 17.2, 0), M.inner);
    // 桁架承力框
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      addInner(pCore, bar(new T.Vector3(Math.cos(a) * 0.6, Y_CORE + 1.2, Math.sin(a) * 0.6),
        new T.Vector3(Math.cos(a) * RC * 0.92, Y_CORE + 2.5, Math.sin(a) * RC * 0.92), 0.14, 0.14), M.inner);
    }
    addInner(pCore, _T(new T.CylinderGeometry(RC * 0.95, RC * 0.95, 0.22, 32), 0, Y_CORE + 2.6, 0), M.inner);
    for (const sx of [-1.05, 1.05]) {
      addBell(pCore, sx, Y_CORE + 1.0, 0, 0.52, 1.0, 2.2);
      addInner(pCore, _T(new T.BoxGeometry(0.8, 1.0, 0.8), sx * 1.75, Y_CORE + 3.2, 0), M.turb);
      addInner(pCore, _T(new T.CylinderGeometry(0.1, 0.1, 1.4, 10), sx * 1.75, Y_CORE + 2.2, 0.7), M.pipe);
    }
    // 输送管拓扑：氧箱 → 涡轮泵（左右各一路）+ 回流管
    for (const sx of [-1, 1]) {
      addPipe(pCore, [
        new T.Vector3(sx * 1.9, Y_CORE + 17.0, 1.45),
        new T.Vector3(sx * 2.0, Y_CORE + 9.0, 1.55),
        new T.Vector3(sx * 1.95, Y_CORE + 4.2, 1.3),
        new T.Vector3(sx * 1.75, Y_CORE + 3.3, 0.5)
      ], 0.115);
      addPipe(pCore, [
        new T.Vector3(sx * 1.95, Y_CORE + 3.0, -0.9),
        new T.Vector3(sx * 1.85, Y_CORE + 8.0, -1.5),
        new T.Vector3(sx * 1.6, Y_CORE + 12.6, -1.4)
      ], 0.085);
    }
    // 增压气瓶（氦瓶，挂在下部机架内侧）
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + 0.4;
      addCOPV(pCore, Math.cos(a) * 1.55, Y_CORE + 4.4, Math.sin(a) * 1.55, 0.24, 0.9);
    }
    // 摆动伺服（两台发动机各两根）
    for (const sx of [-1.05, 1.05]) addServo(pCore, sx, Y_CORE + 1.0, 0, 1.55);

    /* ================= ④ 4 个助推器 ================= */
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + Math.PI / 4;
      const bx = Math.cos(a) * (RC + RB - 0.15), bz = Math.sin(a) * (RC + RB - 0.15);
      const rec = newPart('boost' + i, '助推器 · Ø3.35 m / 27 m · YF-100', { x: bx, y: Y_CORE, z: bz });
      addShell(rec, cylAt(bx, Y_CORE + H_BOOST * 0.5, bz, RB, RB, H_BOOST, 32), M.boost);
      addShell(rec, (() => {
        // 半圆锥：外半圈是气动外形，竖切面朝向芯级（参考照片）
        const pts = [], N = 8, rTip = 0.26, HN = 3.4;
        for (let q = 0; q <= N; q++) {
          const t = q / N;
          pts.push(new T.Vector2(rTip + (RB - rTip) * Math.pow(Math.cos(t * Math.PI * 0.5), 0.70), t * HN));
        }
        const g = new T.LatheGeometry(pts, 18, 0, Math.PI);   // 只做半圈
        g.rotateY(-a);                                        // 平面朝芯级
        g.translate(bx, Y_CORE + H_BOOST, bz);
        return g;
      })(), M.body);
      // 竖切面的封板
      addShell(rec, (() => {
        const sh = new T.Shape();
        const rTip = 0.26, HN = 3.4, N = 8;
        sh.moveTo(0, 0);
        for (let q = 0; q <= N; q++) {
          const t = q / N;
          sh.lineTo(rTip + (RB - rTip) * Math.pow(Math.cos(t * Math.PI * 0.5), 0.70), t * HN);
        }
        sh.lineTo(0, HN);
        sh.closePath();
        const g = new T.ShapeGeometry(sh);
        g.rotateY(-a - Math.PI / 2);
        g.translate(bx, Y_CORE + H_BOOST, bz);
        return g;
      })(), M.steelLight);
      addShell(rec, ringAt(Y_CORE + H_BOOST + 0.05, RB + 0.03, 0.26, 32), M.steelLight);
      // 红白方格带 + CZ-5
      const ang = a + Math.PI / 2;
      for (const side of [-0.55, 0.55]) {
        const g = new T.PlaneGeometry(0.85, 9.0);
        g.translate(0, 0, 0);
        g.rotateY(-ang);
        g.translate(bx + Math.cos(ang) * (RB + 0.02) + Math.cos(ang + Math.PI / 2) * side,
          Y_CORE + 11.5, bz + Math.sin(ang) * (RB + 0.02) + Math.sin(ang + Math.PI / 2) * side);
        addShell(rec, g, industrial(0xffffff, 0.6, 0.02, 5, 10.0, { map: chkTex.clone() }));
      }
      addShell(rec, (() => {
        const g = new T.PlaneGeometry(0.55, 3.0);
        g.rotateY(-a - Math.PI / 2);
        g.translate(bx + Math.cos(a) * (RB + 0.02) * -1, Y_CORE + 15.0, bz + Math.sin(a) * (RB + 0.02) * -1);
        return g;
      })(), matCZ5);
      for (const dy of [13.5]) addShell(rec, ringAt(Y_CORE + dy, RB + 0.01, 0.07, 32), M.seam);
      addShell(rec, cylAt(bx, Y_CORE + 1.0, bz, RB * 1.02, RB * 1.06, 2.0, 24), M.steelDark);
      addAirframeDetails(rec, bx, bz, Y_CORE + 2.0, RB, H_BOOST - 2.0, 6, 10);
      // 内部：液氧箱（上）+ 煤油箱（下）+ YF-100
      addTank(rec, bx, Y_CORE + 14.0, bz, RB * 0.84, 9.0, M.tank);
      addTank(rec, bx, Y_CORE + 3.0, bz, RB * 0.84, 9.4, M.tank);
      addInner(rec, _T(new T.CylinderGeometry(RB * 0.88, RB * 0.88, 0.16, 24), bx, Y_CORE + 12.9, bz), M.inner);
      addInner(rec, _T(new T.CylinderGeometry(RB * 0.92, RB * 0.92, 0.2, 24), bx, Y_CORE + 2.9, bz), M.inner);
      addBell(rec, bx, Y_CORE + 1.6, bz, 0.40, 0.86, 2.0);
      addInner(rec, _T(new T.BoxGeometry(0.7, 0.9, 0.7), bx, Y_CORE + 3.4, bz), M.turb);
      addPipe(rec, [new T.Vector3(bx + RB * 0.60, Y_CORE + 3.6, bz), new T.Vector3(bx + RB * 0.74, Y_CORE + 13.5, bz),
        new T.Vector3(bx + RB * 0.40, Y_CORE + 13.9, bz)], 0.08);
      addPipe(rec, [new T.Vector3(bx - RB * 0.60, Y_CORE + 3.8, bz), new T.Vector3(bx - RB * 0.70, Y_CORE + 13.2, bz),
        new T.Vector3(bx - RB * 0.35, Y_CORE + 13.6, bz)], 0.07);
      addCOPV(rec, bx + RB * 0.45, Y_CORE + 4.6, bz + RB * 0.35, 0.16, 0.6);
      addCOPV(rec, bx - RB * 0.45, Y_CORE + 4.6, bz + RB * 0.35, 0.16, 0.6);
      addServo(rec, bx, Y_CORE + 1.6, bz, 1.05);
      // 稳定翼 + 连接杆
      (function fin() {
        const g = new T.BoxGeometry(2.0, 3.0, 0.16, 1, 1, 1);
        const pos = g.attributes.position;
        for (let vi = 0; vi < pos.count; vi++) if (pos.getY(vi) > 0) pos.setX(vi, pos.getX(vi) * 0.32 + 0.56);
        g.computeVertexNormals();
        g.rotateY(-a);
        g.translate(bx + Math.cos(a) * (RB * 0.92), Y_CORE + 1.2, bz + Math.sin(a) * (RB * 0.92));
        addShell(rec, g, M.steelLight);
      })();
      // 连接接口：芯级表面上的小支座 + 斜撑（照片里是几个小接头，不是长杆）
      for (const dy of [6.0, 14.0, 20.5]) {
        const nx = Math.cos(a), nz = Math.sin(a);         // 芯级 → 助推 的方向
        const rIn = RC, rOut = RC + RB - 0.15;
        addShell(rec, (() => {
          const g = new T.BoxGeometry(0.9, 0.85, 0.75);
          g.rotateY(-a);
          g.translate(bx - nx * (rOut - rIn) * 0.55, Y_CORE + dy, bz - nz * (rOut - rIn) * 0.55);
          return g;
        })(), M.steelDark);
        addShell(rec, bar(
          new T.Vector3(bx - nx * (rOut - rIn) * 0.95, Y_CORE + dy - 0.9, bz - nz * (rOut - rIn) * 0.95),
          new T.Vector3(bx - nx * (rOut - rIn) * 0.15, Y_CORE + dy + 0.7, bz - nz * (rOut - rIn) * 0.15), 0.16, 0.16), M.steelDark);
      }
    }

    const EXPLODE_ORDER = ['fairing', 'upper', 'core', 'boost0', 'boost1', 'boost2', 'boost3'];
    const explodeSlots = {
      fairing: { x: 14, y: 43, z: 16, ry: -0.35 },
      upper: { x: -14, y: 40, z: 18, ry: 0.45 },
      core: { x: 0, y: 24, z: 34, ry: -0.50 },
      boost0: { x: -25, y: 13, z: 4, ry: 0.45 },
      boost1: { x: -13, y: 11, z: 10, ry: 0.15 },
      boost2: { x: 13, y: 11, z: 10, ry: -0.15 },
      boost3: { x: 25, y: 13, z: 4, ry: -0.45 }
    };
    for (const p of rocketParts) Object.assign(p.slot, explodeSlots[p.name]);

    /* ================= 控制台：型号选择、部件分解与塔架回转 ================= */
    const rocketCatalog = [{ id: 'cz-5', name: '长征五号', code: 'CZ-5', meta: '两级半构型 · 四枚助推器' }];
    const rocketU = {
      focus: null, expanded: new Set(), model: rocketCatalog[0].id,
      sequence: { active: false, index: 0, timer: 0, step: 0.82 }
    };
    window.__rocketU = rocketU;
    window.__rocketParts = rocketParts;
    window.__rocketGroup = rocketGroup;
    window.__rocketCatalog = rocketCatalog;

    const labelBox = document.createElement('div');
    labelBox.id = 'rocketLabels';
    document.body.appendChild(labelBox);
    const st = document.createElement('style');
    st.textContent = '#rocketLabels{position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden}' +
      '.rlabel{position:absolute;transform:translate(-50%,-50%);padding:5px 11px;border-radius:3px;' +
      'background:rgba(8,14,22,.78);border:1px solid rgba(150,200,255,.5);color:#dceaf6;' +
      'font:12px/1.45 "Microsoft YaHei",sans-serif;white-space:nowrap;opacity:0;transition:opacity .3s;' +
      'backdrop-filter:blur(3px);letter-spacing:.4px}' +
      '.rlabel::after{content:"";position:absolute;right:-16px;top:50%;width:14px;height:1px;background:rgba(150,200,255,.7)}' +
      '.rlabel.right::after{right:auto;left:-16px}';
    document.head.appendChild(st);
    rocketParts.forEach(p => {
      const d = document.createElement('div');
      d.className = 'rlabel';
      d.textContent = p.label || '';
      labelBox.appendChild(d);
      p.el = d;
    });

    const consoleEl = document.getElementById('rocketConsole');
    const partButtons = Array.from(document.querySelectorAll('.partBtn'));
    const explodeBtn = document.getElementById('explodeBtn');
    const asmBtn = document.getElementById('asmBtn');
    const armBtn = document.getElementById('armBtn');
    const armRange = document.getElementById('armRange');
    const armAngle = document.getElementById('armAngle');
    const partReadout = document.getElementById('partReadout');
    const consoleStatus = document.getElementById('consoleStatus');
    const rocketSelect = document.getElementById('rocketSelect');
    for (const model of rocketCatalog) rocketSelect.add(new Option(`${model.name} · ${model.code}`, model.id));

    function updateConsole() {
      const angle = Math.round(towerU.open * 90);
      const count = rocketU.expanded.size;
      const seq = rocketU.sequence;
      armAngle.textContent = String(angle).padStart(3, '0') + '°';
      if (document.activeElement !== armRange) armRange.value = String(angle);
      armBtn.textContent = towerU.target > 0.5 ? '合拢塔架' : '张开塔架';
      explodeBtn.disabled = seq.active;
      explodeBtn.textContent = seq.active ? `解体中 ${seq.index}/7` : '一键解体';
      asmBtn.disabled = count === 0;
      for (const btn of partButtons) {
        const rec = rocketParts.find(p => p.name === btn.dataset.part);
        const active = rec && rocketU.expanded.has(rec);
        btn.classList.toggle('active', !!active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (rocketU.focus) {
        partReadout.textContent = rocketU.focus.label + (count > 1 ? ` · 已展开 ${count}/7` : '');
        partReadout.classList.add('active');
      } else {
        partReadout.textContent = '可独立展开多个部件；一键按自上而下顺序解体。';
        partReadout.classList.remove('active');
      }
      if (seq.active) consoleStatus.textContent = `自动解体 ${seq.index}/7 · ${rocketU.focus ? rocketU.focus.label.split(' · ')[0] : ''}`;
      else if (towerU.moving) consoleStatus.textContent = '回转机构运行中';
      else if (count === rocketParts.length) consoleStatus.textContent = '全箭解体展示 · 7/7';
      else if (count > 0) consoleStatus.textContent = `多部件展示 · 已展开 ${count}/7`;
      else consoleStatus.textContent = '系统就绪';
    }
    function advanceExplodeSequence() {
      const seq = rocketU.sequence;
      if (!seq.active) return;
      const rec = rocketParts.find(p => p.name === EXPLODE_ORDER[seq.index]);
      if (rec) { rocketU.expanded.add(rec); rocketU.focus = rec; }
      seq.index++;
      if (seq.index >= EXPLODE_ORDER.length) seq.active = false;
    }
    function startExplodeSequence() {
      rocketU.expanded.clear();
      rocketU.focus = null;
      const seq = rocketU.sequence;
      seq.active = true; seq.index = 0; seq.timer = 0;
      advanceExplodeSequence();
      updateConsole();
    }
    function togglePart(rec) {
      rocketU.sequence.active = false;
      if (rocketU.expanded.has(rec)) {
        rocketU.expanded.delete(rec);
        if (rocketU.focus === rec) rocketU.focus = Array.from(rocketU.expanded).pop() || null;
      } else {
        rocketU.expanded.add(rec);
        rocketU.focus = rec;
      }
      updateConsole();
    }
    function assembleRocket() {
      rocketU.sequence.active = false;
      rocketU.expanded.clear();
      rocketU.focus = null;
      updateConsole();
    }
    partButtons.forEach(btn => btn.addEventListener('click', () => {
      const rec = rocketParts.find(p => p.name === btn.dataset.part);
      if (rec) togglePart(rec);
    }));
    explodeBtn.addEventListener('click', startExplodeSequence);
    asmBtn.addEventListener('click', assembleRocket);
    armBtn.addEventListener('click', () => { setTowerTarget(towerU.target > 0.5 ? 0 : 1, false); updateConsole(); });
    armRange.addEventListener('input', () => { setTowerTarget(parseFloat(armRange.value) / 90, true); updateConsole(); });
    rocketSelect.addEventListener('change', () => {
      rocketU.model = rocketSelect.value;
      assembleRocket();
      const model = rocketCatalog.find(item => item.id === rocketU.model) || rocketCatalog[0];
      const meta = document.querySelector('.rc-model-meta');
      meta.children[0].textContent = model.meta;
      meta.children[1].textContent = model.code;
    });
    document.getElementById('rcReset').addEventListener('click', () => {
      assembleRocket();
      rocketU.model = rocketCatalog[0].id;
      rocketSelect.value = rocketU.model;
      setTowerTarget(0, false);
      updateConsole();
    });
    document.getElementById('rcCollapse').addEventListener('click', ev => {
      const collapsed = consoleEl.classList.toggle('collapsed');
      ev.currentTarget.textContent = collapsed ? '+' : '−';
      ev.currentTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      ev.currentTarget.setAttribute('aria-label', collapsed ? '展开控制台' : '收起控制台');
    });
    window.__rocketControl = {
      togglePart(name) { const rec = rocketParts.find(p => p.name === name); if (rec) togglePart(rec); },
      explode: startExplodeSequence,
      assemble: assembleRocket,
      setTower: setTowerTarget
    };
    updateConsole();

    const padFadeMats = [];
    let consoleTimer = 0;
    const _wp = new T.Vector3(), _proj = new T.Vector3();
    window.__rocketUpdate = function (dt) {
      const u = rocketU;
      // 12 秒五阶缓动回转；起止无速度突变，避免整塔“甩出去”
      if (towerU.moving) {
        towerU.elapsed += dt;
        const q = clamp(towerU.elapsed / Math.max(0.001, towerU.duration), 0, 1);
        const e = q * q * q * (q * (q * 6 - 15) + 10);
        towerU.open = lerp(towerU.from, towerU.target, e);
        if (q >= 1) { towerU.open = towerU.target; towerU.moving = false; }
      }
      for (const a of armPivots) a.pivot.rotation.y = a.sgn * towerU.open * Math.PI * 0.5;
      updateActuators();
      if (u.sequence.active) {
        u.sequence.timer += dt;
        while (u.sequence.active && u.sequence.timer >= u.sequence.step) {
          u.sequence.timer -= u.sequence.step;
          advanceExplodeSequence();
        }
      }
      let focusedAmt = 0;
      for (const p of rocketParts) {
        p.target = u.expanded.has(p) ? 1 : 0;
        p.t += (p.target - p.t) * Math.min(1, dt * 1.15);
        if (p.t < 0.002 && p.target === 0) p.t = 0;
        const e = p.t * p.t * (3 - 2 * p.t);
        p.obj.position.set(
          lerp(p.base.x, p.slot.x, e),
          lerp(p.base.y, p.slot.y, e),
          lerp(p.base.z, p.slot.z, e)
        );
        p.obj.rotation.y = p.slot.ry * e;
        const op = 1 - 0.78 * e;
        for (const m of p.shellMats) {
          const wantsT = e > 0.02;
          if (m.transparent !== wantsT) { m.transparent = wantsT; m.needsUpdate = true; }
          m.opacity = op;
          m.depthWrite = e < 0.35;
        }
        p.inner.visible = e > 0.06;
        if (p.target === 1) focusedAmt = Math.max(focusedAmt, e);
      }
      const fade = 1 - 0.62 * focusedAmt;
      for (const m of padFadeMats) {
        const wantsT = fade < 0.995;
        if (m.transparent !== wantsT) { m.transparent = wantsT; m.needsUpdate = true; }
        m.opacity = fade;
        if (m.uniforms && m.uniforms.uLampOpacity) m.uniforms.uLampOpacity.value = fade;
        m.depthWrite = fade > 0.55;
      }
      for (const p of rocketParts) {
        if (!p.el) continue;
        if (!u.expanded.has(p) || p.t < 0.25 || (u.expanded.size > 3 && u.focus !== p)) { p.el.style.opacity = '0'; continue; }
        p.obj.getWorldPosition(_wp);
        _wp.y += (p.labelY || 1.2) * ROCKET_VERTICAL;
        _proj.copy(_wp).project(camera);
        if (_proj.z > 1) { p.el.style.opacity = '0'; continue; }
        const sx = (_proj.x * 0.5 + 0.5) * innerWidth;
        const sy = (-_proj.y * 0.5 + 0.5) * innerHeight;
        const right = sx < 300;
        p.el.classList.toggle('right', right);
        p.el.style.left = (sx + (right ? 150 : -150)).toFixed(1) + 'px';
        p.el.style.top = sy.toFixed(1) + 'px';
        p.el.style.opacity = String(Math.min(1, (p.t - 0.25) * 3));
      }
      consoleTimer += dt;
      if (consoleTimer >= 0.08) { consoleTimer = 0; updateConsole(); }
    };

    /* ================= 组装 ================= */
    /* ================= 组装 ================= */
    /* ================= 组装 ================= */
    const group = new T.Group();
    const byMat = new Map();
    for (const p of parts) {
      if (!byMat.has(p.mat)) byMat.set(p.mat, []);
      byMat.get(p.mat).push(p.geo);
    }
    for (const [mat, geos] of byMat) {
      const mesh = new T.Mesh(mergeAll(geos), mat);
      mesh.castShadow = true; mesh.receiveShadow = false;  // 只投不收：避免远处树影投到箭体上
      group.add(mesh);
    }

    group.add(rocketGroup);
    group.add(mechanisms);
    for (const a of armPivots) group.add(a.pivot);
    // 收集发射台自身的材质（排除火箭），拆解时淡出
    (function collectPadMats() {
      const seen = new Set();
      group.traverse(o => {
        if (!o.isMesh || !o.material) return;
        let anc = o;
        while (anc) { if (anc === rocketGroup) return; anc = anc.parent; }
        if (seen.has(o.material)) return;
        seen.add(o.material); padFadeMats.push(o.material);
      });
    })();
    window.__pad = group;
    group.position.set(PAD_X, 0, PAD_Z);
    group.scale.setScalar(SCALE);
    group.rotation.y = -0.30;
    padLights.forEach(l => group.add(l));
    scene.add(group);

    /* ================= 灯光（世界坐标） ================= */
    {
      const mk = (lx, ly, lz, tx, ty, tz, inten, ang) => {
        const sp = new T.SpotLight(0xfff2dc, inten, 6000, ang, 0.55, 1.4);
        sp.position.set(lx, ly, lz);
        sp.target.position.set(tx, ty, tz);
        scene.add(sp); scene.add(sp.target);
      };
      mk(PAD_X + 90, 250, PAD_Z + 80, PAD_X, 420, PAD_Z, 9.0e3, 0.30);
      mk(PAD_X - 95, 230, PAD_Z + 60, PAD_X, 360, PAD_Z, 6.0e3, 0.32);
      mk(PAD_X + 15, 8, PAD_Z + 120, PAD_X, 700, PAD_Z, 4.5e3, 0.36);
    }

    // 地面硬化区
    const apron = new T.Mesh(
      new T.CircleGeometry(46, 40),
      new T.MeshStandardMaterial({ color: 0x86827a, roughness: 0.95 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(PAD_X, 0.08, PAD_Z);
    apron.receiveShadow = true;
    scene.add(apron);
  })();

  /* ---------- 10. 路灯 ---------- */
  const lampState = { mats: [], sprites: [], lights: [], pos: [] };
  (function lamps() {
    const S = 128;
    const glowC = document.createElement('canvas'); glowC.width = glowC.height = S;
    const gg = glowC.getContext('2d');
    const grd = gg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,250,240,1)');
    grd.addColorStop(0.18, 'rgba(255,244,225,0.80)');
    grd.addColorStop(0.45, 'rgba(255,236,210,0.24)');
    grd.addColorStop(1, 'rgba(255,230,200,0)');
    gg.fillStyle = grd; gg.fillRect(0, 0, S, S);
    const glowTex = new T.CanvasTexture(glowC);
    glowTex.colorSpace = T.SRGBColorSpace;

    const poleMat = new T.MeshStandardMaterial({ color: 0x51585e, metalness: 0.55, roughness: 0.55 });
    const poleGeo = new T.CylinderGeometry(0.075, 0.105, 8.2, 10);
    const armGeo = new T.CylinderGeometry(0.055, 0.055, 2.05, 8);
    const headGeo = new T.CylinderGeometry(0.42, 0.20, 0.26, 16);

    for (let i = 0; i < 15; i++) {
      const z = 12 - i * 33;
      const x = ROAD_W / 2 + 2.0;
      const grp = new T.Group();

      const headMat = new T.MeshStandardMaterial({
        color: 0xfff8e8, emissive: 0xfff0cc, emissiveIntensity: 0.0, roughness: 0.35, metalness: 0.0
      });
      lampState.mats.push(headMat);

      const pole = new T.Mesh(poleGeo, poleMat);
      pole.position.set(x, 4.1, z);
      pole.castShadow = true;
      grp.add(pole);

      const arm = new T.Mesh(armGeo, poleMat);
      arm.position.set(x - 1.0, 8.05, z);
      arm.rotation.z = Math.PI / 2 - 0.12;
      arm.castShadow = true;
      grp.add(arm);

      const head = new T.Mesh(headGeo, headMat);
      head.position.set(x - 2.0, 7.92, z);
      grp.add(head);

      const sm = new T.SpriteMaterial({
        map: glowTex, color: 0xfff0d6, transparent: true, blending: T.AdditiveBlending,
        depthWrite: false, opacity: 0.0
      });
      const sprite = new T.Sprite(sm);
      sprite.scale.set(3.2, 3.2, 1);
      sprite.position.set(x - 2.0, 7.92, z);
      grp.add(sprite);
      lampState.sprites.push(sm);

      if (i < 10) {
        const pl = new T.PointLight(0xffe9c4, 0, 34, 2.0);
        pl.position.set(x - 2.0, 7.6, z);
        grp.add(pl);
        lampState.lights.push(pl);
        lampState.pos.push(pl.position.clone());
      }
      scene.add(grp);
    }
  })();

  /* ---------- 11. 草（随相机延展） ---------- */
  const GRASS_R = 120;
  function makeBladeTex() {
    const W = 64, H = 256;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    // 单片叶子：底部宽、顶部收尖、轻微弯曲
    g.beginPath();
    g.moveTo(0, H);
    g.quadraticCurveTo(W * 0.02, H * 0.5, W * 0.50, 0);
    g.quadraticCurveTo(W * 0.98, H * 0.5, W, H);
    g.closePath();
    const grd = g.createLinearGradient(0, H, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.75, 'rgba(255,255,255,0.95)');
    grd.addColorStop(1, 'rgba(255,255,255,0.6)');
    g.fillStyle = grd;
    g.fill();
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    return t;
  }
  const bladeTex = makeBladeTex();

  const grassU = {
    uTime: { value: 0 }, uWindDir: { value: new T.Vector2(1, 0) }, uWindSpeed: { value: 20 },
    uSunDir: { value: SUN_DIR }, uSunCol: { value: new T.Color(1, 0.58, 0.32) },
    uSkyAmb: { value: new T.Color(0.32, 0.44, 0.66) }, uAmbI: { value: 1.0 },
    uFogColor: { value: FOG.color }, uFogDensity: { value: FOG.density },
    uCamPos: { value: camera.position }, uRadius: { value: GRASS_R },
    uLampPos: { value: Array.from({ length: 6 }, () => new T.Vector3()) },
    uLampCol: { value: Array.from({ length: 6 }, () => new T.Vector3()) },
    uLampN: { value: 0 }, uClipOn: { value: 0 }, uClipY: { value: -1e9 }, tBlade: { value: bladeTex }
  };
  const BFT_LO = 3.4, BFT_HI = 17.1;   // 风力 3~7 级
  function beaufort(v) {
    const t = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5];
    let b = 0;
    for (let i = 0; i < t.length; i++) if (v >= t[i]) b = i + 1;
    return b;
  }
  const wind = { speed: 20, dir: new T.Vector2(Math.cos(0.62), Math.sin(0.62)) };
  function buildGrass() {
    const CLUMPS = LOWQ ? 3200 : 9000;
    const PER = LOWQ ? 22 : 24;
    const COUNT = CLUMPS * PER;

    const verts = [], uvs = [], indices = [];
    const SEG = 3;
    for (let i = 0; i <= SEG; i++) {
      const y = i / SEG;
      const w = 0.0064 * (1 - Math.pow(y, 1.5) * 0.95) * 0.5;
      const z = 0.16 * y * y;
      verts.push(-w, y, z, w, y, z);
      uvs.push(0, y, 1, y);
    }
    for (let i = 0; i < SEG; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new T.InstancedBufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const pos = new Float32Array(COUNT * 3);
    const par = new Float32Array(COUNT * 3);
    const tint = new Float32Array(COUNT * 3);
    const rot = new Float32Array(COUNT);

    let k = 0;
    let used = 0;
    for (let c = 0; c < CLUMPS; c++) {
      const u = rand();
      const r = Math.pow(u, 2.4) * GRASS_R;   // 密度集中在近处
      const a = rand() * Math.PI * 2;
      let cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      if (Math.abs(cx) < 4.5) cx = Math.sign(cx || 1) * (4.5 + rand() * 1.1);

      // 裸土斑：世界坐标上的低频图案，约 18% 区域不长草
      if (cx < -8.5) continue;   // 左侧是海
      const bare = (Math.sin(cx * 0.13 + 1.3) + Math.sin(cz * 0.10 - 0.7) + Math.sin((cx + cz) * 0.055 + 2.1)) / 3.0;
      if (bare > 0.30) continue;

      const clumpR = 0.14 + rand() * 0.44;
      const clumpLum = 0.62 + rand() * 0.7;
      const dryC = Math.pow(rand(), 1.9);
      const nearC = Math.max(0, 1 - Math.abs(Math.abs(cx) - 5.3) / 24);

      for (let b = 0; b < PER; b++, k++) {
        const ang = rand() * Math.PI * 2;
        const rr = clumpR * Math.sqrt(rand());
        pos[k * 3] = cx + Math.cos(ang) * rr;
        pos[k * 3 + 1] = cz + Math.sin(ang) * rr;
        pos[k * 3 + 2] = rand();

        const h = 0.30 + Math.pow(rand(), 1.25) * 0.20;
        par[k * 3] = h;
        par[k * 3 + 1] = rand() * 6.283;
        par[k * 3 + 2] = 0.55 + rand() * 0.85;

        const dry = Math.min(1, dryC + (rand() - 0.5) * 0.45);
        // 少一点荧光绿：把绿色压下去、加黄褐，接近秋末海边的高草
        tint[k * 3] = (0.115 + dry * 0.205 + rand() * 0.05) * clumpLum;
        tint[k * 3 + 1] = (0.132 + nearC * 0.028 + dry * 0.118 + rand() * 0.035) * clumpLum;
        tint[k * 3 + 2] = (0.058 + dry * 0.052) * clumpLum;
        rot[k] = rand() * Math.PI * 2;
      }
    }
    geo.setAttribute('iPos', new T.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iParam', new T.InstancedBufferAttribute(par, 3));
    geo.setAttribute('iTint', new T.InstancedBufferAttribute(tint, 3));
    geo.setAttribute('iRot', new T.InstancedBufferAttribute(rot, 1));
    geo.instanceCount = Math.max(1, k);

    const mat = new T.ShaderMaterial({
      uniforms: grassU, side: T.DoubleSide, fog: false,
      vertexShader: `
        precision highp float;
        attribute vec3 iPos; attribute vec3 iParam; attribute vec3 iTint; attribute float iRot;
        uniform float uTime, uWindSpeed, uRadius; uniform vec2 uWindDir; uniform vec3 uCamPos;
        uniform vec3 uLampPos[6]; uniform vec3 uLampCol[6]; uniform int uLampN;
        varying vec3 vW; varying vec3 vN; varying vec3 vTint; varying float vY; varying vec3 vBase;
        varying vec2 vUv2;

        void main(){
          float h = iParam.x, ph = iParam.y, flex = iParam.z;
          vUv2 = uv;

          vec2 rel = mod(iPos.xy - uCamPos.xz + uRadius, 2.0*uRadius) - uRadius;
          vec3 base = vec3(uCamPos.x + rel.x, 0.0, uCamPos.z + rel.y);
          if (abs(base.x) < 4.5) base.x = sign(base.x + 0.001) * (4.5 + iPos.z * 1.2);
          h *= step(-5.2, base.x);   // 左侧是海堤，不长草

          vec3 p = position;
          p.y *= h; p.z *= h;
          float c = cos(iRot), s = sin(iRot);
          vec3 rp = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
          float leanA = iPos.z * 6.2832;
          float leanM = 0.12 + 0.28 * fract(iPos.z * 7.73);
          rp.xz += vec2(cos(leanA), sin(leanA)) * leanM * position.y * h * 0.6;

          vec2 wp = base.xz;
          float wave = sin(dot(wp, uWindDir)*0.62 - uTime*uWindSpeed*0.5 + ph*0.85);
          float wave2 = sin(dot(wp, vec2(-uWindDir.y, uWindDir.x))*1.15 + ph*2.3);
          float gustLocal = 0.70 + 0.26*wave + 0.09*wave2;

          float v = uWindSpeed * gustLocal;
          float q = 0.5 * 1.2 * v * v;
          float bend = min(q * flex * 0.0045, 1.10);
          vec2 disp = uWindDir * bend * pow(position.y, 1.7) * h;
          float fl = sin(uTime*(9.0 + flex*7.0) + ph*13.0) * 0.03 * bend * position.y;
          disp += vec2(-uWindDir.y, uWindDir.x) * fl;

          vec3 world = base + rp;
          world.xz += disp;

          float ang = bend * 0.95;
          vN = normalize(vec3(-sin(ang)*uWindDir.x, cos(ang), -sin(ang)*uWindDir.y));
          // 路边枯草带：贴路边 0~4 m 的草偏枯黄
          float edgeK = 1.0 - smoothstep(4.6, 8.5, abs(base.x));
          vTint = mix(iTint, iTint * vec3(1.55, 1.15, 0.55), edgeK * 0.55);
          vW = world; vY = position.y; vBase = base;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vW; varying vec3 vN; varying vec3 vTint; varying float vY; varying vec3 vBase;
        varying vec2 vUv2;
        uniform sampler2D tBlade;
        uniform vec3 uSunDir, uSunCol, uSkyAmb, uFogColor; uniform float uFogDensity, uAmbI; uniform vec3 uCamPos;
        uniform vec3 uLampPos[6]; uniform vec3 uLampCol[6]; uniform int uLampN;

        void main(){
          if (texture2D(tBlade, vUv2).a < 0.45) discard;
          vec3 N = normalize(vN);
          if (!gl_FrontFacing) N = -N;
          vec3 V = normalize(uCamPos - vW);

          float diff = max(dot(N, uSunDir), 0.0);
          float back = pow(max(dot(-V, uSunDir), 0.0), 3.5);
          float trans = back * smoothstep(0.1, 0.95, 1.0 - abs(dot(N, V)));

          vec3 col = vTint * (uSkyAmb * (0.55 + 0.45*max(N.y,0.0)) * 0.95 * uAmbI);
          col += vTint * uSunCol * diff * 0.95;
          col += vTint * vec3(1.35, 1.10, 0.82) * trans * 0.12 * (0.2 + 0.8*vY);
          col *= mix(0.34, 1.0, smoothstep(0.0, 0.45, vY));

          // 路灯（向四周发散的点光）
          vec3 lamp = vec3(0.0);
          for (int i = 0; i < 6; i++) {
            if (i >= uLampN) break;
            vec3 dl = uLampPos[i] - vBase;
            float d2 = dot(dl, dl) + 0.8;
            float nd = max(normalize(dl).y, 0.0);
            lamp += uLampCol[i] * (nd / d2);
          }
          col += (vTint * 1.9 + 0.05) * lamp;

          float d = length(uCamPos - vW);
          float f = 1.0 - exp(-uFogDensity*uFogDensity*d*d);
          col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const grass = new T.Mesh(geo, mat);
    window.__grass = grass;
    grass.frustumCulled = false;
    return grass;
  }
  scene.add(buildGrass());

  /* ---------- 12. 雨 ---------- */
  const RAIN_COUNT = QUAL === 'high' ? 24000 : (QUAL === 'mid' ? 15000 : 7000);
  const rainU = {
    uTime: { value: 0 }, uWind: { value: new T.Vector3(1, 0, 0) },
    uCamPos: { value: camera.position }, uOpacity: { value: 0.55 },
    uSunDir: { value: SUN_DIR }, uSunCol: { value: new T.Color(1, 0.8, 0.6) }
  };
  function makeRainTexture() {
    const W = 32, H = 128;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const gx = g.createLinearGradient(0, 0, W, 0);
    gx.addColorStop(0.0, 'rgba(255,255,255,0)');
    gx.addColorStop(0.42, 'rgba(255,255,255,0.55)');
    gx.addColorStop(0.5, 'rgba(255,255,255,1)');
    gx.addColorStop(0.58, 'rgba(255,255,255,0.55)');
    gx.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = gx; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-in';
    const gy = g.createLinearGradient(0, 0, 0, H);
    gy.addColorStop(0.0, 'rgba(255,255,255,0)');
    gy.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    gy.addColorStop(0.55, 'rgba(255,255,255,1)');
    gy.addColorStop(0.86, 'rgba(255,255,255,0.65)');
    gy.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = gy; g.fillRect(0, 0, W, H);
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = T.LinearFilter;
    t.magFilter = T.LinearFilter;
    return t;
  }
  (function buildRain() {
    const N = RAIN_COUNT;
    const pos = new Float32Array(N * 4 * 3);
    const corner = new Float32Array(N * 4 * 2);
    const uvs = new Float32Array(N * 4 * 2);
    const seeds = new Float32Array(N * 4);
    const idx = new Uint32Array(N * 6);
    const C = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < N; i++) {
      const cx = (rand() * 2 - 1) * 30, cy = rand() * 30, cz = (rand() * 2 - 1) * 30, sd = rand();
      for (let k2 = 0; k2 < 4; k2++) {
        const v = i * 4 + k2;
        pos[v * 3] = cx; pos[v * 3 + 1] = cy; pos[v * 3 + 2] = cz;
        corner[v * 2] = C[k2][0]; corner[v * 2 + 1] = C[k2][1];
        uvs[v * 2] = U[k2][0]; uvs[v * 2 + 1] = U[k2][1];
        seeds[v] = sd;
      }
      const o = i * 6, b = i * 4;
      idx[o] = b; idx[o + 1] = b + 2; idx[o + 2] = b + 1;
      idx[o + 3] = b; idx[o + 4] = b + 3; idx[o + 5] = b + 2;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new T.BufferAttribute(corner, 2));
    geo.setAttribute('uv', new T.BufferAttribute(uvs, 2));
    geo.setAttribute('aSeed', new T.BufferAttribute(seeds, 1));
    geo.setIndex(new T.BufferAttribute(idx, 1));

    const mat = new T.ShaderMaterial({
      uniforms: rainU, transparent: true, depthWrite: false,
      vertexShader: `
        precision highp float;
        attribute vec2 aCorner; attribute float aSeed;
        uniform float uTime; uniform vec3 uWind, uCamPos;
        varying vec2 vUv; varying float vA; varying float vT;

        void main(){
          vUv = uv;
          float vt = 7.6 + 4.6*fract(aSeed*17.31);
          vec3 vel = vec3(uWind.x*0.45, -vt, uWind.z*0.45);
          vec3 p = position + vel * uTime;
          vec2 c = uCamPos.xz;
          p.xz = mod(p.xz - c + 30.0, 60.0) - 30.0 + c;
          p.y = mod(p.y, 30.0) + 0.05;

          vec3 vp = (viewMatrix * vec4(p, 1.0)).xyz;
          vec3 vd = (viewMatrix * vec4(vel, 0.0)).xyz;
          vec2 d2 = vd.xy; float l2 = length(d2);
          vec2 sdir = l2 > 1e-4 ? d2 / l2 : vec2(0.0, -1.0);
          vec2 perp = vec2(-sdir.y, sdir.x);

          float len = 0.12 + 0.030*length(vel);
          float wid = 0.0075 + 0.006*fract(aSeed*5.71);
          vec2 off = sdir * (aCorner.y * len) + perp * (aCorner.x * wid);
          vp = vec3(vp.xy + off, vp.z);

          float d = length(p.xz - c);
          vA = (1.0 - smoothstep(12.0, 27.0, d)) * smoothstep(0.0, 1.2, p.y)
             * (1.0 - 0.72 * smoothstep(7.0, 22.0, p.y));
          vT = fract(aSeed*3.37);
          gl_Position = projectionMatrix * vec4(vp, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; varying float vA; varying float vT;
        uniform float uOpacity; uniform vec3 uSunCol;
        void main(){
          float x = abs(vUv.x - 0.5) * 2.0;
          float body = pow(max(0.0, 1.0 - x), 2.4);
          float core = pow(max(0.0, 1.0 - x), 10.0);
          float ends = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.60, 1.0, vUv.y));
          float a = (body * 0.50 + core * 0.95) * ends * vA * uOpacity;
          if (a < 0.004) discard;
          vec3 col = mix(vec3(0.55, 0.66, 0.88), vec3(0.95, 0.97, 1.0), vT) + core * 0.30;
          gl_FragColor = vec4(col, a);
        }`
    });
    const rain = new T.Mesh(geo, mat);
    rain.frustumCulled = false;
    scene.add(rain);
  })();

  /* ---------- 13. 地面溅落 ---------- */
  const SPLASH_COUNT = LOWQ ? 260 : 760;
  const splashU = { uTime: { value: 0 } };
  (function splashes() {
    const quad = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1]);
    const geo = new T.InstancedBufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(quad, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(SPLASH_COUNT * 3);
    const par = new Float32Array(SPLASH_COUNT * 2);
    for (let i = 0; i < SPLASH_COUNT; i++) {
      pos[i * 3] = (rand() * 2 - 1) * 3.6;
      pos[i * 3 + 1] = 0.012;
      pos[i * 3 + 2] = 14 - rand() * 44;
      par[i * 2] = rand();
      par[i * 2 + 1] = 0.30 + rand() * 0.45;
    }
    geo.setAttribute('iPos', new T.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iPar', new T.InstancedBufferAttribute(par, 2));
    geo.instanceCount = SPLASH_COUNT;
    const mat = new T.ShaderMaterial({
      uniforms: splashU, transparent: true, depthWrite: false,
      vertexShader: `
        precision highp float;
        attribute vec3 iPos; attribute vec2 iPar;
        uniform float uTime;
        varying float vA;
        void main(){
          float age = fract((uTime / iPar.y) + iPar.x);
          float s = mix(0.02, 0.24, age);
          vec3 p = iPos + position * s;
          vA = pow(1.0 - age, 2.6) * 0.42;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `precision highp float; varying float vA;
        void main(){ gl_FragColor = vec4(0.95, 0.92, 0.88, vA); }`
    });
    const m = new T.Mesh(geo, mat);
    m.frustumCulled = false;
    scene.add(m);
  })();

  /* ---------- 14. 后期 + 屏幕雨滴 ---------- */
  const DROP_MAX = 64;      // uniform 数组长度必须跟 shader 里的 [64] 一致
  const DROP_CAP = 24;      // 同时存在的水珠上限（画面上别太脏）
  const dropUniforms = {
    uDrops: { value: Array.from({ length: DROP_MAX }, () => new T.Vector4(0, 0, 0, 1)) },
    uDropAge: { value: new Float32Array(DROP_MAX) },
    uDropCount: { value: 0 },
    uAspect: { value: innerWidth / innerHeight }
  };
  const screenDrops = [];
  let dropTimer = 0;

  /* ---------- 体积光（真实光线步进，采样阴影贴图） ---------- */
  /* ---------- 体积光（屏幕空间深度步进） ---------- */
  const shaftsRT = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.LinearSRGBColorSpace });
  const shaftsMat = new T.ShaderMaterial({
    uniforms: {
      tDepth: { value: null },
      uInvProj: { value: new T.Matrix4() },
      uCamWorld: { value: new T.Matrix4() },
      uViewProj: { value: new T.Matrix4() },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: new T.Color(1, 0.85, 0.62) },
      uDensity: { value: 1.4 },
      uIntensity: { value: 1.0 },
      uMaxDist: { value: 30.0 }
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDepth;
      uniform mat4 uInvProj, uCamWorld, uViewProj;
      uniform vec3 uSunDir, uSunColor;
      uniform float uDensity, uIntensity, uMaxDist;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }


      void main() {
        float depth = texture2D(tDepth, vUv).x;
        vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 view = uInvProj * ndc;
        view /= view.w;
        vec3 wpos = (uCamWorld * view).xyz;

        float jitter = hash(vUv * 1024.0);
        float stepLen = uMaxDist / 32.0;
        vec3 p = wpos + uSunDir * stepLen * jitter;
        float lit = 0.0, dark = 0.0;

        for (int i = 0; i < 32; i++) {
          p += uSunDir * stepLen;
          vec4 cp = uViewProj * vec4(p, 1.0);
          vec3 cndc = cp.xyz / max(cp.w, 1e-4);
          vec2 suv = cndc.xy * 0.5 + 0.5;
          float seen = 1.0;
          if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float sd = texture2D(tDepth, suv).x;
            float sceneZ = sd * 2.0 - 1.0;
            seen = cndc.z > sceneZ + 0.0012 ? 0.0 : 1.0;   // 被前面几何挡住
          }
          lit += seen;
          dark += 1.0 - seen;
        }

        // 只有“部分被挡”的光线才形成可见光束；纯开阔处不出光柱
        float acc = min(lit, dark) / 32.0 * 2.0;

        vec3 V = normalize(wpos - uCamWorld[3].xyz);
        float phase = pow(max(dot(-V, uSunDir), 0.0), 3.0) * 0.85 + 0.15;
        float hFall = exp(-max(wpos.y, 0.0) * 0.02);

        vec3 col = uSunColor * acc * phase * hFall * uDensity * uIntensity;
        gl_FragColor = vec4(col, 1.0);
      }`
  });

  const post = (function () {
    const o = { type: T.HalfFloatType, colorSpace: T.LinearSRGBColorSpace };
    const MSAA = QUAL === 'high' ? 4 : (QUAL === 'mid' ? 2 : 0);
    const rtScene = new T.WebGLRenderTarget(1, 1, Object.assign({ samples: MSAA }, o));
    rtScene.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
    rtScene.depthTexture.format = T.DepthFormat;
    const rtB = new T.WebGLRenderTarget(1, 1, o);
    const rtA = new T.WebGLRenderTarget(1, 1, o);
    const rtC = new T.WebGLRenderTarget(1, 1, o);
    const rtSoft = new T.WebGLRenderTarget(1, 1, o);
    const rtSoftB = new T.WebGLRenderTarget(1, 1, o);
    const rtRays = new T.WebGLRenderTarget(1, 1, o);
    const reflRT = new T.WebGLRenderTarget(1, 1, o);
    reflRT.texture.generateMipmaps = true;
    reflRT.texture.minFilter = T.LinearMipmapLinearFilter;
    const reflCam = new T.PerspectiveCamera(55, 1, 0.1, 3000);
    const reflPlane = new T.Plane(new T.Vector3(0, 1, 0), -7.0);

    // ---- 时域降噪（TAA）与锐化用的缓冲 ----
    const rtTaa = new T.WebGLRenderTarget(1, 1, o);
    const rtHist = new T.WebGLRenderTarget(1, 1, o);
    const rtOut = new T.WebGLRenderTarget(1, 1, o);
    // 自适应曝光（照 Saltline 的 tAdapt）：8×8 亮度 → 1×1 平滑 → comp 里算 EV
    const rtLum = new T.WebGLRenderTarget(8, 8, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false });
    const rtAdapt = [new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false }),
                     new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false })];
    let adaptIdx = 0;
    const lumMat = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new T.Vector2() } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
        void main(){
          float acc = 0.0;
          for (int y = -2; y <= 2; y++) {
            for (int x = -2; x <= 2; x++) {
              vec3 c = texture2D(tSrc, vUv + vec2(float(x), float(y)) * uTexel).rgb;
              acc += dot(c, vec3(0.2126, 0.7152, 0.0722));
            }
          }
          acc /= 25.0;
          gl_FragColor = vec4(log2(max(acc, 1e-4)), 0.0, 0.0, 1.0);
        }`
    });
    const adaptMat = new T.ShaderMaterial({
      uniforms: { tLum: { value: null }, tPrev: { value: null }, uRate: { value: 0.10 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform sampler2D tLum, tPrev; uniform float uRate;
        void main(){
          float s = 0.0;
          for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
            s += texture2D(tLum, (vec2(float(x), float(y)) + 0.5) / 8.0).r;
          }
          s /= 64.0;
          float target = exp2(s);
          float prev = texture2D(tPrev, vec2(0.5)).r;
          float cur = mix(prev, target, uRate);
          gl_FragColor = vec4(cur, 0.0, 0.0, 1.0);
        }`
    });
    // SSAO：半分辨率深度 + AO + 模糊（照 Saltline 的做法：先把 depth 降到半分辨率并线性化）
    const rtDepthH = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false });
    const rtAO = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false });
    const rtAOb = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, colorSpace: T.NoColorSpace, depthBuffer: false });
    const AO_TAPS = QUAL === 'high' ? 12 : (QUAL === 'mid' ? 8 : 6);
    const depthHMat = new T.ShaderMaterial({
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
    const aoMat = new T.ShaderMaterial({
      uniforms: {
        tDepthH: { value: null }, uNear: { value: 0.1 }, uFar: { value: 3000 },
        uTanHalf: { value: new T.Vector2(1, 1) }, uTexel: { value: new T.Vector2() },
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
          vec2 ox = vec2(uTexel.x * 2.0, 0.0), oy = vec2(0.0, uTexel.y * 2.0);
          float zl = linZ(texture2D(tDepthH, vUv - ox).r), zr = linZ(texture2D(tDepthH, vUv + ox).r);
          float zd = linZ(texture2D(tDepthH, vUv - oy).r), zu = linZ(texture2D(tDepthH, vUv + oy).r);
          vec3 dx = abs(zl - z0) < abs(zr - z0) ? P - vpos(vUv - ox, zl) : vpos(vUv + ox, zr) - P;
          vec3 dy = abs(zd - z0) < abs(zu - z0) ? P - vpos(vUv - oy, zd) : vpos(vUv + oy, zu) - P;
          vec3 n = normalize(cross(dx, dy));

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
            float z2 = linZ(texture2D(tDepthH, uv2).r);
            vec3 v = vpos(uv2, z2) - P;
            float vv = dot(v, v), vn = dot(v, n);
            float f = max(R2 - vv, 0.0);
            sum += f * f * f * max((vn - (0.02 + 0.012 * z0)) / (vv + 0.01), 0.0);
          }
          float ao = clamp(1.0 - uIntensity * sum * 6.0 / (R2 * R2 * R2 * float(AO_TAPS)), 0.42, 1.0);
          ao = mix(ao, 1.0, smoothstep(180.0, 420.0, z0));
          gl_FragColor = vec4(ao, ao, ao, 1.0);
        }`
    });
    const aoBlurMat = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new T.Vector2() } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
        void main(){
          float s = texture2D(tSrc, vUv).r * 0.36;
          s += (texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).r
              + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).r + texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).r) * 0.10;
          s += (texture2D(tSrc, vUv + uTexel).r + texture2D(tSrc, vUv - uTexel).r
              + texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).r + texture2D(tSrc, vUv + vec2(-uTexel.x, uTexel.y)).r) * 0.06;
          gl_FragColor = vec4(s, s, s, 1.0);
        }`
    });
    const _vpM = new T.Matrix4(), _invVP = new T.Matrix4(), _prevVP = new T.Matrix4();
    const _taaCamera = new T.Matrix4(), _taaProjection = new T.Matrix4();
    let taaValid = 0, taaCameraReady = false;
    const halton = (i, b) => { let f = 1, r = 0; i = i + 1; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

    const taaMat = new T.ShaderMaterial({
      uniforms: {
        tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
        uInvVP: { value: new T.Matrix4() }, uPrevVP: { value: new T.Matrix4() },
        uTexel: { value: new T.Vector2() }, uBlend: { value: 0.995 }, uValid: { value: 0 }
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
          // 3x3 邻域包围盒：把历史色夹进去，防拖影
          vec3 mn = cur, mx = cur;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              if (x == 0 && y == 0) continue;
              vec3 sv = texture2D(tCur, vUv + vec2(float(x), float(y)) * uTexel).rgb;
              mn = min(mn, sv); mx = max(mx, sv);
            }
          }
          float d = texture2D(tDepth, vUv).x;
          vec4 pc = uPrevVP * vec4(wpos(vUv, d), 1.0);
          vec2 puv = pc.xy / max(abs(pc.w), 1e-6) * 0.5 + 0.5;
          vec4 hs = texture2D(tHist, clamp(puv, 0.001, 0.999));
          vec3 hist = hs.rgb;
          if (!(hist.r >= 0.0) || !(hist.g >= 0.0) || !(hist.b >= 0.0)) hist = cur;
          hist = min(hist, vec3(32.0));
          float prevDepth = pc.z / max(abs(pc.w), 1e-6) * 0.5 + 0.5;
          float depthError = abs(hs.a - prevDepth);
          float depthTolerance = max(0.00012, fwidth(d) * 4.0);
          bool bad = uValid < 0.5 ||
            puv.x < 0.002 || puv.x > 0.998 || puv.y < 0.002 || puv.y > 0.998 || pc.w <= 0.0;
          if (bad) hist = cur;
          vec3 spread = (mx - mn) * 0.35 + vec3(0.01);
          vec3 clipped = clamp(hist, mn - spread, mx + spread);
          float clipAmount = 0.0;
          hist = mix(hist, clipped, clipAmount);
          float w = uBlend * (1.0 - clipAmount * 0.85);
          float motionPx = length((puv - vUv) / uTexel);
          w *= 1.0;
          if (bad) w = 0.0;
          gl_FragColor = vec4(mix(cur, hist, w), d);
        }`
    });
    const copyMat = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tSrc; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`
    });
    window.__taa = taaMat; window.__rtTaa = rtTaa; window.__rtHist = rtHist;
    window.__rtAOb = rtAOb; window.__rtAO = rtAO; window.__rtDepthH = rtDepthH;
    setTimeout(() => { window.__comp = comp; }, 0);
    // 对比自适应锐化（在显示空间做，过冲比纯 USM 小）
    const sharpMat = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new T.Vector2() }, uStrength: { value: 0.42 }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uStrength, uTime;
        void main() {
          vec3 e = texture2D(tSrc, vUv).rgb;
          vec3 a = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
          vec3 b = texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb;
          vec3 c = texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
          vec3 d = texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb;
          vec3 blur = (a + b + c + d) * 0.25;
          vec3 mn = min(min(a, b), min(c, d));
          vec3 mx = max(max(a, b), max(c, d));
          float flat_ = 1.0 - clamp(dot(mx - mn, vec3(0.3333)), 0.0, 1.0);
          vec3 outc = e + (e - blur) * uStrength * (0.35 + 0.65 * flat_);
          gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
        }`
    });

    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    const fsScene = new T.Scene(); fsScene.add(quad);

    const bright = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThresh: { value: 1.4 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tSrc; uniform float uThresh;
        void main(){ vec3 c = texture2D(tSrc,vUv).rgb; float l = dot(c,vec3(.2126,.7152,.0722));
          gl_FragColor = vec4(c*smoothstep(uThresh,uThresh+1.1,l),1.); }`
    });
    const blur = new T.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new T.Vector2() }, uTexel: { value: new T.Vector2() } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir,uTexel;
        void main(){ vec3 s = texture2D(tSrc,vUv).rgb*.227;
          s += texture2D(tSrc,vUv+uDir*uTexel*1.384).rgb*.316;
          s += texture2D(tSrc,vUv-uDir*uTexel*1.384).rgb*.316;
          s += texture2D(tSrc,vUv+uDir*uTexel*3.23).rgb*.070;
          s += texture2D(tSrc,vUv-uDir*uTexel*3.23).rgb*.070;
          gl_FragColor = vec4(s,1.); }`
    });
    const rays = new T.ShaderMaterial({
      uniforms: {
        tSrc: { value: null }, uSunUV: { value: new T.Vector2(0.5, 0.5) },
        uDensity: { value: 0.26 }, uWeight: { value: 0.7 }, uDecay: { value: 0.93 }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
      fragmentShader: `precision highp float; varying vec2 vUv;
        uniform sampler2D tSrc; uniform vec2 uSunUV; uniform float uDensity, uWeight, uDecay;
        void main(){
          vec2 delta = (vUv - uSunUV) * uDensity / 24.0;
          vec2 cur = vUv;
          float illum = 1.0;
          vec3 acc = vec3(0.0);
          for (int i = 0; i < 24; i++) {
            cur -= delta;
            acc += texture2D(tSrc, clamp(cur, 0.0, 1.0)).rgb * illum * uWeight;
            illum *= uDecay;
          }
          acc *= exp(-length(vUv - uSunUV) * 2.2);
          gl_FragColor = vec4(acc / 24.0, 1.0);
        }`
    });

    const comp = new T.ShaderMaterial({
      uniforms: Object.assign({
        tScene: { value: rtScene.texture }, tBloom: { value: rtC.texture }, tAO: { value: null }, uAO: { value: 1.0 },
        tSoft: { value: rtSoftB.texture }, tRays: { value: rtRays.texture },
        tCube: { value: cubeRT.texture },
        uCamWorld: { value: new T.Matrix4() },
        uTanHalf: { value: new T.Vector2(1, 1) },
        uExposure: { value: 1.34 }, uBloom: { value: 0.32 }, uRaysI: { value: 0.0 },
        tShafts: { value: null }, uShaftI: { value: 0.26 },
        uTime: { value: 0 }, uRes: { value: new T.Vector2(1, 1) }, uTone: { value: 0.0 },
        tAdapt: { value: null }, uKey: { value: 0.22 }, uMinE: { value: 0.88 }, uMaxE: { value: 1.12 }, uAuto: { value: 1.0 },
        uDropLight: { value: new T.Color(0.95, 0.93, 0.9) }
      }, dropUniforms),
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tScene, tBloom, tSoft, tRays, tShafts, tAO; uniform float uAO;
        uniform float uShaftI;
        uniform samplerCube tCube;
        uniform mat4 uCamWorld; uniform vec2 uTanHalf;
        uniform float uExposure, uBloom, uRaysI, uTime, uAspect, uTone; uniform vec2 uRes;
        uniform sampler2D tAdapt; uniform float uKey, uMinE, uMaxE, uAuto;
        uniform vec4 uDrops[64]; uniform float uDropAge[64]; uniform int uDropCount; uniform vec3 uDropLight;

        vec3 aces(vec3 x){ float a=2.51,b=.03,c=2.43,d=.59,e=.14;
          return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.,1.); }
        // ---- AgX（取自 three r180 的 tonemapping_pars_fragment，Saltline 用的就是它）----
        const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
          vec3(1.6605,-0.1246,-0.0182), vec3(-0.5876,1.1329,-0.1006), vec3(-0.0728,-0.0083,1.1187));
        const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
          vec3(0.6274,0.0691,0.0164), vec3(0.3293,0.9195,0.0880), vec3(0.0433,0.0113,0.8956));
        vec3 agxContrast(vec3 x){
          vec3 x2 = x*x; vec3 x4 = x2*x2;
          return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
        }
        vec3 agx(vec3 color){
          const mat3 inM = mat3(
            vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
            vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
            vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
          const mat3 outM = mat3(
            vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
            vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
            vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
          const float minEv = -12.47393, maxEv = 4.026069;
          color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
          color = inM * color;
          color = max(color, 1e-10);
          color = log2(color);
          color = (color - minEv) / (maxEv - minEv);
          color = clamp(color, 0.0, 1.0);
          color = agxContrast(color);
          color = outM * color;
          color = pow(max(vec3(0.0), color), vec3(2.2));
          color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
          return clamp(color, 0.0, 1.0);
        }
        float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
        float vn2c(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm2c(vec2 p){ float s=0.0, a=0.5;
          for (int i = 0; i < 3; i++) { s += vn2c(p)*a; p *= 2.07; a *= 0.5; } return s; }

        // 真实水珠不是圆：边缘有表面张力形成的不规则起伏
        float dropSDF(vec2 qv, float seed) {
          float a = atan(qv.y, qv.x);
          float w = 0.045 * sin(a * 2.7 + seed * 2.1)
                  + 0.030 * sin(a * 4.3 - seed * 1.3)
                  + 0.018 * sin(a * 7.1 + seed * 3.7);
          return length(qv) / (1.0 + w);
        }

        void main(){
          vec2 uv = vUv;
          vec2 warp = vec2(0.0);
          float rim = 0.0, hi = 0.0, cover = 0.0, caustic = 0.0;
          vec3 dropEnv = vec3(0.0);
          float dropW = 0.0;

          vec3 nrm = normalize(vec3((uv.x * 2.0 - 1.0) * uTanHalf.x, (uv.y * 2.0 - 1.0) * uTanHalf.y, -1.0));
          vec3 Vw = normalize((uCamWorld * vec4(nrm, 0.0)).xyz);

          for (int i = 0; i < 64; i++) {
            if (i >= uDropCount) break;
            vec4 dr = uDrops[i];
            float stretch = max(dr.w, 1.0);
            vec2 p = (uv - dr.xy) * vec2(uAspect, 1.0);
            p /= max(dr.z, 1e-4);

            vec2 q = p;
            q.y += 0.10;                                   // 重力下垂
            q.x *= 1.0 + 0.10 * smoothstep(-0.2, 1.0, q.y);
            q.y *= 1.0 / (1.0 + (stretch - 1.0) * 0.75);   // 下滑拉长
            float flatAmt = clamp((dr.z - 0.018) / 0.022, 0.0, 1.0);
            q.y *= 1.0 + flatAmt * 0.55;                   // 大滴摊开）
            float seed = float(i) * 1.7;
            bool tiny = dr.z < 0.0045;
            // 撞击瞬间：0.16s 内处于「炸开」状态
            float burst = (1.0 - smoothstep(0.0, 0.16, uDropAge[i])) * (tiny ? 0.0 : 1.0);
            float burstR = 1.0 + burst * 0.34;
            if (dot(q, q) < 1.9 * burstR * burstR) {
              float rad = dropSDF(q / burstR, seed);
              if (rad < 1.0) {
              // 炸开时轮廓放射状碎裂
              float aa = atan(q.y, q.x);
              rad += burst * (0.085 * sin(aa * 7.0 + seed * 4.0)
                             + 0.055 * sin(aa * 13.0 - seed * 2.3))
                         * smoothstep(0.25, 0.95, rad);
              float z = pow(max(0.0, 1.0 - min(rad, 1.0) * min(rad, 1.0)), 0.70 - burst * 0.13);
              float e2 = 0.03;
              float gx = (dropSDF(q + vec2(e2, 0.0), seed) - dropSDF(q - vec2(e2, 0.0), seed)) / (2.0 * e2);
              float gy = (dropSDF(q + vec2(0.0, e2), seed) - dropSDF(q - vec2(0.0, e2), seed)) / (2.0 * e2);
              vec2 grad = vec2(gx, gy);
              vec3 n = normalize(vec3(grad, max(0.42, sqrt(max(0.0, 1.0 - min(dot(grad, grad), 1.0))))));

              float contact = smoothstep(0.93, 1.0, rad);
              float edge = clamp(1.0 - rad, 0.0, 1.0);
              cover = max(cover, smoothstep(1.0, 0.86, rad));
              warp += n.xy * dr.z * (0.5 + 1.2 * edge);

              vec3 Nw = normalize((uCamWorld * vec4(n, 0.0)).xyz);
              float k = smoothstep(0.98, 0.62, rad);
              if (tiny) {
                // 飞溅小珠：只做轻微偏折 + 亮边，省掉折射采样
                warp += n.xy * dr.z * 0.5;
                rim += edge * 0.85;
                hi += exp(-pow(length(p + vec2(0.25, 0.3)) / 0.5, 2.0)) * 0.30;
                cover = max(cover, smoothstep(1.0, 0.8, rad) * 0.6);
              } else {
              // 真实水珠是「贴在玻璃上的透镜」：折射的是背后的画面，不是反射
              vec2 lensOff = n.xy * dr.z * (2.2 + 1.6 * edge);
              vec3 lensCol = texture2D(tSoft, clamp(uv + lensOff, 0.002, 0.998)).rgb;
              // 轻微色散
              float disp = texture2D(tSoft, clamp(uv + lensOff * 1.10, 0.002, 0.998)).r;
              lensCol.r = mix(lensCol.r, disp, 0.35);
              // 只有很小一部分来自环境反射（镜面高光）
              vec3 envS = textureCube(tCube, refract(-Vw, Nw, 0.92)).rgb;
              dropEnv += (lensCol * 1.02 + envS * 0.16) * k * (1.0 - contact * 0.55);
              dropW += k;
              }

              float ring = smoothstep(0.70, 0.96, edge) * (1.0 - smoothstep(0.96, 1.0, edge));
              float shade = mix(0.50, 1.15, smoothstep(-1.0, 1.0, n.y));
              vec2 ld = normalize(vec2(-0.55, 0.62));
              float cres = pow(max(dot(normalize(p + 1e-5), ld), 0.0), 2.0) * smoothstep(0.45, 0.92, edge);
              rim += cres * (0.55 + burst * 0.32) + ring * shade * (0.35 + burst * 0.18) + contact * 0.22;
              float hlt = exp(-pow(length(p - vec2(-0.30, 0.34)) / 0.13, 2.0));
              hi += hlt * 0.55 + pow(max(dot(n, normalize(vec3(-0.5, 0.6, 0.62))), 0.0), 90.0) * 0.22;
              caustic += pow(max(0.0, -n.y), 2.2) * pow(z, 1.2) * 0.7;
              }
            }
          }

          vec3 col = texture2D(tScene, clamp(uv + warp, 0.001, 0.999)).rgb;
          // 环境光遮蔽：只压暗被挡住的接触区，让物体真正"落地"
          float aoV = texture2D(tAO, clamp(uv + warp * 0.3, 0.002, 0.998)).r;
          col *= mix(1.0, aoV, uAO);
          vec3 soft = texture2D(tSoft, clamp(uv + warp * 1.15, 0.001, 0.999)).rgb;
          col = mix(col, soft * 1.15, cover * 0.20);

          // ---- 水膜 / 流水痕：整屏低对比的湿润层 ----
          vec2 wuv = uv * vec2(3.1, 1.7) + vec2(0.0, -uTime * 0.028);
          float wn1 = fbm2c(wuv);
          float wn2 = fbm2c(uv * vec2(8.5, 4.2) + vec2(0.0, -uTime * 0.050));
          float film = smoothstep(0.40, 0.74, wn1 * 0.62 + wn2 * 0.38);

          // 沿玻璃向下流的细水痕
          float sline = fbm2c(vec2(uv.x * 34.0, uv.y * 1.3 - uTime * 0.06) + 3.1);
          float streak = smoothstep(0.50, 0.74, sline) * smoothstep(0.90, 0.25, uv.y);

          vec2 fOff = vec2((wn2 - 0.5) * 0.014, -0.0022) * (0.55 + 0.9 * film);
          vec3 filmCol = texture2D(tSoft, clamp(uv + fOff, 0.003, 0.997)).rgb;
          col = mix(col, filmCol * 1.05, film * 0.10 + streak * 0.06);
          col += (film * 0.035 + streak * 0.020) * uDropLight;

          if (dropW > 0.001) {
            vec3 envCol = dropEnv / dropW;
            col = mix(col, envCol * 0.96, clamp(dropW, 0.0, 1.0) * 0.46);
          }

          col += texture2D(tBloom, uv).rgb * uBloom;
          col += texture2D(tRays, uv).rgb * uRaysI;
          col += texture2D(tShafts, uv).rgb * uShaftI;
          col += rim * uDropLight * 0.18;
          col += hi * vec3(1.0, 0.99, 0.96) * 0.95;
          col += caustic * uDropLight * 0.20;

          // 自适应曝光：key / 平均亮度，0.85 的幂让高光更不容易糊
          float adaptLum = texture2D(tAdapt, vec2(0.5)).r;
          float evAuto = clamp(pow(uKey / max(adaptLum, 1e-4), 0.85), uMinE, uMaxE);
          float ev = uExposure * mix(1.0, evAuto, uAuto);
          col = uTone > 0.5 ? agx(col * ev) : aces(col * ev);
          col = clamp((col - 0.46) * 1.04 + 0.46, 0.0, 1.0);
          // 提一点黑位（纯黑占 13% 会让画面发闷），同时压一点点高光肩部
          col = col * 0.965 + 0.012;
          col = col - col * col * col * 0.06;
          float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(luma), col, 0.96);
          vec2 d = vUv - 0.5;
          col *= 1.0 - 0.24*pow(clamp(length(d)*1.42,0.,1.), 2.0);
          col += (hash(vUv*uRes + uTime)-0.5)*0.008;
          gl_FragColor = vec4(pow(clamp(col,0.,1.), vec3(1./2.2)), 1.);
        }`
    });
    function pass(m, target) { quad.material = m; renderer.setRenderTarget(target); renderer.render(fsScene, quadCam); }
    function resize(w, h) {
      taaValid = 0;
      rtScene.setSize(w, h);
      const bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
      rtB.setSize(bw, bh); rtA.setSize(bw, bh); rtC.setSize(bw, bh);
      rtRays.setSize(Math.max(2, bw >> 1), Math.max(2, bh >> 1));
      rtSoft.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
      rtSoftB.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
      if (rtScene.depthTexture) { rtScene.depthTexture.image.width = w; rtScene.depthTexture.image.height = h; rtScene.depthTexture.needsUpdate = true; }
      shaftsRT.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
      reflRT.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
      rtTaa.setSize(w, h); rtHist.setSize(w, h); rtOut.setSize(w, h);
      const aw = Math.max(2, w >> 1), ah = Math.max(2, h >> 1);
      rtDepthH.setSize(aw, ah); rtAO.setSize(aw, ah); rtAOb.setSize(aw, ah);
      aoMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      aoBlurMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      comp.uniforms.uRes.value.set(w, h);
      comp.uniforms.uAspect.value = w / h;
      if (window.__seaU) window.__seaU.uRes.value.set(w, h);
    }
    const sunUV = new T.Vector3();
    let frameN = 0;
    let reflHidden = null;
    let reflWarm = 0;
    function collectReflHidden() {
      const out = [];
      scene.traverse(o => {
        if (o.isPoints || o.isSprite) out.push(o);
        else if (o.isMesh && o.material && o.material.transparent) out.push(o);
      });
      reflHidden = out;
    }
    function render(t) {
      camera.updateMatrixWorld();
      let cameraChanged = false;
      if (taaCameraReady) {
        const cm = camera.matrixWorld.elements, pm = camera.projectionMatrix.elements;
        const pc = _taaCamera.elements, pp = _taaProjection.elements;
        for (let i = 0; i < 16; i++) {
          if (Math.abs(cm[i] - pc[i]) > 1e-7 || Math.abs(pm[i] - pp[i]) > 1e-7) {
            cameraChanged = true;
            break;
          }
        }
      }
      _taaCamera.copy(camera.matrixWorld);
      _taaProjection.copy(camera.projectionMatrix);
      taaCameraReady = true;
      const taaActive = USE_TAA;
      const pe = camera.projectionMatrix.elements;
      const jx = taaActive ? (halton(frameN, 2) - 0.5) * 1.4 / Math.max(rtScene.width, 2) : 0;
      const jy = taaActive ? (halton(frameN, 3) - 0.5) * 1.4 / Math.max(rtScene.height, 2) : 0;
      pe[8] += jx; pe[9] += jy;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      _vpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _invVP.copy(_vpM).invert();

      // 每帧只算一次阴影贴图（反射那一趟不再重算）
      if (!window.__shadowAuto) renderer.shadowMap.autoUpdate = false;
      const seaObj = window.__sea;
      // ★ 第一帧不能先跑反射 pass：那会让一部分材质在"影子贴图还没生成/环境图还没烘好"的
      //   状态下编译出错误的 program 变体，之后主画面里那些物体就再也不出现了
      //   （表现：路面/护栏/发射塔/树整片消失，只在天空留下几根漂浮虚线）。
      //   先让主画面完整渲染两帧，再开反射。
      if (reflWarm < 2) reflWarm++;
      if (seaObj && !NOREFL && reflWarm >= 2 && !window.__skipUR && !window.__forceNoRefl && updateReflection()) {
        if (!reflHidden) collectReflHidden();
        seaObj.visible = false;
        if (!window.__noHideRefl) for (let i = 0; i < reflHidden.length; i++) reflHidden[i].visible = false;
        window.__seaU.uTexMatrix.value.copy(_texMat);
        window.__seaU.uReflTexel.value.set(1 / reflRT.width, 1 / reflRT.height);
        if (!window.__skipReflRender) {
          renderer.setRenderTarget(reflRT);
          renderer.clear();
          renderer.render(scene, reflCam);
        }
        if (!window.__noHideRefl) for (let i = 0; i < reflHidden.length; i++) reflHidden[i].visible = true;
        seaObj.visible = true;
        window.__seaU.tReflect.value = reflRT.texture;
        window.__seaU.uReflValid.value = 1.0;
      } else if (window.__seaU) {
        window.__seaU.uReflValid.value = 0.0;
      }

      if (!window.__shadowAuto) renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(rtScene); renderer.clear();
      renderer.render(scene, camera);
      window.__calls = renderer.info.render.calls;
      window.__tris = renderer.info.render.triangles;

      // 还原未抖动投影（供后期用）
      pe[8] -= jx; pe[9] -= jy;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      // 静止画面使用 MSAA，避免固定机位下的时间性闪烁。
      if (!taaActive) {
        copyMat.uniforms.tSrc.value = rtScene.texture; pass(copyMat, rtTaa);
        _prevVP.copy(_vpM);
        taaValid = 0;
      } else {
      taaMat.uniforms.tCur.value = rtScene.texture;
      taaMat.uniforms.tHist.value = rtHist.texture;
      taaMat.uniforms.tDepth.value = rtScene.depthTexture;
      taaMat.uniforms.uInvVP.value.copy(_invVP);
      taaMat.uniforms.uPrevVP.value.copy(_prevVP);
      taaMat.uniforms.uTexel.value.set(1 / rtScene.width, 1 / rtScene.height);
      taaMat.uniforms.uValid.value = taaValid;
      pass(taaMat, rtTaa);
      _prevVP.copy(_vpM);
      taaValid = 1;
      // 历史 = 本帧结果
      copyMat.uniforms.tSrc.value = rtTaa.texture; pass(copyMat, rtHist);
      }

      blur.uniforms.tSrc.value = rtTaa.texture;
      blur.uniforms.uTexel.value.set(2 / rtScene.width, 2 / rtScene.height);
      blur.uniforms.uDir.value.set(1, 0); pass(blur, rtSoft);
      blur.uniforms.tSrc.value = rtSoft.texture;
      blur.uniforms.uDir.value.set(0, 1); pass(blur, rtSoftB);

      // ---- SSAO ----
      depthHMat.uniforms.tDepth.value = rtScene.depthTexture;
      pass(depthHMat, rtDepthH);
      aoMat.uniforms.tDepthH.value = rtDepthH.texture;
      aoMat.uniforms.uNear.value = camera.near;
      aoMat.uniforms.uFar.value = camera.far;
      const thh = Math.tan(camera.fov * Math.PI / 360);
      aoMat.uniforms.uTanHalf.value.set(thh * camera.aspect, thh);
      aoMat.uniforms.uAspect.value = camera.aspect;
      pass(aoMat, rtAO);
      aoBlurMat.uniforms.tSrc.value = rtAO.texture;
      pass(aoBlurMat, rtAOb);
      // ---- 自适应曝光 ----
      lumMat.uniforms.tSrc.value = rtTaa.texture;
      lumMat.uniforms.uTexel.value.set(1.5 / rtTaa.width, 1.5 / rtTaa.height);
      pass(lumMat, rtLum);
      const prevAdapt = rtAdapt[adaptIdx], nextAdapt = rtAdapt[1 - adaptIdx];
      adaptMat.uniforms.tLum.value = rtLum.texture;
      adaptMat.uniforms.tPrev.value = prevAdapt.texture;
      adaptMat.uniforms.uRate.value = 0.12;
      pass(adaptMat, nextAdapt);
      adaptIdx = 1 - adaptIdx;
      comp.uniforms.tAdapt.value = nextAdapt.texture;

      comp.uniforms.tAO.value = rtAOb.texture;
      comp.uniforms.tScene.value = rtTaa.texture;
      bright.uniforms.tSrc.value = rtTaa.texture; pass(bright, rtB);
      const bw = rtB.width, bh = rtB.height;
      blur.uniforms.uTexel.value.set(1 / bw, 1 / bh);
      blur.uniforms.tSrc.value = rtB.texture; blur.uniforms.uDir.value.set(1, 0); pass(blur, rtA);
      blur.uniforms.tSrc.value = rtA.texture; blur.uniforms.uDir.value.set(0, 1); pass(blur, rtC);
      blur.uniforms.tSrc.value = rtC.texture; blur.uniforms.uDir.value.set(1, 0); pass(blur, rtA);
      blur.uniforms.tSrc.value = rtA.texture; blur.uniforms.uDir.value.set(0, 1); pass(blur, rtC);

      // 体积光步进（半分辨率）
      if (!NOSHAFTS && sunLight.shadow && sunLight.shadow.map) {
        shaftsMat.uniforms.tDepth.value = rtScene.depthTexture;
        shaftsMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
        shaftsMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
        shaftsMat.uniforms.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        shaftsMat.uniforms.uSunColor.value.copy(sunLight.color);
        pass(shaftsMat, shaftsRT);
        comp.uniforms.tShafts.value = shaftsRT.texture;
      }

      const firstFrame = frameN === 0;
      frameN++;
      const cubeEvery = QUAL === 'high' ? 3 : (QUAL === 'mid' ? 5 : 8);
      if (frameN % cubeEvery === 0) {
        cubeCam.position.copy(camera.position);
        cubeCam.update(renderer, scene);
      }
      comp.uniforms.uCamWorld.value.copy(camera.matrixWorld);
      const th = Math.tan(camera.fov * Math.PI / 360);
      comp.uniforms.uTanHalf.value.set(th * camera.aspect, th);

      sunUV.copy(SUN_DIR).multiplyScalar(1000).add(camera.position).project(camera);
      const onScreen = sunUV.z < 1 && Math.abs(sunUV.x) < 1.6 && Math.abs(sunUV.y) < 1.6;
      comp.uniforms.uRaysI.value = onScreen ? 0.10 : 0.0;
      rays.uniforms.uSunUV.value.set(sunUV.x * 0.5 + 0.5, sunUV.y * 0.5 + 0.5);
      rays.uniforms.tSrc.value = rtC.texture;
      pass(rays, rtRays);

      if (!window.__reflRT) window.__reflRT = reflRT;
      comp.uniforms.uTime.value = t;
      sharpMat.uniforms.tSrc.value = rtOut.texture;
      sharpMat.uniforms.uTexel.value.set(1 / rtOut.width, 1 / rtOut.height);
      if (NOPOST) { copyMat.uniforms.tSrc.value = rtTaa.texture; pass(copyMat, null); }
      else { pass(comp, rtOut); pass(sharpMat, null); }
      if (firstFrame) {
        const boot = document.getElementById('boot');
        if (boot) {
          boot.classList.add('done');
          setTimeout(() => boot.remove(), 400);
        }
        window.__ready = true;
      }
    }
    resize(innerWidth, innerHeight);
    window.__rt = rtScene;
    window.__px = function (x, y) {
      const b = new Uint16Array(4);
      renderer.readRenderTargetPixels(rtScene, x | 0, rtScene.height - 1 - (y | 0), 1, 1, b);
      const f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
        return e === 0 ? s * Math.pow(2, -14) * (m / 1024) : (e === 31 ? (m ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + m / 1024)); };
      return [f(b[0]), f(b[1]), f(b[2]), f(b[3])];
    };
    window.__pxAvg = function (x, y, r) {
      let s = [0, 0, 0];
      const b = new Uint16Array(4);
      let n = 0;
      for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
        renderer.readRenderTargetPixels(rtScene, (x + dx) | 0, rtScene.height - 1 - ((y + dy) | 0), 1, 1, b);
        for (let k = 0; k < 3; k++) { const h = b[k]; const sgn = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
          s[k] += e === 0 ? sgn * Math.pow(2, -14) * (m / 1024) : sgn * Math.pow(2, e - 15) * (1 + m / 1024); }
        n++;
      }
      return s.map(v => v / n);
    };
    return { render, resize };
  })();

  /* ---------- 昼夜驱动 ---------- */
  const COL = {
    dayZenith: new T.Color(0x3f7fc4), dayMid: new T.Color(0x6b98cc),
    dayCool: new T.Color(0x9dbfe0), dayWarm: new T.Color(0xffd7a6),
    duskZenith: new T.Color(0x2a5f9e), duskMid: new T.Color(0x7d88b0),
    duskCool: new T.Color(0xc98a72), duskWarm: new T.Color(0xff6a1e),
    nightZenith: new T.Color(0x05080f), nightMid: new T.Color(0x0a1222),
    nightCool: new T.Color(0x121a26), nightWarm: new T.Color(0x1b2434),
    fogDay: new T.Color(0xa9b6c4), fogNight: new T.Color(0x0c1220)
  };
  const tmpC1 = new T.Color();
  let SKY_LIGHTW = 0;

  function updateSkyAndLight() {
    const s = Math.sin(sunElev);
    const dayW = smoothstep(-0.03, 0.12, s);
    const nightW = 1 - smoothstep(-0.16, 0.0, s);
    const duskW = Math.exp(-Math.pow(s / 0.19, 2));
    const lightW = smoothstep(-0.22, 0.10, s);
    SKY_LIGHTW = lightW;

    skyU.uZenith.value.copy(COL.nightZenith).lerp(COL.dayZenith, dayW).lerp(COL.duskZenith, duskW * 0.85);
    skyU.uMid.value.copy(COL.nightMid).lerp(COL.dayMid, dayW).lerp(COL.duskMid, duskW * 0.8);
    skyU.uCool.value.copy(COL.nightCool).lerp(COL.dayCool, dayW).lerp(COL.duskCool, duskW * 0.85);
    skyU.uWarm.value.copy(COL.nightWarm).lerp(COL.dayWarm, dayW).lerp(COL.duskWarm, duskW * (1 - dayW * 0.55));

    skyU.uSunDisk.value = clamp(dayW * 1.15, 0, 1.4) * (1 + duskW * 0.5);
    skyU.uMoonDisk.value = clamp(nightW * 1.1, 0, 1.0) * 0.9;
    skyU.uNight.value = nightW;
    pebbleNightU.value = nightW;

    sunLight.intensity = 5.2 + 6.4 * Math.pow(Math.max(s, 0), 0.55);
    sunLight.color.setRGB(1.0, lerp(0.55, 0.94, clamp(s * 2.4, 0, 1)), lerp(0.30, 0.86, clamp(s * 2.4, 0, 1)));

    moonLight.intensity = 0.85 * Math.pow(Math.max(-s, 0), 0.7);
    moonLight.position.copy(MOON_DIR).multiplyScalar(220);

    hemi.intensity = lerp(0.26, 0.92, lightW);
    hemi.color.set(0x9dbde0).lerp(new T.Color(0x18243a), nightW);
    hemi.groundColor.set(0x45402c).lerp(new T.Color(0x0a0c10), nightW);

    FOG.color.copy(COL.fogNight).lerp(COL.fogDay, dayW);
    FOG.density = lerp(0.0030, 0.0011, dayW);
    scene.fog.density = FOG.density;
    grassU.uFogDensity.value = FOG.density;
    groundU.uFogDensity.value = FOG.density;
    scene.fog.color.copy(FOG.color);
    groundU.uFogColor.value.copy(FOG.color);
    grassU.uFogColor.value.copy(FOG.color);

    grassU.uSunCol.value.copy(sunLight.color).multiplyScalar(clamp(dayW * 1.2, 0.05, 1.4));
    grassU.uAmbI.value = lerp(0.18, 1.0, lightW);
    grassU.uSkyAmb.value.set(0x4a6b96).lerp(new T.Color(0x16223a), nightW);
    groundU.uSunCol.value.copy(sunLight.color).multiplyScalar(clamp(dayW, 0.03, 1));
    groundU.uAmbI.value = lerp(0.12, 1.0, lightW);
    groundU.uAmb.value.set(0x4a6b96).lerp(new T.Color(0x141e30), nightW);
    rainU.uSunCol.value.copy(sunLight.color);
    scene.environmentIntensity = 0.10 + 0.15 * lightW;

    // 云：白天冷白、黄昏暖橙、夜里近乎黑
    const litDay = new T.Color(1.55, 1.62, 1.75);
    const litDusk = new T.Color(2.05, 1.00, 0.58);
    const litNight = new T.Color(0.045, 0.055, 0.085);
    const shadeDay = new T.Color(0.34, 0.40, 0.54);
    const shadeDusk = new T.Color(0.10, 0.12, 0.20);
    const shadeNight = new T.Color(0.010, 0.012, 0.020);
    tmpC1.copy(litNight).lerp(litDay, dayW).lerp(litDusk, duskW * 0.75);
    const cLit = tmpC1.clone();
    tmpC1.copy(shadeNight).lerp(shadeDay, dayW).lerp(shadeDusk, duskW * 0.7);
    for (const cu of cloudsU) {
      cu.uLit.value.copy(cLit).multiplyScalar(0.30 + 0.55 * dayW);
      cu.uShade.value.copy(tmpC1);
      cu.uOpacity.value = (0.35 + 0.65 * dayW) * cu._baseOpacity;
    }

    const lampOn = smoothstep(7.0, 0.5, T.MathUtils.radToDeg(sunElev));
    for (const m of lampState.mats) m.emissiveIntensity = 0.02 + 4.2 * lampOn;
    for (const sm of lampState.sprites) sm.opacity = 0.55 * lampOn;
    for (const pl of lampState.lights) pl.intensity = 260 * lampOn;
  }

  updateCelestial();
  updateSkyAndLight();
  envRT = pmrem.fromScene(skyOnly, 0.0, 1, 3000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.45;

  const NO_DROPS = Q.get('nodrops') === '1';
  const QA_AGE = Q.has('dropage') ? parseFloat(Q.get('dropage')) : 1.3;
  const NO_METEOR = Q.get('nometeor') === '1';
  function updateScreenDrops(dt) {
    if (NO_DROPS) { dropUniforms.uDropCount.value = 0; return; }
    dropTimer -= dt;
    if (dropTimer <= 0 && screenDrops.length < DROP_CAP) {
      dropTimer = 1.1 + Math.random() * 1.8;
      const slide = Math.random() < 0.55;
      const bx = 0.05 + Math.random() * 0.90;
      const by = 0.22 + Math.random() * 0.74;
      screenDrops.push({
        x: bx, y: by,
        r: 0.007 + Math.random() * 0.009,
        age: 0, life: 2.6 + Math.random() * 3.6,
        vy: slide ? 0.16 + Math.random() * 0.16 : 0, vx: 0, vspread: 0,
        slide, stretch: slide ? 1.25 : 1.0
      });
      // 撞击：粒子式飞溅（真实子滴，不是靠轮廓谐波）
      const sats = 4 + Math.floor(Math.random() * 5);
      for (let k = 0; k < sats; k++) {
        const a = Math.random() * 6.283;
        const dist = 0.008 + Math.random() * 0.026;
        const spd = 0.24 + Math.random() * 0.55;
        screenDrops.push({
          x: bx + Math.cos(a) * dist,
          y: by + Math.sin(a) * dist * 0.85,
          r: 0.0014 + Math.random() * 0.0032,
          age: 0, life: 0.30 + Math.random() * 0.55,
          vy: 0.02 + Math.random() * 0.10,
          vx: Math.cos(a) * spd,
          vspread: Math.sin(a) * spd * 0.7,
          slide: true, stretch: 1.0
        });
      }
    }
    for (let i = screenDrops.length - 1; i >= 0; i--) {
      const d = screenDrops[i];
      d.age += dt;
      if (d.age > 0.14) {
        d.y -= (d.vy + (d.vspread || 0)) * dt;
        d.x += (d.vx || 0) * dt;
        d.vx = (d.vx || 0) * (1 - 3.4 * dt);
        d.vspread = (d.vspread || 0) * (1 - 3.4 * dt);
        d.vy += (d.r > 0.008 ? 0.32 : 0.18) * dt;
        d.r *= 1 - (d.r < 0.0045 ? 0.9 : 0.018) * dt;
        d.stretch = 1.0 + Math.min(0.45, d.vy * 1.6);
      }
      const fade = Math.min(1, d.age / 0.10) * Math.max(0, 1 - Math.max(0, d.age - d.life * 0.55) / (d.life * 0.45));
      if (d.age > d.life || d.y < -0.06 || fade <= 0.01) { screenDrops.splice(i, 1); continue; }
      d._a = fade;
    }
    const arr = dropUniforms.uDrops.value;
    const n = Math.min(screenDrops.length, DROP_MAX);
    for (let i = 0; i < n; i++) {
      const d = screenDrops[i];
      arr[i].set(d.x, d.y, d.r * (0.65 + 0.35 * d._a), d.stretch);
      dropUniforms.uDropAge.value[i] = d.age;
    }
    dropUniforms.uDropCount.value = n;
  }

  if (FREEZE) {
    for (let i = 0; i < 4; i++) {
      screenDrops.push({
        x: 0.16 + i * 0.22, y: 0.62 + (i % 2) * 0.12,
        r: 0.016 + (i % 3) * 0.006, age: QA_AGE, life: 6,
        vy: 0.04, stretch: 1.8, _a: 1
      });
    }
  }

  /* ---------- 16.5 流星 / 星空 / 路灯 ---------- */
  const SKY_AXIS = new T.Vector3(0.30, 1.0, 0.16).normalize();
  const skyRotM = new T.Matrix4();
  const meteors = [
    { a: new T.Vector3(), b: new T.Vector3(), t: -1, speed: 1 },
    { a: new T.Vector3(), b: new T.Vector3(), t: -1, speed: 1 },
    { a: new T.Vector3(), b: new T.Vector3(), t: -1, speed: 1 }
  ];
  let meteorTimer = NO_METEOR ? 1e9 : 5 + Math.random() * 8;
  if (FREEZE) {
    spawnMeteor();
    meteors[0].a.set(0.35, 0.55, -0.75).normalize();
    meteors[0].b.copy(meteors[0].a).applyAxisAngle(new T.Vector3(0, 1, 0), 0.35);
    meteors[0].b.y -= 0.22;
    meteors[0].b.normalize();
    meteors[0].t = 0.5;
  }
  function spawnMeteor() {
    const slot = meteors.find(m => m.t < 0);
    if (!slot) return;
    const az = Math.random() * Math.PI * 2;
    const el = 0.35 + Math.random() * 0.75;
    slot.a.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const turn = (Math.random() - 0.5) * 0.5;
    slot.b.copy(slot.a).applyAxisAngle(new T.Vector3(0, 1, 0), turn);
    slot.b.y -= 0.18 + Math.random() * 0.25;
    slot.b.normalize();
    slot.t = 0;
    slot.speed = 0.55 + Math.random() * 0.6;
  }
  function updateMeteors(dt) {
    if (NO_METEOR) {
      skyMat.uniforms.uMeteorT.value = new Float32Array([-1, -1, -1]);
      return;
    }
    if (!FREEZE) {
      meteorTimer -= dt;
      if (meteorTimer <= 0) { spawnMeteor(); meteorTimer = 3 + Math.random() * 9; }
    }
    for (let i = 0; i < 3; i++) {
      const m = meteors[i];
      if (m.t >= 0) {
        if (!FREEZE) m.t += dt * m.speed * 1.4;
        if (m.t > 1) m.t = -1;
      }
      skyMat.uniforms.uMeteorA.value[i].copy(m.a);
      skyMat.uniforms.uMeteorB.value[i].copy(m.b);
    }
    skyMat.uniforms.uMeteorT.value = new Float32Array([meteors[0].t, meteors[1].t, meteors[2].t]);
  }

  function updateLampUniforms() {
    const on = smoothstep(7.0, 0.5, T.MathUtils.radToDeg(sunElev));
    const list = lampState.pos
      .map(p => ({ p, d: p.distanceToSquared(camera.position) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 6);
    for (let i = 0; i < 6; i++) {
      const g = grassU.uLampPos.value[i], gg = groundU.uLampPos.value[i];
      const cg = grassU.uLampCol.value[i], cgg = groundU.uLampCol.value[i];
      if (i < list.length) {
        g.copy(list[i].p); gg.copy(list[i].p);
        const k = (40 + 120 * on) * on;
        cg.set(1.0, 0.94, 0.84).multiplyScalar(k);
        cgg.copy(cg);
      } else {
        cg.setScalar(0); cgg.setScalar(0);
      }
    }
    grassU.uLampN.value = list.length;
    groundU.uLampN.value = list.length;
  }

  /* ---------- 17. 主循环 ---------- */
  if (!SHOWHUD) document.body.classList.add('nohud');
  let t0 = performance.now(), simTime = 0, lastHud = 0, frames = 0, fps = 0, adaptT = 0;
  const $ = id => document.getElementById(id);
  const hud = {
    ws: $('v-wspeed'), wg: $('v-gust'), wd: $('v-wdir'), rain: $('v-rain'),
    sun: $('v-sun'), fps: $('v-fps'), clock: $('v-clock'), phase: $('v-phase'),
    needle: $('needle'), hdg: $('hdg')
  };

  let recFrame = 0;

  function stepSim(ts, dt) {
    const t = ts;
    updateCelestial();
    updateSkyAndLight();

    const s2 = 0.5 + 0.5 * (0.62 * Math.sin(t * 0.075 + 0.4) + 0.38 * Math.sin(t * 0.031 + 2.2));
    wind.speed = BFT_LO + (BFT_HI - BFT_LO) * clamp(s2, 0, 1);
    const wv = new T.Vector3(wind.dir.x, 0, wind.dir.y).multiplyScalar(wind.speed);

    if (!paused) {
      const drift = wind.speed * dt;
      cloudDrift.x += wind.dir.x * drift * 0.9;
      cloudDrift.y += wind.dir.y * drift * 0.9;
    }
    grassU.uTime.value = t;
    windTimeU.value = t;
    grassU.uWindSpeed.value = wind.speed;
    grassU.uWindDir.value = wind.dir;
    rainU.uTime.value = t;
    rainU.uWind.value.copy(wv);
    splashU.uTime.value = t;
    if (window.__seaU) {
      const su = window.__seaU;
      su.uTime.value = t;
      su.uSunDir.value.copy(SUN_DIR);
      su.uMoonDir.value.copy(MOON_DIR);
      su.uSunColor.value.copy(skyU.uWarm.value).lerp(skyU.uCool.value, 0.35);
      su.uSkyTop.value.copy(skyU.uZenith.value);
      su.uSkyHorizon.value.copy(skyU.uWarm.value).lerp(skyU.uCool.value, 0.5);
      su.uNight.value = skyU.uNight.value;
      su.uFogColor.value.copy(FOG.color);
      su.uFogDensity.value = FOG.density;
      su.uWindDir.value.copy(wind.dir);
      su.uChop.value = 0.55 + 0.75 * clamp((wind.speed - BFT_LO) / Math.max(BFT_HI - BFT_LO, 0.001), 0, 1);
    }
    if (window.__embU) {
      const eu = window.__embU;
      eu.uTime.value = t;
      eu.uNight.value = skyU.uNight.value;
      eu.uSunDir.value.copy(SUN_DIR);
      eu.uSunCol.value.copy(sunLight.color).multiplyScalar(clamp(SKY_LIGHTW, 0, 1) * 1.1 + 0.12);
      eu.uAmb.value.copy(skyU.uCool.value).multiplyScalar(0.35).add(tmpC1.copy(skyU.uZenith.value).multiplyScalar(0.32));
      eu.uSkyTop.value.copy(skyU.uZenith.value);
      eu.uSkyHor.value.copy(skyU.uWarm.value);
      eu.uFogColor.value.copy(FOG.color);
      eu.uFogDensity.value = FOG.density;
    }
    if (window.__ground) {
      groundU.uSkyTop.value.copy(skyU.uZenith.value);
      groundU.uSkyHor.value.copy(skyU.uWarm.value);
      groundU.uFogColor.value.copy(FOG.color);
      groundU.uFogDensity.value = FOG.density;
    }
    if (window.__sprayU) window.__sprayU.uNight.value = skyU.uNight.value;

    if (ctrl.auto && !FREEZE) {
      camera.position.z -= dt * 0.55;
      if (camera.position.z < -150) camera.position.z = 24;
    }
    if (ctrl.auto) {
      camera.position.x = 0.9 + Math.sin(t * 0.33) * 0.10 * (s2 - 0.5);
      camera.position.y = 1.55 + Math.sin(t * 0.51) * 0.016 * (s2 - 0.5);
    }
    camera.fov = ctrl.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(
      camera.position.x + Math.sin(ctrl.yaw) * 10,
      camera.position.y + Math.tan(ctrl.pitch) * 10,
      camera.position.z - Math.cos(ctrl.yaw) * 10
    );
    sky.position.copy(camera.position);
    skyU.uSunDir.value.copy(SUN_DIR);
    skyU.uMoonDir.value.copy(MOON_DIR);

    sunLight.target.position.set(camera.position.x, 0, camera.position.z - 14);
    sunLight.position.copy(SUN_DIR).multiplyScalar(300).add(sunLight.target.position);
    moonLight.target.position.copy(sunLight.target.position);

    // ---- 星空随地球自转 ----
    skyRotM.makeRotationAxis(SKY_AXIS, dayT * Math.PI * 2);
    skyMat.uniforms.uSkyRot.value.setFromMatrix4(skyRotM);
    skyMat.uniforms.uTime.value = t;

    // ---- 流星 ----
    updateMeteors(dt);

    // ---- 最近 6 盏路灯：给草与地面用 ----
    updateLampUniforms();

    updateScreenDrops(FREEZE ? 0 : dt);
    if (window.__rocketUpdate) window.__rocketUpdate(dt);
    post.render(t);
  }

  /* ---------- 动态分辨率 / 显卡信息 ---------- */
  let renderScale = QUAL === 'high' ? 1.0 : (QUAL === 'mid' ? 0.9 : 0.72);
  const glCtx = renderer.getContext();
  const dbgExt = glCtx.getExtension('WEBGL_debug_renderer_info');
  const gpuName = dbgExt ? glCtx.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const isWeakGpu = /Intel|Iris|UHD|Vega|Radeon|Apple GPU|SwiftShader/i.test(gpuName);

  const MAX_PIXELS = 2.4e6;   // 渲染像素上限（约 1920×1250）
  let pixelClamp = 1.0;
  function applyRenderScale(sc) {
    renderScale = clamp(sc, 0.45, 1.0);
    const dpr = Math.min(devicePixelRatio || 1, 1.7);
    let eff = dpr * renderScale;
    const px = innerWidth * innerHeight * eff * eff;
    if (px > MAX_PIXELS) {
      eff = Math.sqrt(MAX_PIXELS / (innerWidth * innerHeight));
      pixelClamp = eff / (dpr * renderScale);
    } else {
      pixelClamp = 1.0;
    }
    renderer.setPixelRatio(eff);
    renderer.setSize(innerWidth, innerHeight);
    const bs = new T.Vector2();
    renderer.getDrawingBufferSize(bs);
    post.resize(bs.x, bs.y);
    const el = document.getElementById('pRes');
    if (el) el.textContent = Math.round(eff * 100 / Math.min(devicePixelRatio || 1, 1.7)) + '%';
  }

  (function initPerf() {
    const gpuEl = document.getElementById('gpuName');
    const hintEl = document.getElementById('gpuHint');
    let short = gpuName;
    const m = gpuName.match(/\((.*?)\)/);
    if (m) {
      const parts = m[1].split(',');
      short = parts.length > 1 ? parts[1].trim() : parts[0].trim();
    }
    short = short.replace(/Direct3D\d+|vs_\d+_\d+|ps_\d+_\d+|ANGLE|Vulkan[\d.]*/gi, '').replace(/\s+/g, ' ').trim();
    if (gpuEl) { gpuEl.textContent = short; gpuEl.title = gpuName; }
    if (hintEl && isWeakGpu) {
      hintEl.textContent = '当前是核显/软件渲染。想要 60fps：Windows 设置 → 系统 → 显示 → 图形 → 添加 msedge.exe → 高性能';
    }
    document.querySelectorAll('#perf button').forEach(b => {
      if (b.dataset.q === QUAL) b.classList.add('on');
      b.addEventListener('click', () => {
        localStorage.setItem('rainroad_quality', b.dataset.q);
        const u = new URL(location.href);
        u.searchParams.set('q', b.dataset.q);
        location.href = u.toString();
      });
    });
    if (isWeakGpu) renderScale = Math.min(renderScale, 0.72);
    applyRenderScale(renderScale);
  })();

  /* ---------- 音乐播放 ---------- */
  (function music() {
    const DEFAULT_TRACK = './track.mp3';   // 与 HTML 同目录
    const audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0.72;

    const $ = id => document.getElementById(id);
    window.__audio = audio;
    const btn = $('mPlay'), vol = $('mVol'), pick = $('mPick'), file = $('mFile'),
          nameEl = $('mName'), stateEl = $('mState'), tip = $('mTip');
    if (!btn) return;

    const setName = t => { if (nameEl) nameEl.textContent = t; };
    const showTip = t => { if (tip) { tip.textContent = t; tip.style.display = t ? 'block' : 'none'; } };
    const syncBtn = () => {
      const on = !audio.paused;
      if (on) started = true;
      btn.textContent = on ? '❚❚' : '▶';
      if (stateEl) stateEl.classList.toggle('on', on);
    };

    audio.src = DEFAULT_TRACK;
    setName('星河追梦 (Beyond the Stars)');
    audio.addEventListener('error', () => {
      showTip('没有找到同目录的 track.mp3（把音乐改名 track.mp3 放在 HTML 旁边即可），或点「选曲」手动选。');
    });
    audio.addEventListener('play', () => { started = true; syncBtn(); hideHint(); });
    audio.addEventListener('pause', syncBtn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audio.paused) audio.play().then(() => showTip('')).catch(() => showTip('播放被浏览器拦截，再点一次 ▶'));
      else audio.pause();
    });
    if (vol) vol.addEventListener('input', () => { audio.volume = vol.value / 100; if (audio.muted) { audio.muted = false; showTip(''); } });
    if (pick && file) {
      pick.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        audio.src = URL.createObjectURL(f);
        setName(f.name.replace(/\.(mp3|wav|flac|m4a|ogg|aac)$/i, ''));
        showTip('');
        audio.play().catch(() => {});
      });
    }
    addEventListener('keydown', e => {
      if (e.key === 'm' || e.key === 'M') btn.click();
    });
    // ---- 进度条 ----
    const seek = $('mSeek'), timeEl = $('mTime'), hintEl = $('mhint');
    let scrubbing = false;
    const fmt = t => {
      if (!isFinite(t) || t < 0) t = 0;
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      return m + ':' + String(s).padStart(2, '0');
    };
    const syncProgress = () => {
      const d = audio.duration || 0;
      if (!scrubbing && seek) seek.value = d ? Math.round(audio.currentTime / d * 1000) : 0;
      if (timeEl) timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
    };
    audio.addEventListener('timeupdate', syncProgress);
    audio.addEventListener('loadedmetadata', syncProgress);
    audio.addEventListener('durationchange', syncProgress);
    if (seek) {
      seek.addEventListener('input', () => { scrubbing = true; });
      seek.addEventListener('change', () => {
        const d = audio.duration || 0;
        if (d) audio.currentTime = (seek.value / 1000) * d;
        scrubbing = false;
        syncProgress();
      });
      seek.addEventListener('pointerup', () => { scrubbing = false; });
    }
    const hideHint = () => {
      if (hintEl) hintEl.classList.add('gone');
      const t = document.getElementById('playtoast');
      if (t) t.classList.add('gone');
    };

    // ---- 自动播放：先试一次，失败就等第一次手势 ----
    let started = false;
    let mutedFallback = false;
    const tryPlay = () => audio.play().then(hideHint).catch(() => {
      if (mutedFallback) return;
      mutedFallback = true;
      audio.muted = true;                    // 先静音起播，保证进度条会动
      audio.play().then(() => showTip('已静音播放 · 点一下画面或调音量开启声音')).catch(() => {});
    });
    audio.addEventListener('canplay', () => { if (audio.paused) tryPlay(); }, { once: true });
    const kick = (e) => {
      if (e && e.target && e.target.closest && e.target.closest('#music')) return;  // 别抢播放器的点击
      hideHint();
      if (started) return;
      started = true;
      if (audio.muted) { audio.muted = false; showTip(''); if (vol) vol.value = Math.round(audio.volume * 100); }
      if (audio.paused) tryPlay();
    };
    ['pointerdown', 'mousedown', 'wheel', 'keydown', 'touchstart'].forEach(ev =>
      addEventListener(ev, kick, { passive: true })
    );
    setTimeout(() => { if (audio.paused) tryPlay(); }, 600);
  })();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - t0) / 1000);
    t0 = now;
    if (!paused && !FREEZE && !sliderActive) {
      simTime += dt;
      dayT = (dayT + dt * timeScale / DAY_SECONDS) % 1;
    }
    stepSim(FIXED_T !== null ? FIXED_T : simTime, dt);

    frames++;
    if (now - lastHud > 300) {
      fps = Math.round(frames * 1000 / (now - lastHud));
      frames = 0; lastHud = now;
      const hdg = ((-ctrl.yaw * 180 / Math.PI) % 360 + 360) % 360;
      hud.ws.textContent = wind.speed.toFixed(1) + ' m/s';
      hud.wg.textContent = beaufort(wind.speed) + ' 级';
      hud.wd.textContent = '固定 36°';
      hud.rain.textContent = '中雨 · 斜落';
      hud.sun.textContent = (T.MathUtils.radToDeg(sunElev)).toFixed(1) + '°';
      hud.fps.textContent = fps + ' fps';
      const pf = document.getElementById('pFps');
      if (pf) pf.textContent = fps + ' fps';
      window.__fps = fps;
      if (Q.get('probe') === '1') {
        const gl = renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const nm = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a';
        const el = document.getElementById('cerr');
        if (el) el.textContent = 'GPU=' + nm + ' FPS=' + fps;
      }
      if (hud.clock) hud.clock.textContent = clockString(dayT);
      if (tslider && !sliderActive) {
        const mins = ((dayT * 24 + 6) % 24) * 60;
        tslider.value = String(Math.round(mins));
        if (tcur) tcur.textContent = clockString(dayT);
      } else if (tslider && tcur) {
        tcur.textContent = clockString(dayT);
      }
      if (hud.phase) hud.phase.textContent = sunElev > 0.06 ? '白昼' : sunElev > -0.04 ? '晨昏' : '夜间';
      if (hud.hdg) hud.hdg.textContent = String(Math.round(hdg)).padStart(3, '0') + '°';
      if (hud.needle) hud.needle.style.transform = `rotate(${-hdg}deg)`;
    }
    // 自适应分辨率
    adaptT += dt;
    if (adaptT > 1.2) {
      adaptT = 0;
      if (fps > 0 && fps < 46 && renderScale > 0.55) applyRenderScale(renderScale - 0.06);
      else if (fps > 57 && renderScale < 0.995) applyRenderScale(renderScale + 0.03);
    }
    window.__frames = (window.__frames || 0) + 1;
  }
  /* ---------- 交互 ---------- */
  const ctrl = { yaw: 0, pitch: -0.01, fov: 55, drag: false, px: 0, py: 0, auto: !NOAUTO };
  if (Q.has('cam')) {
    const c = Q.get('cam').split(',').map(Number);
    if (c.length === 3) { camera.position.set(c[0], c[1], c[2]); ctrl.auto = false; }
  }
  if (Q.has('yaw')) ctrl.yaw = parseFloat(Q.get('yaw'));
  if (Q.has('pitch')) ctrl.pitch = parseFloat(Q.get('pitch'));
  if (Q.has('fov')) ctrl.fov = parseFloat(Q.get('fov'));

  canvas.addEventListener('pointerdown', e => { ctrl.drag = true; ctrl.px = e.clientX; ctrl.py = e.clientY; });
  addEventListener('pointerup', () => ctrl.drag = false);
  addEventListener('pointermove', e => {
    if (!ctrl.drag) return;
    ctrl.yaw -= (e.clientX - ctrl.px) * 0.0022;
    ctrl.pitch -= (e.clientY - ctrl.py) * 0.0016;
    ctrl.pitch = clamp(ctrl.pitch, -1.5533, 1.5533);
    ctrl.px = e.clientX; ctrl.py = e.clientY;
  });
  addEventListener('wheel', e => { ctrl.fov = clamp(ctrl.fov + e.deltaY * 0.02, 30, 80); }, { passive: true });

  let paused = false, timeScale = 1;
  let sliderActive = false;
  const tslider = document.getElementById('tslider');
  const tcur = document.getElementById('tcur');
  if (tslider) {
    tslider.addEventListener('input', () => {
      const m = parseFloat(tslider.value);
      dayT = (((m / 60) - 6) / 24 + 1) % 1;
      sliderActive = true;
    });
    tslider.addEventListener('change', () => { sliderActive = false; });
    tslider.addEventListener('pointerup', () => { sliderActive = false; });
  }
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (k === 'p') paused = !paused;
    if (k === 'h') document.body.classList.toggle('nohud');
    if (k === '[') timeScale = Math.max(0.25, timeScale - 0.25);
    if (k === ']') timeScale = Math.min(8, timeScale + 0.25);
    if (k === '1') { camera.position.set(0.9, 1.55, 14); ctrl.yaw = 0; ctrl.pitch = -0.01; ctrl.fov = 55; ctrl.auto = false; }
    if (k === '2') { camera.position.set(-1.15, 0.86, 7); ctrl.yaw = 0.02; ctrl.pitch = 0.015; ctrl.fov = 42; ctrl.auto = false; }
    if (k === '3') { camera.position.set(9.0, 2.2, 30); ctrl.yaw = -0.26; ctrl.pitch = -0.06; ctrl.fov = 60; ctrl.auto = false; }
    if (k === 'r') { camera.position.set(0.9, 1.55, 14); ctrl.yaw = 0; ctrl.pitch = -0.01; ctrl.fov = 55; ctrl.auto = true; }
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    applyRenderScale(renderScale);
  });

  function applyCamScript(s) {
    const e = (a, b, x) => { const q = clamp((x - a) / (b - a), 0, 1); return q * q * (3 - 2 * q); };
    let px = 0.9, py = 1.55, pz = 14 - s * 13;
    let yaw = 0.02 * Math.sin(s * 6.0);
    let pitch = -0.012;
    let fov = 55;
    const up = e(0.30, 0.58, s);
    pitch += up * 0.40;
    py += up * 0.55;
    const back = e(0.74, 0.98, s);
    pitch = pitch * (1 - back) - 0.02 * back;
    py = py * (1 - back) + 1.7 * back;
    fov = 55 - 6 * up + 6 * back;

    // 抬头段：把镜头对准银河带
    if (up > 0.001) {
      const gin = new T.Matrix4().copy(skyRotM).invert();
      const pole = skyMat.uniforms.uGalPole.value.clone().applyMatrix4(gin).normalize();
      // 银心方向：galX 转到世界系
      const galX = new T.Vector3().crossVectors(skyMat.uniforms.uGalPole.value, new T.Vector3(0, 1, 0)).normalize();
      let bandDir = galX.clone().applyMatrix4(gin).normalize();
      if (bandDir.y < 0) bandDir.negate();
      bandDir.add(new T.Vector3(0, 0.55, 0)).normalize();
      const look = new T.Vector3(
        Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)
      ).lerp(bandDir, up * 0.92).normalize();
      yaw = Math.atan2(look.x, -look.z);
      pitch = Math.asin(clamp(look.y, -1, 1));
    }

    camera.position.set(px, py, pz);
    ctrl.yaw = yaw;
    ctrl.pitch = pitch;
    ctrl.fov = fov;
    ctrl.auto = false;
  }

  if (Q.get('rec') === '1') {
    const REC_FPS = parseFloat(Q.get('fps') || '30');
    window.__recFps = REC_FPS;
    window.__setFrame = function (i) {
      recFrame = i;
      const ts = i / REC_FPS;
      const s = clamp(ts / 60, 0, 1);
      dayT = 0.482 + 0.175 * s;               // 17:34 → 21:46
      simTime = ts;
      applyCamScript(s);
      stepSim(ts, 1 / REC_FPS);
      return true;
    };
    window.__ready = true;
  } else if (renderer.compileAsync) {
    const bootStatus = document.getElementById('bootStatus');
    if (bootStatus) bootStatus.textContent = '并行编译着色器';
    if (window.__rocketUpdate) window.__rocketUpdate(0);
    const depthStage = new T.Scene();
    const shadowSides = {
      [T.FrontSide]: T.BackSide,
      [T.BackSide]: T.FrontSide,
      [T.DoubleSide]: T.DoubleSide
    };
    function depthMaterial(object, material) {
      if (object.customDepthMaterial) return object.customDepthMaterial;
      const depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
      depth.side = material.shadowSide !== null ? material.shadowSide : shadowSides[material.side];
      depth.alphaMap = material.alphaMap;
      depth.alphaTest = material.alphaToCoverage ? 0.5 : material.alphaTest;
      depth.map = material.map;
      depth.clipShadows = material.clipShadows;
      depth.clippingPlanes = material.clippingPlanes;
      depth.clipIntersection = material.clipIntersection;
      depth.displacementMap = material.displacementMap;
      depth.displacementScale = material.displacementScale;
      depth.displacementBias = material.displacementBias;
      depth.wireframe = material.wireframe;
      return depth;
    }
    // compileAsync 不覆盖内部阴影深度材质，需按相同参数单独预热。
    scene.traverseVisible(object => {
      if (!object.isMesh || !object.castShadow) return;
      const clone = object.clone(false);
      clone.material = Array.isArray(object.material)
        ? object.material.map(material => depthMaterial(object, material))
        : depthMaterial(object, object.material);
      depthStage.add(clone);
    });
    const previousTarget = renderer.getRenderTarget();
    const warmTarget = new T.WebGLRenderTarget(1, 1);
    renderer.setRenderTarget(warmTarget);
    const mainCompilation = renderer.compileAsync(scene, camera);
    const sceneFog = scene.fog;
    scene.fog = null;
    const depthCompilation = renderer.compileAsync(depthStage, camera, scene);
    scene.fog = sceneFog;
    renderer.setRenderTarget(previousTarget);
    warmTarget.dispose();
    Promise.all([mainCompilation, depthCompilation]).then(() => requestAnimationFrame(frame));
  } else {
    requestAnimationFrame(frame);
  }
})();
