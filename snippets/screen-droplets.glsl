// screen-droplets.glsl — 挡风玻璃水珠（SDF 泪滴 + 屏幕背景折射 + 飞溅）
// 已验证：64 颗上限，60fps

/* ---------- 形状：不规则泪滴 ---------- */
float dropSDF(vec2 qv, float seed) {
  float a = atan(qv.y, qv.x);
  float w = 0.045 * sin(a * 2.7 + seed * 2.1)
          + 0.030 * sin(a * 4.3 - seed * 1.3)
          + 0.018 * sin(a * 7.1 + seed * 3.7);   // 无理频率 → 避免花瓣状对称
  return length(qv) / (1.0 + w);
}

/* ---------- 每颗滴 ---------- */
vec2 q = (uv - dr.xy) * vec2(uAspect, 1.0) / dr.z;
q.y += 0.10;                                   // 重力下垂
q.y *= 1.0 / (1.0 + (stretch - 1.0) * 0.75);   // 下滑拉长

float rad = dropSDF(q, float(i) * 1.7);
if (rad < 1.0) {
  float z = pow(max(0.0, 1.0 - rad*rad), 0.70);      // 扁，像贴在玻璃上的透镜
  // 法线：SDF 中心差分
  vec2 grad = vec2(dropSDF(q + dx) - dropSDF(q - dx),
                   dropSDF(q + dy) - dropSDF(q - dy)) / (2.0 * e);
  vec3 n = normalize(vec3(grad, max(0.42, sqrt(1.0 - min(dot(grad,grad), 1.0)))));

  // 折射屏幕背景（关键：不是立方体反射！）
  vec2 lensOff = n.xy * dr.z * (2.2 + 1.6 * edge);
  vec3 lensCol = texture2D(tSoft, clamp(uv + lensOff, 0.002, 0.998)).rgb;
  // 极小的环境反射只做高光
  dropEnv += lensCol * 1.02 * k;
}

/* ---------- 撞击瞬间（0.16 s 炸开）---------- */
float burst = (1.0 - smoothstep(0.0, 0.16, uDropAge[i])) * (tiny ? 0.0 : 1.0);
// 轮廓加 7/13 次谐波（幅度减半 0.085/0.055，全幅会像长刺的星星）
rad += burst * (0.085 * sin(aa*7.0 + seed*4.0) + 0.055 * sin(aa*13.0 - seed*2.3));

/* ---------- 飞溅：真实子滴 ---------- */
// 主滴生成时撒 14–21 颗子滴，各自带径向初速、寿命 0.3–0.85 s
// 小滴（r < 0.0045）走简化着色：只做 warp + 亮边，跳过大纹理采样

/* ---------- 水膜 ---------- */
float film = smoothstep(0.40, 0.74, fbm2c(uv*vec2(3.1,1.7) + vec2(0,-t*0.028)) * 0.62);
col = mix(col, texture2D(tSoft, uv + fOff).rgb * 1.05, film * 0.22);

// 坑：
// 1. 用立方体环境贴图 → 水珠像玻璃球（错误）；必须折射屏幕背景
// 2. 高光/边缘环太亮 → 一排小光点，像镜头光晕
// 3. 形状用 3/5/9 次谐波 → 花瓣形；用无理频率 2.7/4.3/7.1
// 4. 炸开用全幅谐波 → 长刺的星星；用半幅 + 真实子滴
