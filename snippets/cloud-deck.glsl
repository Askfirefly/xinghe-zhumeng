// cloud-deck.glsl — 天空里的「一整片云海 + 太阳洞」（照 Saltline 的 SALTLINE_SKY 改写）
// 验证：星河追梦 60fps。比 N 张平面云叠着强得多：有云形、有体积、跟随太阳方向。
//
// 前提：在天空 shader 的 fragment 里，d 是归一化视线方向，
//       uSunDir / uZenith / uMid / uCool / uWarm / uNight / uTime 都是现成的。
//       fbm2() 是 5 octave 的 2D fbm，vn2() 是单层 value noise。

{
  float hh   = max(d.y, 0.0);
  vec2  sh2  = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float tsun = max(dot(dh, sh2), 0.0);          // 朝向太阳的方位程度
  float mu   = dot(d, uSunDir);                 // 与太阳的夹角余弦
  float dayC = 1.0 - uNight;

  // ---- 视线打到云层平面上的投影：越贴地平线越密，远处自然收束 ----
  vec2  cuv = d.xz / (hh + 0.085) * vec2(0.62, 0.95);
  vec2  q   = cuv + vec2(-0.010, 0.005) * uTime * 0.12;
  float warp = fbm2(q * 0.42 + 7.1);
  vec2  qq   = q + (warp - 0.5) * 1.15;
  float dens = fbm2(qq * 1.05 + 3.3);
  dens = mix(dens, fbm2(qq * 2.6 + 11.0), 0.45);
  float body = dens * 0.80 + fbm2(q * 0.17 + 3.7) * 0.34;

  // ---- 覆盖：夜里留薄一点，别把银河盖死 ----
  float cov = smoothstep(0.50, 0.80, body) * mix(0.16, 1.0, dayC);

  // ---- ① 朝太阳让开一条"燃烧的空隙" ----
  float edge = mix(0.035, 0.30, pow(tsun, 1.6));
  float rag  = (vn2(q * 0.9 + 11.0) - 0.5) * 0.16 + (dens - 0.5) * 0.10;
  cov *= smoothstep(edge - 0.035, edge + 0.12, hh + rag * (0.35 + tsun));

  // ---- ② 太阳处烧一个洞：云永远不遮住太阳本体 ----
  float hole = smoothstep(0.972, 0.9985, mu + (dens - 0.5) * 0.012);
  cov *= 1.0 - 0.93 * hole;

  // ---- ③ 云底自阴影：朝太阳方向的密度梯度 = 立体感 ----
  vec2  sd2   = normalize(uSunDir.xz + 1e-5);
  float densS = fbm2(qq + sd2 * 0.22);
  float relief = clamp((dens - densS) * 4.5 + 0.5, 0.0, 1.0);
  float thick  = smoothstep(0.45, 0.78, body);

  vec3 coolC = mix(uMid * 0.62, uZenith * 0.40, thick);
  coolC *= 0.55 + 0.95 * relief * relief;
  // 正午是被太阳照亮的白积云；低太阳才变暗蓝/被烧红
  float highSun = smoothstep(0.12, 0.55, uSunDir.y);
  vec3  litCloud = vec3(0.80, 0.84, 0.90) * (0.45 + 0.75 * relief);
  coolC = mix(coolC, litCloud, highSun * (0.6 + 0.4 * relief));
  coolC *= mix(0.28, 1.0, dayC);                         // 夜里只是暗影

  float nearSun = pow(tsun, 5.0) * exp(-max(hh - edge, 0.0) * 4.5) * 0.9
                + pow(max(mu, 0.0), 7.0) * 0.9;
  float lowSun = pow(1.0 - clamp(uSunDir.y, 0.0, 1.0), 1.6);
  vec3  warmC = (uWarm * vec3(1.30, 0.70, 0.44)) * nearSun
              * (0.06 + 2.2 * relief * relief * relief) * (1.0 - uNight * 0.88)
              * mix(0.12, 1.0, lowSun);
  float rimC = cov * (1.0 - cov) * 4.0;                  // 洞边缘的"烧红的边"
  warmC += vec3(1.0, 0.86, 0.66) * rimC * pow(tsun, 4.0)
         * (0.5 + 1.6 * pow(max(mu, 0.0), 6.0)) * (1.0 - 0.85 * hole)
         * (1.0 - uNight * 0.8) * mix(0.35, 1.0, lowSun);

  vec3 cloudC = coolC + warmC;
  vec3 hc2 = mix(uCool, uWarm, pow(tsun, 5.0));
  cloudC = mix(cloudC, hc2 * 0.55 + cloudC * 0.45, exp(-hh * 11.0));   // 远处融进地平线

  col = mix(col, cloudC, cov * 0.985);
}

// 坑：
// 1) 别再用平面云网格叠：它们各自 fbm、各自 alpha，叠起来就是一张白纸
// 2) 云的暖色必须跟太阳高度挂钩（pow(1-sunDir.y, 1.6)），否则正午也是粉的
// 3) 夜里的 cov 要乘一个小系数，否则银河全被盖掉
