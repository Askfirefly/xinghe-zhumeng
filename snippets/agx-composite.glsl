// 来源：深空·太阳系 src/app.js:788-856（合成 pass，look 规格对齐星河追梦）
// look 规格：AgX / 曝光基准 1.3（自适应 ±12%）/ grain 0.02 / vignette 0.24 / 色温基准 5600K。
// AgX 矩阵与 contrast 曲线逐字移植 three r185 tonemapping chunk。
// 输入：tSrc=主场景 RT(HalfFloat)、tBloomA=半分辨率 bloom、tBloomQ=1/4 bloom、
//       tLum=1×1 时间平滑 log 亮度（adapt pass 的 cur RT）。
// 坑：AgX 暗部提升大（linear 0.12 → 显示 ~0.55），背景/银河强度要按显示目标反推。
// 全屏 quad：depthTest/depthWrite false，vertex 用普通 uv passthrough（后处理不需要 logdepth）。

varying vec2 vUv;
uniform sampler2D tSrc, tBloomA, tBloomQ, tLum;
uniform float uTime, uBloom, uExposure, uAuto, uGrain, uVig;
uniform vec2 uRes;
// 推荐值：uBloom 0.85(low 0.55), uExposure 1.3, uAuto 1, uGrain 0.02, uVig 0.24
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
}