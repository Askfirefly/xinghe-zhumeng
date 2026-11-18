/* ============================================================
   深空 · 太阳系 — Mac 端（深空 + 行星）
   技术路线对齐「星河追梦」交付包：
     · 实体物质 → 真实 PBR/行星贴图（Solar System Scope, CC BY 4.0）
     · 非实体（光/大气/云/星空）→ 全 GPU 程序化
     · 尺度 → logarithmicDepthBuffer + 相机相对坐标（浮动原点）
     · 后处理 → AgX + 自适应曝光(±12%) + 颗粒 0.02 + 暗角 0.24
   ============================================================ */
(function () {
  'use strict';
  const T = window.THREE;

  /* ---------- 参数 ---------- */
  const Q = new URLSearchParams(location.search);
  const QUAL = ['low', 'mid', 'high'].includes(Q.get('q')) ? Q.get('q') : 'high';
  const LOWQ = QUAL === 'low', MIDQ = QUAL === 'mid';
  const DPR_CAP = LOWQ ? 1 : (MIDQ ? 1.5 : 2);
  const MSAA = LOWQ ? 0 : (MIDQ ? 2 : 4);
  const STAR_LAYERS = LOWQ ? 2 : (MIDQ ? 3 : 4);

  /* ---------- 天体数据（半径/距离为视觉尺度，周期/倾角为真实值） ---------- */
  const AU = 40;                       // 1 AU → 40 场景单位
  const BODIES = [
    { key: 'sun',     name: '太阳',   en: 'SUN',     r: 8.0,  d: 0,        T: 0,       rot: 25.4,  tilt: 7.25,
      diam: '1,392,700 km', au: '—', per: '—', day: '25.4 天', temp: '5,772 K（表面）',
      desc: 'G2V 型主序星，占太阳系总质量的 99.86%。表面为程序化米粒组织 + 临边昏暗，日冕由噪声射线程序化生成。' },
    { key: 'mercury', name: '水星',   en: 'MERCURY', r: 0.55, d: 0.387*AU, T: 88,      rot: 58.6,  tilt: 0.03,
      diam: '4,879 km', au: '0.39 AU', per: '88 天', day: '58.6 天', temp: '−173 ~ 427 °C',
      desc: '最小、最靠近太阳的行星，表面布满撞击坑，几乎没有大气。昼夜温差是太阳系之最。' },
    { key: 'venus',   name: '金星',   en: 'VENUS',   r: 0.95, d: 0.723*AU, T: 224.7,   rot: -243,  tilt: 177.4,
      diam: '12,104 km', au: '0.72 AU', per: '224.7 天', day: '243 天（逆行）', temp: '464 °C',
      desc: '被浓硫酸云覆盖的温室炼狱，表面气压约 92 倍地球大气。自转方向与众不同——太阳从西边升起。' },
    { key: 'earth',   name: '地球',   en: 'EARTH',   r: 1.0,  d: 1.0*AU,   T: 365.25,  rot: 1,     tilt: 23.44,
      diam: '12,742 km', au: '1.00 AU', per: '365.25 天', day: '23.9 小时', temp: '−89 ~ 57 °C',
      desc: '目前已知唯一存在生命的行星。夜半球城市灯光、昼半球海洋镜面高光、云层与 Rayleigh/Mie 大气散射均为实时计算。' },
    { key: 'mars',    name: '火星',   en: 'MARS',    r: 0.72, d: 1.524*AU, T: 687,     rot: 1.03,  tilt: 25.19,
      diam: '6,779 km', au: '1.52 AU', per: '687 天', day: '24.6 小时', temp: '−153 ~ 20 °C',
      desc: '红色源自地表氧化铁。拥有太阳系最高的火山（奥林帕斯山，约 22 km）与最长的峡谷（水手号谷）。' },
    { key: 'jupiter', name: '木星',   en: 'JUPITER', r: 3.6,  d: 5.203*AU, T: 4333,    rot: 0.41,  tilt: 3.13,
      diam: '139,820 km', au: '5.20 AU', per: '11.9 年', day: '9.9 小时', temp: '−108 °C（云顶）',
      desc: '太阳系最大的行星，质量是其余七颗行星总和的 2.5 倍。条带云系与大红斑为程序化 FBM 湍流，实时缓慢演化。' },
    { key: 'saturn',  name: '土星',   en: 'SATURN',  r: 3.0,  d: 9.537*AU, T: 10759,   rot: 0.45,  tilt: 26.73,
      diam: '116,460 km', au: '9.54 AU', per: '29.5 年', day: '10.7 小时', temp: '−139 °C（云顶）',
      desc: '以壮观的冰质环系闻名。环的密度波、卡西尼缝、前向散射与行星本影都在 shader 里实时求解。' },
    { key: 'uranus',  name: '天王星', en: 'URANUS',  r: 1.7,  d: 19.19*AU, T: 30687,   rot: -0.72, tilt: 97.77,
      diam: '50,724 km', au: '19.2 AU', per: '84 年', day: '17.2 小时（逆行）', temp: '−197 °C',
      desc: '自转轴几乎躺倒（97.8°），像在轨道上滚动。甲烷大气赋予它均匀的青蓝色。' },
    { key: 'neptune', name: '海王星', en: 'NEPTUNE', r: 1.65, d: 30.07*AU, T: 60190,   rot: 0.67,  tilt: 28.32,
      diam: '49,244 km', au: '30.1 AU', per: '165 年', day: '16.1 小时', temp: '−201 °C',
      desc: '离太阳最远的行星，风速可达 2,100 km/h——太阳系最强风暴。深蓝色来自甲烷吸收红光。' },
    { key: 'moon',    name: '月球',   en: 'MOON',    r: 0.27, d: 2.6,      T: 27.3,    rot: 27.3,  tilt: 6.68, parent: 'earth',
      diam: '3,474 km', au: '距地 384,400 km', per: '27.3 天', day: '27.3 天（潮汐锁定）', temp: '−173 ~ 127 °C',
      desc: '地球唯一的天然卫星，潮汐锁定使它永远以同一面朝向地球。表面为真实月面贴图 + 凹凸光照。' }
  ];
  const BY_KEY = {}; BODIES.forEach(b => BY_KEY[b.key] = b);

  /* ---------- 渲染器 ---------- */
  const canvas = document.getElementById('scene');
  const renderer = new T.WebGLRenderer({
    canvas, antialias: false, logarithmicDepthBuffer: true,
    powerPreference: 'high-performance', stencil: false
  });
  renderer.toneMapping = T.NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  let W = 1, H = 1, DPR = 1;

  const scene = new T.Scene();          // 后处理之外的根
  const universe = new T.Group();       // 所有天体（浮动原点：每帧 position = -camWorld）
  scene.add(universe);
  const camera = new T.PerspectiveCamera(50, 1, 0.05, 9000);
  scene.add(camera);

  const sunLight = new T.PointLight(0xfff2e0, 3.2, 0, 0);
  universe.add(sunLight);
  universe.add(new T.AmbientLight(0x223344, 0.05));

  /* ---------- 贴图 ---------- */
  function loadTex(id, srgb) {
    const el = document.getElementById(id);
    const b64 = el ? el.textContent.trim() : '';
    if (!b64) return null;
    const mime = b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
    const tex = new T.TextureLoader().load('data:' + mime + ';base64,' + b64);
    tex.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    tex.wrapS = T.RepeatWrapping;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  const TEX = {
    mercury: loadTex('tex_mercury', true),
    venus: loadTex('tex_venusatm', true),
    earthDay: loadTex('tex_earthday', true),
    earthNight: loadTex('tex_earthnight', true),
    earthClouds: loadTex('tex_earthclouds', true),
    mars: loadTex('tex_mars', true),
    moon: loadTex('tex_moon', true)
  };

  /* ---------- GLSL 公共 ---------- */
  const GLSL_NOISE = `
    float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.yzx+33.33); return fract((p.x+p.y)*p.z); }
    vec3 hash33(vec3 p){ p = fract(p*vec3(0.1031,0.1030,0.0973)); p += dot(p, p.yxz+33.33);
      return fract((p.xxy+p.yxx)*p.zyx); }
    float noise3(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(mix(hash13(i), hash13(i+vec3(1,0,0)), f.x),
                     mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x),
                     mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm3(vec3 p){
      float a = 0.5, s = 0.0;
      for (int i = 0; i < 4; i++){ s += a*noise3(p); p = p*2.13 + 7.7; a *= 0.5; }
      return s;
    }
    float noise2(vec2 p){
      vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      float a = hash13(vec3(i, 0.0)), b = hash13(vec3(i+vec2(1,0), 0.0));
      float c = hash13(vec3(i+vec2(0,1), 0.0)), d = hash13(vec3(i+vec2(1,1), 0.0));
      return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
    }
    float fbm2(vec2 p){
      float a = 0.5, s = 0.0;
      for (int i = 0; i < 4; i++){ s += a*noise2(p); p = p*2.17 + 3.1; a *= 0.5; }
      return s;
    }
  `;
  const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';
  const LOG_V_MAIN = '#include <logdepthbuf_vertex>';
  const LOG_F = '#include <logdepthbuf_pars_fragment>';
  const LOG_F_MAIN = '#include <logdepthbuf_fragment>';

  /* ---------- 星空 + 银河（改自星河追梦 starfield.glsl） ---------- */
  const skyMat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uTime: { value: 0 }, uLayers: { value: STAR_LAYERS } },
    vertexShader: `
      varying vec3 vDir;
      ${LOG_V}
      void main(){
        vDir = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        ${LOG_V_MAIN}
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform float uTime; uniform int uLayers;
      ${GLSL_NOISE}
      ${LOG_F}
      vec3 starTint(float t){
        vec3 c = mix(vec3(0.62,0.74,1.00), vec3(0.97,0.98,1.00), smoothstep(0.0,0.32,t));
        c = mix(c, vec3(1.00,0.92,0.76), smoothstep(0.32,0.64,t));
        return mix(c, vec3(1.00,0.68,0.46), smoothstep(0.64,1.0,t));
      }
      vec3 starLayer(vec3 dir, float scale, float dens, float seed, float bright,
                     float bandSig, float laneSig){
        vec3 p = dir*scale + seed;
        vec3 cell = floor(p);
        float dm = dens * (1.0 + 3.2*bandSig) * (1.0 - 0.8*laneSig);
        if (hash13(cell) >= dm) return vec3(0.0);
        vec3 sdir = normalize(cell + hash33(cell + 11.0));
        float ang = length(dir - sdir);
        float mag = pow(hash13(cell + 57.0), 3.2);
        float size = mix(0.00050, 0.00130, mag) * bright;
        float core = exp(-pow(ang/size, 2.0));
        return starTint(hash13(cell + 13.0)) * core * (0.55 + 3.4*mag);
      }
      void main(){
        ${LOG_F_MAIN}
        vec3 dir = normalize(vDir);
        vec3 col = vec3(0.003, 0.005, 0.011);

        // 银河坐标（倾斜银道面）
        vec3 gn = normalize(vec3(0.42, 0.86, 0.28));
        vec3 gt = normalize(cross(gn, vec3(0.0, 1.0, 0.0)));
        vec3 gb = cross(gn, gt);
        float glat = asin(clamp(dot(dir, gn), -1.0, 1.0));
        float glon = atan(dot(dir, gb), dot(dir, gt));
        vec2 circ = vec2(cos(glon), sin(glon));   // 圆周坐标采样，避免 ±π 接缝

        float band = exp(-abs(glat)/0.24);
        float halo = exp(-abs(glat)/0.62);
        float lane = smoothstep(0.52, 0.84, fbm2(circ*4.0 + vec2(0.0, glat*5.0)))
                   * smoothstep(0.35, 0.65, fbm2(circ*2.0 + glat*3.0 + 7.0));
        float bandMask = band * (1.0 - 0.42*lane);

        // 银河乳光：暖核 + 冷晕 + 颗粒
        float grain = fbm2(circ*9.0 + glat*7.0);
        vec3 mw = vec3(1.00,0.86,0.78) * bandMask * 0.032 * (0.7 + 0.6*grain)
                + vec3(0.56,0.60,0.74) * halo * 0.010;
        // 星云斑块
        float neb = fbm2(circ*3.0 + vec2(glat*3.0, 3.7));
        float nebM = smoothstep(0.68, 0.90, neb) * band;
        mw += mix(vec3(0.30,0.16,0.34), vec3(0.10,0.24,0.34), fbm2(circ*4.0+9.0)) * nebM * 0.07;
        col += mw;

        // 星点层
        vec3 st = starLayer(dir, 300.0, 0.020, 0.0, 1.0, band, lane);
        st += starLayer(dir, 520.0, 0.0125, 19.0, 0.85, band, lane);
        if (uLayers >= 3) st += starLayer(dir, 780.0, 0.0065, 41.0, 1.55, band, lane);
        if (uLayers >= 4) st += starLayer(dir, 1500.0, 0.030, 73.0, 0.55, band, lane);
        col += st * 0.6;

        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const sky = new T.Mesh(new T.SphereGeometry(5000, 48, 32), skyMat);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  scene.add(sky);                        // 跟随相机（相机恒在原点）

  /* ---------- 太阳 ---------- */
  const sunMat = new T.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vP; varying vec3 vObj;
      ${LOG_V}
      void main(){
        vN = normalize(normalMatrix * normal);
        vObj = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vP = mv.xyz;
        gl_Position = projectionMatrix * mv;
        ${LOG_V_MAIN}
      }`,
    fragmentShader: `
      varying vec3 vN; varying vec3 vP; varying vec3 vObj;
      uniform float uTime;
      ${GLSL_NOISE}
      ${LOG_F}
      void main(){
        ${LOG_F_MAIN}
        vec3 N = normalize(vN);
        vec3 V = normalize(-vP);
        float mu = clamp(dot(N, V), 0.0, 1.0);
        vec3 p = normalize(vObj);
        float gran = fbm3(p*7.0 + vec3(0.0, uTime*0.03, 0.0));
        float gran2 = fbm3(p*17.0 - vec3(uTime*0.02, 0.0, 0.0));
        float cells = smoothstep(0.35, 0.75, gran*0.65 + gran2*0.35);
        vec3 hot = vec3(1.00, 0.92, 0.72);
        vec3 cool = vec3(1.00, 0.45, 0.12);
        vec3 alb = mix(cool, hot, cells);
        alb = mix(alb, cool, (1.0 - mu)*0.5);
        float limb = 1.0 - 0.62*(1.0 - mu);          // 临边昏暗
        vec3 col = alb * limb * 5.0;                  // HDR，交给 bloom/AgX
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const sunMesh = new T.Mesh(new T.SphereGeometry(BY_KEY.sun.r, 96, 64), sunMat);
  sunMesh.userData.key = 'sun';
  universe.add(sunMesh);

  // 日冕：面向相机的加法混合 billboard
  const coronaMat = new T.ShaderMaterial({
    transparent: true, blending: T.AdditiveBlending, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uScale: { value: BY_KEY.sun.r * 2.6 } },
    vertexShader: `
      uniform float uScale;
      varying vec2 vUv;
      ${LOG_V}
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uScale;
        gl_Position = projectionMatrix * mv;
        ${LOG_V_MAIN}
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      ${GLSL_NOISE}
      ${LOG_F}
      void main(){
        ${LOG_F_MAIN}
        vec2 q = vUv*2.0 - 1.0;
        float r = length(q);
        if (r > 1.0) discard;
        float a = atan(q.y, q.x);
        float rays = fbm2(vec2(cos(a), sin(a))*3.0 + vec2(r*2.0 - uTime*0.05, uTime*0.02));
        float stream = fbm2(vec2(cos(a), sin(a))*6.0 + r*3.0);
        float glow = exp(-r*7.0) * (0.45 + 0.85*rays);
        float streaks = exp(-r*5.0) * pow(stream, 3.0) * 0.55;
        float hole = smoothstep(0.26, 0.34, r);      // 日面本体交给太阳 mesh
        float rim = 1.0 - smoothstep(0.75, 1.0, r);  // billboard 边缘归零，避免露出圆边界
        vec3 col = (vec3(1.0,0.72,0.38)*glow + vec3(1.0,0.85,0.60)*streaks) * hole * rim * 1.5;
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const corona = new T.Mesh(new T.PlaneGeometry(2, 2), coronaMat);
  corona.frustumCulled = false;
  universe.add(corona);

  /* ---------- 行星 ---------- */
  const pickables = [sunMesh];
  const bodyGroups = {};               // key → { group, mesh, worldPos }
  const gasMats = [];                  // 需要每帧更新 uTime/uSunPos 的材质
  const atmoMats = [];
  const ringMats = [];

  function gasGiantMat(cfg) {
    const m = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uSeed: { value: cfg.seed },
        uColA: { value: new T.Color(cfg.a) }, uColB: { value: new T.Color(cfg.b) },
        uColC: { value: new T.Color(cfg.c) },
        uSpot: { value: cfg.spot ? 1 : 0 },
        uSpotCol: { value: new T.Color(cfg.spotCol || '#c86a4a') },
        uSunPos: { value: new T.Vector3() }
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vW; varying vec3 vObjN;
        ${LOG_V}
        void main(){
          vObjN = normal;
          vN = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          ${LOG_V_MAIN}
        }`,
      fragmentShader: `
        varying vec3 vN; varying vec3 vW; varying vec3 vObjN;
        uniform float uTime, uSeed, uSpot;
        uniform vec3 uColA, uColB, uColC, uSpotCol, uSunPos;
        ${GLSL_NOISE}
        ${LOG_F}
        void main(){
          ${LOG_F_MAIN}
          vec3 N = normalize(vN);
          vec3 V = normalize(-vW);                 // 相机恒在原点
          vec3 L = normalize(uSunPos - vW);
          vec3 on = normalize(vObjN);
          float lat = asin(clamp(on.y, -1.0, 1.0));
          float lon = atan(on.z, on.x);

          // 圆周坐标采样噪声，避免 atan ±π 接缝
          vec2 lc = vec2(cos(lon + uTime*0.004), sin(lon + uTime*0.004));
          vec2 lc2 = vec2(cos(lon - uTime*0.006), sin(lon - uTime*0.006));
          float warp = fbm3(vec3(on.x*1.3, lat*5.0, on.z*1.3) + vec3(uSeed)) * 0.9;
          float band = fbm3(vec3(lat*10.0 + warp, lc*1.7) + uSeed*0.37);
          float band2 = fbm3(vec3(lat*23.0 + warp*1.7, lc2*2.2) + uSeed + 9.0);
          float t = band*0.68 + band2*0.32;
          vec3 alb = mix(uColA, uColB, smoothstep(0.34, 0.68, t));
          alb = mix(alb, uColC, smoothstep(0.60, 0.92, band2)*0.38);

          // 大红斑 / 大暗斑：椭圆涡旋
          if (uSpot > 0.5) {
            float slat = -0.38, slon = 1.2;
            float dl = lon - slon;
            dl = atan(sin(dl), cos(dl));
            vec2 sq = vec2(dl*cos(slat)*1.7, (lat - slat)*4.0);
            float sr = length(sq);
            float swirl = fbm3(vec3(sq*3.0 + uTime*0.01, uSeed*2.0));
            float spot = smoothstep(0.50, 0.20, sr + swirl*0.10);
            alb = mix(alb, uSpotCol*(0.8 + 0.5*swirl), spot*0.9);
          }

          float ndl = dot(N, L);
          float diff = pow(clamp(ndl, 0.0, 1.0), 0.85);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          vec3 col = alb * (diff * 1.9 * (0.62 + 0.38*mu) + 0.012);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    gasMats.push(m);
    return m;
  }

  const GAS_CFG = {
    jupiter: { seed: 3.1, a: '#a97a50', b: '#e9d8bc', c: '#7d4e2e', spot: true, spotCol: '#a8442a' },
    saturn:  { seed: 8.7, a: '#c2a678', b: '#efe3c4', c: '#a88c60', spot: false },
    uranus:  { seed: 5.4, a: '#7fc4cf', b: '#b8e4ea', c: '#6aa8b8', spot: false },
    neptune: { seed: 11.2, a: '#2a52c8', b: '#5a86e8', c: '#1a3488', spot: true, spotCol: '#16245e' }
  };

  function rockyMat(tex, opts) {
    const m = new T.MeshStandardMaterial({
      map: tex, roughness: 0.96, metalness: 0.0,
      bumpMap: tex, bumpScale: opts.bump || 0
    });
    if (opts.tint) m.color = new T.Color(opts.tint);
    return m;
  }

  // 地球：昼夜混合 + 海洋高光（自定义 shader）
  function earthMat() {
    const m = new T.ShaderMaterial({
      uniforms: {
        tDay: { value: TEX.earthDay }, tNight: { value: TEX.earthNight },
        uSunPos: { value: new T.Vector3() }
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        ${LOG_V}
        void main(){
          vUv = uv;
          vN = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          ${LOG_V_MAIN}
        }`,
      fragmentShader: `
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        uniform sampler2D tDay, tNight;
        uniform vec3 uSunPos;
        ${LOG_F}
        void main(){
          ${LOG_F_MAIN}
          vec3 N = normalize(vN);
          vec3 V = normalize(-vW);
          vec3 L = normalize(uSunPos - vW);
          float ndl = dot(N, L);
          vec3 day = texture2D(tDay, vUv).rgb;
          vec3 night = texture2D(tNight, vUv).rgb;
          float dayF = smoothstep(-0.10, 0.22, ndl);
          // 海洋镜面高光（用蓝色度近似海洋掩码）
          float ocean = clamp((day.b - max(day.r, day.g))*3.0, 0.0, 1.0);
          vec3 H = normalize(L + V);
          float spec = pow(clamp(dot(N, H), 0.0, 1.0), 90.0) * ocean * clamp(ndl, 0.0, 1.0);
          vec3 col = day * (max(ndl, 0.0)*2.8 + 0.015) * dayF;
          col += vec3(1.0, 0.95, 0.85) * spec * 1.4;
          col += night * vec3(1.0, 0.82, 0.55) * 2.4 * smoothstep(0.06, -0.16, ndl);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    gasMats.push(m);   // 复用 uSunPos 更新列表
    return m;
  }

  // 地球云层
  function cloudMat() {
    const m = new T.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { tC: { value: TEX.earthClouds }, uSunPos: { value: new T.Vector3() } },
      vertexShader: `
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        ${LOG_V}
        void main(){
          vUv = uv;
          vN = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          ${LOG_V_MAIN}
        }`,
      fragmentShader: `
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        uniform sampler2D tC; uniform vec3 uSunPos;
        ${LOG_F}
        void main(){
          ${LOG_F_MAIN}
          vec3 N = normalize(vN);
          vec3 L = normalize(uSunPos - vW);
          float ndl = dot(N, L);
          float c = texture2D(tC, vUv).r;
          float a = smoothstep(0.12, 0.62, c);
          float lit = max(ndl, 0.0)*2.6 + 0.02;
          vec3 col = vec3(1.0, 0.99, 0.97) * lit;
          gl_FragColor = vec4(col, a*0.92);
        }`
    });
    gasMats.push(m);
    return m;
  }

  // 大气壳层：Rayleigh + Mie 单次散射（相机恒在原点）
  function atmosphereMat(R, Ra, betaR, betaM, Hr, Hm, strength) {
    const m = new T.ShaderMaterial({
      transparent: true, blending: T.AdditiveBlending, depthWrite: false,
      uniforms: {
        uPlanetPos: { value: new T.Vector3() }, uSunPos: { value: new T.Vector3() },
        uR: { value: R }, uRa: { value: Ra },
        uBetaR: { value: new T.Vector3(...betaR) }, uBetaM: { value: betaM },
        uHr: { value: Hr }, uHm: { value: Hm }, uStr: { value: strength }
      },
      vertexShader: `
        varying vec3 vW;
        ${LOG_V}
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          ${LOG_V_MAIN}
        }`,
      fragmentShader: `
        varying vec3 vW;
        uniform vec3 uPlanetPos, uSunPos, uBetaR;
        uniform float uR, uRa, uBetaM, uHr, uHm, uStr;
        ${LOG_F}
        vec2 sphIntersect(vec3 ro, vec3 rd, vec3 c, float r){
          vec3 oc = ro - c;
          float b = dot(oc, rd);
          float cc = dot(oc, oc) - r*r;
          float h = b*b - cc;
          if (h < 0.0) return vec2(-1.0);
          h = sqrt(h);
          return vec2(-b - h, -b + h);
        }
        float density(vec3 p, vec3 c, float H){
          return exp(-(length(p - c) - uR) / H);
        }
        void main(){
          ${LOG_F_MAIN}
          vec3 ro = vec3(0.0);
          vec3 rd = normalize(vW);
          vec2 tA = sphIntersect(ro, rd, uPlanetPos, uRa);
          if (tA.y < 0.0) discard;
          float t0 = max(tA.x, 0.0);
          float t1 = tA.y;
          vec2 tP = sphIntersect(ro, rd, uPlanetPos, uR);
          if (tP.x > 0.0) t1 = min(t1, tP.x);      // 被行星本体挡住
          if (t1 <= t0) discard;
          vec3 L = normalize(uSunPos - uPlanetPos);
          const int N = 12;
          float dt = (t1 - t0) / float(N);
          vec3 sumR = vec3(0.0), sumM = vec3(0.0);
          float odR = 0.0, odM = 0.0;
          for (int i = 0; i < N; i++){
            vec3 p = ro + rd*(t0 + (float(i) + 0.5)*dt);
            float hR = density(p, uPlanetPos, uHr)*dt;
            float hM = density(p, uPlanetPos, uHm)*dt;
            odR += hR; odM += hM;
            // 太阳方向光学厚度（4 步）
            vec2 tS = sphIntersect(p, L, uPlanetPos, uRa);
            float sLen = max(tS.y, 0.0) / 4.0;
            float sR = 0.0, sM = 0.0;
            bool blocked = false;
            vec2 tSP = sphIntersect(p, L, uPlanetPos, uR);
            if (tSP.x > 0.001) blocked = true;
            for (int j = 0; j < 4; j++){
              vec3 sp = p + L*(float(j) + 0.5)*sLen;
              sR += density(sp, uPlanetPos, uHr)*sLen;
              sM += density(sp, uPlanetPos, uHm)*sLen;
            }
            vec3 tau = uBetaR*(odR + sR) + vec3(uBetaM*1.1)*(odM + sM);
            vec3 att = blocked ? vec3(0.0) : exp(-tau);
            sumR += att*hR;
            sumM += att*hM;
          }
          float mu = dot(rd, L);
          float phR = 0.0596831*(1.0 + mu*mu);                       // 3/(16π)
          float g = 0.76;
          float phM = 0.0795775*(1.0 - g*g) / pow(1.0 + g*g - 2.0*g*mu, 1.5);
          vec3 col = (sumR*uBetaR*phR + sumM*vec3(uBetaM)*phM) * uStr;
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    atmoMats.push(m);
    return m;
  }

  // 土星环
  function ringMat(planetR) {
    const m = new T.ShaderMaterial({
      transparent: true, side: T.DoubleSide, depthWrite: false,
      uniforms: {
        uPlanetPos: { value: new T.Vector3() }, uSunPos: { value: new T.Vector3() },
        uR: { value: planetR }, uInner: { value: 3.9 }, uOuter: { value: 6.9 }
      },
      vertexShader: `
        varying vec3 vW; varying vec3 vLocal; varying vec3 vNW;
        ${LOG_V}
        void main(){
          vLocal = position;
          vNW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          ${LOG_V_MAIN}
        }`,
      fragmentShader: `
        varying vec3 vW; varying vec3 vLocal; varying vec3 vNW;
        uniform vec3 uPlanetPos, uSunPos;
        uniform float uR, uInner, uOuter;
        ${GLSL_NOISE}
        ${LOG_F}
        void main(){
          ${LOG_F_MAIN}
          float r = length(vLocal.xy);
          float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
          // 径向密度波 + 卡西尼缝 + 恩克缝
          float dens = 0.45 + 0.55*fbm2(vec2(r*22.0, 3.7));
          dens *= 0.55 + 0.45*smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.93, t);
          float cassini = smoothstep(0.60, 0.635, t) * smoothstep(0.685, 0.65, t);
          float encke = smoothstep(0.875, 0.885, t) * smoothstep(0.90, 0.89, t);
          dens *= 1.0 - 0.88*cassini;
          dens *= 1.0 - 0.7*encke;
          float a = dens * 0.88;
          if (a < 0.01) discard;

          vec3 N = normalize(vNW);
          vec3 V = normalize(-vW);
          vec3 L = normalize(uSunPos - vW);
          float ndl = abs(dot(N, L));
          // 前向散射：太阳在环后时透亮
          float fwd = pow(clamp(dot(L, -V), 0.0, 1.0), 6.0);
          // 行星本影
          vec3 toSun = uSunPos - vW;
          float sunDist = length(toSun);
          vec3 Ld = toSun / sunDist;
          vec3 pc = uPlanetPos - vW;
          float tca = dot(pc, Ld);
          float shadow = 1.0;
          if (tca > 0.0 && tca < sunDist) {
            float d2 = dot(pc, pc) - tca*tca;
            shadow = smoothstep(uR*uR*0.96, uR*uR*1.06, d2);
          }
          vec3 alb = mix(vec3(0.62,0.55,0.44), vec3(0.85,0.78,0.64), fbm2(vec2(r*9.0, 11.0)));
          vec3 col = alb * (ndl*2.2*shadow + 0.02) + alb*fwd*0.9*shadow;
          gl_FragColor = vec4(col, a);
        }`
    });
    ringMats.push(m);
    return m;
  }

  /* ---------- 组装天体 ---------- */
  const SEG = LOWQ ? [40, 28] : [72, 48];
  BODIES.forEach(b => {
    if (b.key === 'sun') { bodyGroups.sun = { group: sunMesh, mesh: sunMesh, worldPos: new T.Vector3() }; return; }
    const group = new T.Group();
    const tiltG = new T.Group();
    tiltG.rotation.z = T.MathUtils.degToRad(b.tilt);
    group.add(tiltG);
    let mesh;
    if (b.key === 'earth') {
      mesh = new T.Mesh(new T.SphereGeometry(b.r, SEG[0], SEG[1]), earthMat());
      const clouds = new T.Mesh(new T.SphereGeometry(b.r*1.012, SEG[0], SEG[1]), cloudMat());
      clouds.renderOrder = 2;
      tiltG.add(clouds);
      const atmo = new T.Mesh(
        new T.SphereGeometry(b.r*1.05, SEG[0], SEG[1]),
        atmosphereMat(b.r, b.r*1.05, [0.42, 1.05, 2.5], 0.12, b.r*0.013, b.r*0.007, 9.0));
      atmo.renderOrder = 3;
      group.add(atmo);
      b.clouds = clouds;
    } else if (GAS_CFG[b.key]) {
      mesh = new T.Mesh(new T.SphereGeometry(b.r, SEG[0], SEG[1]), gasGiantMat(GAS_CFG[b.key]));
    } else if (b.key === 'venus') {
      mesh = new T.Mesh(new T.SphereGeometry(b.r, SEG[0], SEG[1]),
        TEX.venus ? rockyMat(TEX.venus, { bump: 0 }) : new T.MeshStandardMaterial({ color: 0xd8b878, roughness: 1 }));
    } else {
      const tex = TEX[b.key];
      mesh = new T.Mesh(new T.SphereGeometry(b.r, SEG[0], SEG[1]),
        tex ? rockyMat(tex, { bump: b.key === 'mars' ? 0.02 : 0.015 })
            : new T.MeshStandardMaterial({ color: 0x998877, roughness: 1 }));
    }
    mesh.userData.key = b.key;
    tiltG.add(mesh);
    pickables.push(mesh);

    if (b.key === 'saturn') {
      const ring = new T.Mesh(new T.RingGeometry(3.9, 6.9, 160, 1), ringMat(b.r));
      ring.rotation.x = -Math.PI/2;
      ring.renderOrder = 1;
      tiltG.add(ring);
      b.ring = ring;
    }

    universe.add(group);
    bodyGroups[b.key] = { group, mesh, tiltG, worldPos: new T.Vector3() };
  });

  /* ---------- 轨道线 ---------- */
  const orbitGroup = new T.Group();
  universe.add(orbitGroup);
  const orbitMat = new T.LineBasicMaterial({ color: 0x3a5278, transparent: true, opacity: 0.38 });
  BODIES.forEach(b => {
    if (!b.d || b.parent) return;
    const pts = [];
    for (let i = 0; i <= 180; i++) {
      const a = i/180 * Math.PI*2;
      pts.push(new T.Vector3(Math.cos(a)*b.d, 0, Math.sin(a)*b.d));
    }
    const line = new T.LineLoop(new T.BufferGeometry().setFromPoints(pts), orbitMat);
    orbitGroup.add(line);
  });
  // 月球轨道（跟随地球）
  const moonOrbitPts = [];
  for (let i = 0; i <= 90; i++) {
    const a = i/90 * Math.PI*2;
    moonOrbitPts.push(new T.Vector3(Math.cos(a)*2.6, 0, Math.sin(a)*2.6));
  }
  const moonOrbit = new T.LineLoop(new T.BufferGeometry().setFromPoints(moonOrbitPts), orbitMat);
  universe.add(moonOrbit);

  /* ---------- 后处理管线 ---------- */
  const postCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new T.Scene();
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  postScene.add(quad);
  const POST_V = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  let rtScene, rtBrightA, rtBrightB, rtQuarter, rtQuarterB, rtLum8, rtLumA, rtLumB;
  function makeRT(w, h, opts) {
    return new T.WebGLRenderTarget(w, h, Object.assign({
      type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
      depthBuffer: false
    }, opts || {}));
  }
  function buildRTs() {
    [rtScene, rtBrightA, rtBrightB, rtQuarter, rtQuarterB, rtLum8, rtLumA, rtLumB].forEach(r => r && r.dispose());
    const w = Math.floor(W*DPR), h = Math.floor(H*DPR);
    rtScene = makeRT(w, h, { depthBuffer: true, samples: MSAA });
    rtBrightA = makeRT(w>>1, h>>1);
    rtBrightB = makeRT(w>>1, h>>1);
    rtQuarter = makeRT(w>>2, h>>2);
    rtQuarterB = makeRT(w>>2, h>>2);
    rtLum8 = makeRT(8, 8, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
    rtLumA = makeRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
    rtLumB = makeRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
  }

  const brightMat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { tSrc: { value: null } },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tSrc;
      void main(){
        vec3 c = texture2D(tSrc, vUv).rgb;
        float l = max(c.r, max(c.g, c.b));
        float knee = 2.6;
        float soft = clamp(l - knee + 0.5, 0.0, 1.0);
        soft = soft*soft*0.25;
        float w = max(soft, l - knee) / max(l, 1e-4);
        gl_FragColor = vec4(c*w, 1.0);
      }`
  });
  const blurMat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { tSrc: { value: null }, uDir: { value: new T.Vector2(1, 0) }, uRes: { value: new T.Vector2(1, 1) } },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir, uRes;
      void main(){
        vec2 px = uDir / uRes;
        vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
        s += texture2D(tSrc, vUv + px*1.3846).rgb * 0.3162162;
        s += texture2D(tSrc, vUv - px*1.3846).rgb * 0.3162162;
        s += texture2D(tSrc, vUv + px*3.2308).rgb * 0.0702703;
        s += texture2D(tSrc, vUv - px*3.2308).rgb * 0.0702703;
        gl_FragColor = vec4(s, 1.0);
      }`
  });
  const downMat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { tSrc: { value: null } },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tSrc;
      void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`
  });
  const lum8Mat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { tSrc: { value: null } },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tSrc;
      void main(){
        float acc = 0.0;
        for (int i = 0; i < 6; i++)
          for (int j = 0; j < 6; j++) {
            vec2 uv = (vUv*8.0 + vec2(float(i), float(j)) + 0.5) / 48.0;
            vec3 c = texture2D(tSrc, uv).rgb;
            acc += log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
          }
        gl_FragColor = vec4(acc/36.0, 0.0, 0.0, 1.0);
      }`
  });
  const adaptMat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { tPrev: { value: null }, tCur: { value: null }, uRate: { value: 0.1 }, uInit: { value: 1 } },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tPrev, tCur; uniform float uRate, uInit;
      void main(){
        float cur = texture2D(tCur, vec2(0.5)).r;
        float prev = texture2D(tPrev, vec2(0.5)).r;
        if (uInit > 0.5) { gl_FragColor = vec4(log2(0.10), 0.0, 0.0, 1.0); return; }
        gl_FragColor = vec4(mix(prev, cur, uRate), 0.0, 0.0, 1.0);
      }`
  });

  // AgX（three r185 官方实现移植）+ 曝光 + 暗角 + 颗粒
  const compMat = new T.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      tSrc: { value: null }, tBloomA: { value: null }, tBloomQ: { value: null },
      tLum: { value: null }, uTime: { value: 0 }, uRes: { value: new T.Vector2(1, 1) },
      uBloom: { value: LOWQ ? 0.55 : 0.85 }, uExposure: { value: 1.3 },
      uAuto: { value: 1 }, uGrain: { value: 0.02 }, uVig: { value: 0.24 }
    },
    vertexShader: POST_V,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D tSrc, tBloomA, tBloomQ, tLum;
      uniform float uTime, uBloom, uExposure, uAuto, uGrain, uVig;
      uniform vec2 uRes;
      const mat3 LIN_SRGB_TO_REC2020 = mat3(
        vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
      const mat3 LIN_REC2020_TO_SRGB = mat3(
        vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
      const mat3 AgXInset = mat3(
        vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
        vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
        vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
      const mat3 AgXOutset = mat3(
        vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
        vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
        vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
      vec3 agxContrast(vec3 x){
        vec3 x2 = x*x; vec3 x4 = x2*x2;
        return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
      }
      vec3 agx(vec3 color){
        color = LIN_SRGB_TO_REC2020 * color;
        color = AgXInset * color;
        color = max(color, 1e-10);
        color = log2(color);
        color = (color - (-12.47393)) / (4.026069 - (-12.47393));
        color = clamp(color, 0.0, 1.0);
        color = agxContrast(color);
        color = AgXOutset * color;
        color = pow(max(vec3(0.0), color), vec3(2.2));
        color = LIN_REC2020_TO_SRGB * color;
        return clamp(color, 0.0, 1.0);
      }
      vec3 lin2srgb(vec3 c){
        return mix(12.92*c, 1.055*pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
      }
      float hash12(vec2 p){
        vec3 p3 = fract(vec3(p.xyx)*0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y)*p3.z);
      }
      void main(){
        vec3 col = texture2D(tSrc, vUv).rgb;
        vec3 bloom = texture2D(tBloomA, vUv).rgb*0.6 + texture2D(tBloomQ, vUv).rgb*0.4;
        col += bloom * uBloom;
        // 自适应曝光（8×8 log 亮度 → 1×1 时间平滑），clamp ±12%
        float adaptLum = exp2(texture2D(tLum, vec2(0.5)).r);
        float evAuto = clamp(pow(0.10 / max(adaptLum, 1e-4), 0.85), 0.88, 1.12);
        float ev = uExposure * mix(1.0, evAuto, uAuto);
        col = agx(col * ev);
        // 暗角
        float d = length((vUv - 0.5) * vec2(uRes.x/uRes.y, 1.0));
        col *= 1.0 - uVig * smoothstep(0.42, 1.05, d);
        col = lin2srgb(col);
        // 颗粒（显示空间）
        col += (hash12(vUv*uRes + fract(uTime)*371.0) - 0.5) * uGrain;
        gl_FragColor = vec4(col, 1.0);
      }`
  });

  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(postScene, postCam);
  }

  /* ---------- 相机控制（浮动原点） ---------- */
  const cam = {
    theta: 0.65, phi: 1.12, r: 560,
    gTheta: 0.65, gPhi: 1.12, gR: 560,
    target: new T.Vector3(), gTarget: new T.Vector3(),
    focus: null
  };
  const camWorld = new T.Vector3();
  const origin = new T.Vector3();
  const tmpV = new T.Vector3();

  function focusBody(key, instant) {
    const b = BY_KEY[key];
    if (!b) return;
    cam.focus = key;
    cam.gR = key === 'sun' ? b.r*4.5 : Math.max(b.r*5.2, 2.2);
    if (instant) {
      cam.r = cam.gR;
      const wp = bodyGroups[key].worldPos;
      cam.target.copy(wp); cam.gTarget.copy(wp);
    }
    updateInfo(b);
    document.getElementById('hFocus').textContent = b.name;
    document.querySelectorAll('#navRow button').forEach(el =>
      el.classList.toggle('on', el.dataset.key === key));
  }
  function goHome(instant) {
    cam.focus = null;
    cam.gTarget.set(0, 0, 0);
    cam.gR = 560; cam.gTheta = 0.65; cam.gPhi = 1.12;
    if (instant) { cam.target.set(0, 0, 0); cam.r = 560; cam.theta = 0.65; cam.phi = 1.12; }
    document.getElementById('info').classList.add('hide');
    document.getElementById('hFocus').textContent = '全景';
    document.querySelectorAll('#navRow button').forEach(el => el.classList.remove('on'));
  }
  function minR() {
    if (!cam.focus) return 14;
    const b = BY_KEY[cam.focus];
    return b.r * (cam.focus === 'earth' ? 1.9 : 1.6);
  }

  let dragging = false, moved = 0, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', e => {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('drag');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    cam.gTheta -= dx * 0.005;
    cam.gPhi = T.MathUtils.clamp(cam.gPhi - dy*0.005, 0.05, Math.PI - 0.05);
  });
  canvas.addEventListener('pointerup', e => {
    dragging = false;
    canvas.classList.remove('drag');
    if (moved < 6) pick(e.clientX, e.clientY);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    cam.gR = T.MathUtils.clamp(cam.gR * Math.exp(e.deltaY*0.0011), minR(), 2800);
  }, { passive: false });

  const raycaster = new T.Raycaster();
  function pick(px, py) {
    const ndc = new T.Vector2((px/W)*2 - 1, -(py/H)*2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    if (hits.length) focusBody(hits[0].object.userData.key);
  }

  /* ---------- UI ---------- */
  const SPEEDS = [0.25, 1, 2, 8, 30, 120, 500];
  let speedIdx = 2, paused = false;
  let simDays = Q.has('t') ? parseFloat(Q.get('t')) : 0;
  const EPOCH = Date.UTC(2026, 10, 17);

  const navRow = document.getElementById('navRow');
  BODIES.forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.name;
    btn.dataset.key = b.key;
    btn.onclick = () => focusBody(b.key);
    navRow.appendChild(btn);
  });
  function speedLabel() {
    const s = SPEEDS[speedIdx];
    return paused ? '已暂停' : (s < 1 ? s + ' 天/秒' : s + ' 天/秒');
  }
  function refreshSpeed() {
    document.getElementById('speed').textContent = speedLabel();
    document.getElementById('hSpeed').textContent = speedLabel();
    document.getElementById('btnPause').textContent = paused ? '▶' : '⏸';
  }
  document.getElementById('btnPause').onclick = () => { paused = !paused; refreshSpeed(); };
  document.getElementById('btnSlower').onclick = () => { speedIdx = Math.max(0, speedIdx - 1); refreshSpeed(); };
  document.getElementById('btnFaster').onclick = () => { speedIdx = Math.min(SPEEDS.length - 1, speedIdx + 1); refreshSpeed(); };
  document.getElementById('btnHome').onclick = () => goHome();
  document.getElementById('infoClose').onclick = () => goHome();
  const btnOrbits = document.getElementById('btnOrbits');
  const btnLabels = document.getElementById('btnLabels');
  let showOrbits = Q.get('orbits') !== '0', showLabels = Q.get('labels') !== '0';
  btnOrbits.classList.toggle('on', showOrbits);
  btnLabels.classList.toggle('on', showLabels);
  btnOrbits.onclick = () => { showOrbits = !showOrbits; btnOrbits.classList.toggle('on', showOrbits); };
  btnLabels.onclick = () => { showLabels = !showLabels; btnLabels.classList.toggle('on', showLabels); };
  if (Q.get('hud') === '0') document.body.classList.add('nohud');

  function updateInfo(b) {
    document.getElementById('iName').textContent = b.name;
    document.getElementById('iEn').textContent = b.en;
    document.getElementById('iKv').innerHTML =
      '<span>直径</span><span>' + b.diam + '</span>' +
      '<span>轨道</span><span>' + b.au + '</span>' +
      '<span>公转</span><span>' + b.per + '</span>' +
      '<span>自转</span><span>' + b.day + '</span>' +
      '<span>温度</span><span>' + b.temp + '</span>';
    document.getElementById('iDesc').textContent = b.desc;
    document.getElementById('info').classList.remove('hide');
  }

  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); paused = !paused; refreshSpeed(); }
    else if (e.key === 'Escape') goHome();
    else if (e.key === 'l' || e.key === 'L') btnLabels.click();
    else if (e.key === 'o' || e.key === 'O') btnOrbits.click();
    else if (e.key >= '0' && e.key <= '9') {
      const i = parseInt(e.key, 10);
      focusBody(i === 0 ? 'sun' : BODIES[i].key);
    }
  });

  /* ---------- 标签 ---------- */
  const labelBox = document.getElementById('labels');
  const labelEls = {};
  BODIES.forEach(b => {
    const el = document.createElement('div');
    el.className = 'tag';
    el.textContent = b.name;
    el.onclick = () => focusBody(b.key);
    labelBox.appendChild(el);
    labelEls[b.key] = el;
  });
  function updateLabels() {
    const items = [];
    BODIES.forEach(b => {
      const el = labelEls[b.key];
      if (!showLabels) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
      tmpV.copy(bodyGroups[b.key].worldPos).sub(origin);
      const dist = tmpV.length();
      // 视直径太小（<3px）且未聚焦时隐藏标签，避免全景时内行星标签堆叠
      const pxSize = (b.r / Math.max(dist, 1e-3)) / 0.8727 * H;
      if (b.key !== 'sun' && cam.focus !== b.key && pxSize < 3) {
        el.style.opacity = 0; el.style.pointerEvents = 'none'; return;
      }
      tmpV.project(camera);
      if (tmpV.z > 1 || tmpV.z < -1) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
      const x = (tmpV.x*0.5 + 0.5)*W, y = (-tmpV.y*0.5 + 0.5)*H;
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
      // HUD 为透明文字，标签落入其矩形区会透叠 → 排除
      if (x < 480 && y < 310) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
      // 太近（已聚焦）或太远时淡出
      let op = 1;
      if (cam.focus === b.key) op = 0;
      else if (b.key !== 'sun' && dist > 1500) op = 0.35;
      items.push({ el, x, y, op });
    });
    // 防重叠：按 y 排序后强制最小间距
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      if (Math.abs(items[i].x - items[i-1].x) < 60 && items[i].y - items[i-1].y < 24)
        items[i].y = items[i-1].y + 24;
    }
    items.forEach(it => {
      it.el.style.opacity = it.op;
      it.el.style.pointerEvents = it.op > 0 ? 'auto' : 'none';
      it.el.style.left = it.x + 'px';
      it.el.style.top = it.y + 'px';
    });
  }

  /* ---------- 尺寸 ---------- */
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    renderer.setPixelRatio(DPR);
    renderer.setSize(W, H);
    camera.aspect = W/H;
    camera.updateProjectionMatrix();
    buildRTs();
    compMat.uniforms.uRes.value.set(W*DPR, H*DPR);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- URL 初始状态 ---------- */
  if (Q.has('cam')) {
    const c = Q.get('cam').split(',').map(Number);
    if (c.length === 3) { cam.theta = cam.gTheta = c[0]; cam.phi = cam.gPhi = c[1]; cam.r = cam.gR = c[2]; }
  }
  if (Q.has('speed')) {
    const s = parseFloat(Q.get('speed'));
    let best = 0;
    SPEEDS.forEach((v, i) => { if (Math.abs(v - s) < Math.abs(SPEEDS[best] - s)) best = i; });
    speedIdx = best;
  }
  if (Q.get('pause') === '1') paused = true;
  refreshSpeed();
  const initFocus = Q.get('focus');
  if (initFocus && BY_KEY[initFocus]) focusBody(initFocus, true); else goHome(true);

  /* ---------- 主循环 ---------- */
  const startAngles = { mercury: 0.8, venus: 2.4, earth: 4.4, mars: 1.6, jupiter: 5.3, saturn: 3.4, uranus: 0.4, neptune: 2.0, moon: 1.0 };
  let last = performance.now(), fpsAcc = 0, fpsN = 0, fpsTimer = 0;
  let lumPing = 0, firstFrames = 0;
  const sunWorld = new T.Vector3(0, 0, 0);

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min((now - last)/1000, 0.1);
    last = now;
    const t = now/1000;

    if (!paused) simDays += dt * SPEEDS[speedIdx];

    // 天体位置（JS double，世界坐标）
    BODIES.forEach(b => {
      if (b.key === 'sun') return;
      const rec = bodyGroups[b.key];
      const ang = startAngles[b.key] + (b.T ? simDays/b.T * Math.PI*2 : 0);
      if (b.parent) {
        const pw = bodyGroups[b.parent].worldPos;
        rec.worldPos.set(pw.x + Math.cos(ang)*b.d, pw.y, pw.z + Math.sin(ang)*b.d);
      } else {
        rec.worldPos.set(Math.cos(ang)*b.d, 0, Math.sin(ang)*b.d);
      }
      rec.group.position.copy(rec.worldPos);
      // 自转（视觉加速：真实自转在多数流速下不可见，按 20× 呈现）
      const rotSpd = (b.rot ? Math.PI*2/(b.rot*86400) : 0) * 20;
      rec.mesh.rotation.y = simDays * 86400 * rotSpd;
      if (b.clouds) b.clouds.rotation.y = simDays * 86400 * rotSpd * 1.12;
    });
    moonOrbit.position.copy(bodyGroups.earth.worldPos);

    // 相机阻尼
    if (cam.focus) cam.gTarget.copy(bodyGroups[cam.focus].worldPos);
    const k = 1 - Math.exp(-dt*4.2);
    cam.theta += (cam.gTheta - cam.theta)*k;
    cam.phi += (cam.gPhi - cam.phi)*k;
    cam.r += (cam.gR - cam.r)*k;
    cam.target.lerp(cam.gTarget, k);
    cam.r = Math.max(cam.r, minR()*0.9);

    camWorld.set(
      cam.target.x + cam.r*Math.sin(cam.phi)*Math.cos(cam.theta),
      cam.target.y + cam.r*Math.cos(cam.phi),
      cam.target.z + cam.r*Math.sin(cam.phi)*Math.sin(cam.theta));
    origin.copy(camWorld);                       // 浮动原点：相机恒在 (0,0,0)
    universe.position.copy(origin).negate();
    camera.position.set(0, 0, 0);
    tmpV.copy(cam.target).sub(origin);
    camera.lookAt(tmpV);
    const near = Math.max(0.02, cam.r*0.0015);
    if (Math.abs(near - camera.near)/camera.near > 0.02) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }

    // shader uniforms（渲染空间 = 世界 - origin）
    const sunRender = tmpV.copy(sunWorld).sub(origin);
    gasMats.forEach(m => { if (m.uniforms.uSunPos) m.uniforms.uSunPos.value.copy(sunRender); });
    atmoMats.forEach(m => {
      m.uniforms.uSunPos.value.copy(sunRender);
      m.uniforms.uPlanetPos.value.copy(bodyGroups.earth.worldPos).sub(origin);
    });
    ringMats.forEach(m => {
      m.uniforms.uSunPos.value.copy(sunRender);
      m.uniforms.uPlanetPos.value.copy(bodyGroups.saturn.worldPos).sub(origin);
    });
    sunMat.uniforms.uTime.value = t;
    coronaMat.uniforms.uTime.value = t;
    skyMat.uniforms.uTime.value = t;
    corona.position.set(0, 0, 0);
    orbitGroup.visible = showOrbits;
    moonOrbit.visible = showOrbits;

    /* 渲染管线：主场景 → bloom → 亮度自适应 → 合成
       （主场景先渲染，避免冷启动 program 变体问题——星河追梦 Stage 52 的教训） */
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);

    if (firstFrames < 2) { firstFrames++; }

    brightMat.uniforms.tSrc.value = rtScene.texture;
    pass(brightMat, rtBrightA);
    const bw = rtBrightA.width, bh = rtBrightA.height;
    blurMat.uniforms.uRes.value.set(bw, bh);
    blurMat.uniforms.tSrc.value = rtBrightA.texture;
    blurMat.uniforms.uDir.value.set(1, 0); pass(blurMat, rtBrightB);
    blurMat.uniforms.tSrc.value = rtBrightB.texture;
    blurMat.uniforms.uDir.value.set(0, 1); pass(blurMat, rtBrightA);
    blurMat.uniforms.tSrc.value = rtBrightA.texture;
    blurMat.uniforms.uDir.value.set(1, 0); pass(blurMat, rtBrightB);
    blurMat.uniforms.tSrc.value = rtBrightB.texture;
    blurMat.uniforms.uDir.value.set(0, 1); pass(blurMat, rtBrightA);
    downMat.uniforms.tSrc.value = rtBrightA.texture;
    pass(downMat, rtQuarter);
    blurMat.uniforms.uRes.value.set(rtQuarter.width, rtQuarter.height);
    blurMat.uniforms.tSrc.value = rtQuarter.texture;
    blurMat.uniforms.uDir.value.set(1, 0); pass(blurMat, rtQuarterB);
    blurMat.uniforms.tSrc.value = rtQuarterB.texture;
    blurMat.uniforms.uDir.value.set(0, 1); pass(blurMat, rtQuarter);

    lum8Mat.uniforms.tSrc.value = rtScene.texture;
    pass(lum8Mat, rtLum8);
    const prevLum = lumPing === 0 ? rtLumA : rtLumB;
    const curLum = lumPing === 0 ? rtLumB : rtLumA;
    adaptMat.uniforms.tPrev.value = prevLum.texture;
    adaptMat.uniforms.tCur.value = rtLum8.texture;
    adaptMat.uniforms.uRate.value = 1 - Math.exp(-dt*1.4);
    adaptMat.uniforms.uInit.value = firstFrames <= 2 ? 1 : 0;
    pass(adaptMat, curLum);
    lumPing = 1 - lumPing;

    compMat.uniforms.tSrc.value = rtScene.texture;
    compMat.uniforms.tBloomA.value = rtBrightA.texture;
    compMat.uniforms.tBloomQ.value = rtQuarter.texture;
    compMat.uniforms.tLum.value = curLum.texture;
    compMat.uniforms.uTime.value = t;
    pass(compMat, null);
    renderer.setRenderTarget(null);

    // HUD
    fpsAcc += dt; fpsN++; fpsTimer += dt;
    if (fpsTimer > 0.5) {
      document.getElementById('hFps').textContent = Math.round(fpsN/fpsAcc) + ' fps';
      fpsAcc = 0; fpsN = 0; fpsTimer = 0;
      const d = new Date(EPOCH + simDays*86400000);
      document.getElementById('hDate').textContent =
        d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    updateLabels();
  }

  // 等贴图解码完再开场（避免首帧黑球）
  const pending = Object.values(TEX).filter(Boolean);
  let loaded = 0;
  function tryStart() {
    loaded++;
    if (loaded >= pending.length) start();
  }
  function start() {
    document.getElementById('load').classList.add('gone');
    setTimeout(() => { document.getElementById('hint').style.opacity = 0; }, 9000);
    requestAnimationFrame(frame);
  }
  if (!pending.length) start();
  else pending.forEach(tex => {
    if (tex.image && tex.image.complete) tryStart();
    else tex.image ? tex.image.addEventListener('load', tryStart) : tryStart();
    if (tex.image) tex.image.addEventListener('error', tryStart);
  });

  /* ---------- 调试/测试句柄 ---------- */
  window.__solar = {
    focus: focusBody, home: goHome,
    setCam(theta, phi, r) { cam.theta = cam.gTheta = theta; cam.phi = cam.gPhi = phi; cam.r = cam.gR = r; },
    setDays(d) { simDays = d; },
    setSpeedIdx(i) { speedIdx = T.MathUtils.clamp(i, 0, SPEEDS.length-1); refreshSpeed(); },
    pause(v) { paused = v; refreshSpeed(); },
    get simDays() { return simDays; },
    get focusKey() { return cam.focus; },
    bodies: BY_KEY, renderer, camera, scene, universe
  };
})();