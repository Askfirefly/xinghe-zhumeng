// 来源：深空·太阳系 src/app.js:298-369（气态行星条带 + 大红斑/大暗斑）
// 依赖：noise.glsl（fbm3）+ logdepth-chunks.js。
// 核心坑：经度 lon=atan(on.z,on.x) 在 ±π 跳变，**线性 lon 进噪声 = 球面竖直缝**。
//         解法：lon 只以 (cos,sin) 圆周坐标进噪声；时间演化用 lon±t 旋转圆周坐标。
// 条带感来源：warp 各向异性（经度方向低频 1.3、纬度方向 5.0）→ 湍流沿纬向拉伸。
// uniforms: uTime,uSeed,uSpot(0/1),uColA,uColB,uColC,uSpotCol,uSunPos(渲染空间)
// varyings: vN(视空间法线), vW(渲染空间位置), vObjN(物体空间法线)

// ---- fragment ----
varying vec3 vN; varying vec3 vW; varying vec3 vObjN;
uniform float uTime, uSeed, uSpot;
uniform vec3 uColA, uColB, uColC, uSpotCol, uSunPos;
// ${GLSL_NOISE} ${LOG_F}
void main(){
  // ${LOG_F_MAIN}
  vec3 N = normalize(vN);
  vec3 V = normalize(-vW);                 // 浮动原点：相机恒在原点
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

  // 大红斑 / 大暗斑：椭圆涡旋（dl 用 atan(sin,cos) 回绕 → 无缝）
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
  // 1.9 而非更高：HDR 过曝会被 AgX 去饱和，条带发白
  vec3 col = alb * (diff * 1.9 * (0.62 + 0.38*mu) + 0.012);
  gl_FragColor = vec4(col, 1.0);
}

// 参考配色（sRGB hex → THREE.Color）：
// jupiter: a#a97a50 b#e9d8bc c#7d4e2e spot#a8442a
// saturn : a#c2a678 b#efe3c4 c#a88c60 (无斑)
// uranus : a#7fc4cf b#b8e4ea c#6aa8b8 (无斑)
// neptune: a#2a52c8 b#5a86e8 c#1a3488 spot#16245e