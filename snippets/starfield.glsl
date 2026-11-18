// starfield.glsl — 星空 + 银河（3 层星场 + 指数衰减银河 + 照片纹理）
// 已验证：星点尺寸以月亮为基准，银河结构用实测剖面

/* ---------- 星点层 ---------- */
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.yzx+33.33); return fract((p.x+p.y)*p.z); }
vec3  hash33(vec3 p){ p = fract(p*vec3(0.1031,0.1030,0.0973)); p += dot(p, p.yxz+33.33);
                      return fract((p.xxy+p.yxx)*p.zyx); }

vec3 starTint(float t) {           // 色温四段
  vec3 c1 = vec3(0.62,0.74,1.00);  // O/B 蓝白
  vec3 c2 = vec3(0.97,0.98,1.00);  // A 白
  vec3 c3 = vec3(1.00,0.92,0.76);  // G 黄白
  vec3 c4 = vec3(1.00,0.68,0.46);  // K/M 橙红
  vec3 c = mix(c1, c2, smoothstep(0.0, 0.32, t));
  c = mix(c, c3, smoothstep(0.32, 0.64, t));
  return mix(c, c4, smoothstep(0.64, 1.0, t));
}

vec3 starLayer(vec3 dir, float scale, float dens, float seed, float bright,
               float bandSig, float laneSig) {
  vec3 p = dir * scale + seed;
  vec3 cell = floor(p);
  float dm = dens * (1.0 + 3.0 * bandSig) * (1.0 - 0.8 * laneSig);
  if (hash13(cell) >= dm) return vec3(0.0);
  vec3 sdir = normalize(cell + hash33(cell + 11.0));
  vec3 dd = dir - sdir;
  float ang = length(dd);
  float mag = pow(hash13(cell + 57.0), 3.2);        // 幂律：暗星远多于亮星
  float size = mix(0.00042, 0.00105, mag) * bright; // 月面 0.52° 的 1/9~1/22
  float core = exp(-pow(ang / size, 2.0));
  return starTint(hash13(cell + 13.0)) * core * (0.55 + 3.4 * mag);
}

// 用法：
// vec3 st = starLayer(sd, 300.0, 0.020, 0.0, 1.0, armSig, laneSig)
//         + starLayer(sd, 520.0, 0.0125, 19.0, 0.85, armSig, laneSig)
//         + starLayer(sd, 780.0, 0.0065, 41.0, 1.55, armSig, laneSig);
// col += st * 2.0 * smoothstep(0.35, 0.90, uNight) * horizonFade;

/* ---------- 银河：指数衰减（实测不是高斯）---------- */
// 从参考照片旋转对齐后逐行统计亮度，得到 L(d)/L(0)：
//   d=100 → 0.45, d=140 → 0.30, d=200 → 0.17, d=240 → 0.10
// 高斯拟合在 d=200 只有 0.04（尾巴掉太快 → 边缘硬、和夜空割裂）
// 指数 exp(-d/126) 拟合 0.20，与实际吻合
float dLat = abs(glat);
float coreB = exp(-dLat / 0.050);
float mainB = exp(-dLat / 0.256);   // 主带 e 折 ≈ 14.7°
float haloB = exp(-dLat / 0.640);   // 长尾融进夜空

// 三层配色（取自照片像素均值）
vec3 cWarm = vec3(1.00, 0.86, 0.80);   // 核心暖白
vec3 cMid  = vec3(0.95, 0.87, 0.82);   // 主带
vec3 cCool = vec3(0.56, 0.60, 0.74);   // 外圈冷蓝
vec3 cDust = vec3(0.035, 0.024, 0.019);// 暗尘深褐

// 沿臂亮度：从同一张照片提取 512 点一维曲线（首尾交叉淡化做周期化），
// 存 512×1 PNG，shader 里 vec2(glon*0.15915+0.5, 0.5) 采样

// 尘埃：照片裁 256² → 半幅循环平移 + 圆形权重混合 → 可平铺纹理
//   vec2 duv = vec2(glon * 1.2732, glat * 4.2);   // 整数倍重复，接缝连续

// 坑：
// 1. 噪声采样用 glon 直接采样 → atan 在 ±π 有接缝，天上一道硬直边。
//    必须换成圆周坐标 vec2(cos(glon), sin(glon))
// 2. glBand 用高斯 → 边缘硬；用指数
