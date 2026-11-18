// pcss-shadows.js — 改写 three 的 shadow chunk 做软阴影（16 tap Vogel 圆盘 + IGN 旋转）
// 验证：three r185，星河追梦 60.2fps。
//
// 为什么不用完整 PCSS：完整版要先 blocker search 读出遮挡物深度，但 three 的阴影贴图是
// sampler2DShadow（比较采样器），读不出原始深度。Saltline 读的是 RGBADepth 打包纹理所以能做。
// 想上完整版得自挂一张 depth RT；这里用「更宽核 + 每像素旋转」先拿到 80% 的观感。

(function patchShadowPCSS() {
  const key = 'shadowmap_pars_fragment';
  const src = THREE.ShaderChunk[key];
  if (!src || src.indexOf('SL_PCSS') >= 0) return;
  const i = src.indexOf('float getShadow( sampler2DShadow');
  if (i < 0) { console.warn('[shadow] chunk layout changed, keep stock PCF'); return; }
  // 括号配对找函数体
  let j = src.indexOf('{', i), depth = 0, end = -1;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) return;
  const repl = `float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  /* SL_PCSS */
  float shadow = 1.0;
  float distW = max(shadowCoord.w, 1.0);        // ★ 先存 w，下面除法会把它变成 1
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;
  bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
  bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
  if ( frustumTest ) {
    vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
    float pen = shadowRadius * ( 0.85 + 0.15 * clamp( distW * 0.02, 0.0, 1.0 ) );
    float radius = pen * texelSize.x;
    float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
    float sum = 0.0;
    for ( int k = 0; k < 16; k ++ ) {
      vec2 o = vogelDiskSample( k, 16, phi ) * radius;
      sum += texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z ) );
    }
    shadow = sum / 16.0;
  }
  return mix( 1.0, shadow, shadowIntensity );
}`;
  THREE.ShaderChunk[key] = src.slice(0, i) + repl + src.slice(end);
})();

// 配合：light.shadow.radius = 3.6（原来 0.5）；
//       mapSize 8192 覆盖 175 m ≈ 2.1 cm/texel，3.6 texel ≈ 7.6 cm 半影
