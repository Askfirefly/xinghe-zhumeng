// 来源：深空·太阳系 src/app.js:134-210（改自星河追梦 starfield.glsl）
// 用法：BackSide 大球（radius 5000，depthWrite/depthTest false，renderOrder -100），
//       球心跟随相机（浮动原点下相机恒在原点，直接 add 到 scene 即可）。
// 依赖：noise.glsl（hash13/hash33/fbm2）+ logdepth-chunks.js。
// 要点：银河经度用圆周坐标 circ=(cos glon, sin glon) 进噪声 → 无 ±π 接缝；
//       乳光强度按 AgX 暗部提升反推（band 0.032 / halo 0.010 / neb 0.07），再大就灰雾。

// ---- vertex ----
varying vec3 vDir;
// ${LOG_V}
void main(){
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // ${LOG_V_MAIN}
}

// ---- fragment ----
varying vec3 vDir;
uniform float uTime; uniform int uLayers;   // uLayers: 2/3/4 随画质档
// ${GLSL_NOISE} ${LOG_F}
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
  // ${LOG_F_MAIN}
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

  // 星点层（银河带内更密、尘 lane 处更疏）
  vec3 st = starLayer(dir, 300.0, 0.020, 0.0, 1.0, band, lane);
  st += starLayer(dir, 520.0, 0.0125, 19.0, 0.85, band, lane);
  if (uLayers >= 3) st += starLayer(dir, 780.0, 0.0065, 41.0, 1.55, band, lane);
  if (uLayers >= 4) st += starLayer(dir, 1500.0, 0.030, 73.0, 0.55, band, lane);
  col += st * 0.6;   // >1 会被 bloom knee 2.6 抓走变成雪团，0.6 保持星点锐利

  gl_FragColor = vec4(col, 1.0);
}