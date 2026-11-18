// 来源：深空·太阳系 src/app.js:100-127（GLSL_NOISE）
// 值噪声 + 4 octave FBM，3D/2D 两套。hash 用 fract-dot 系，无纹理依赖、移动端安全。
// 注意：GLSL 保留字别用作变量名（patch/input/output/filter/sample/smooth…）。
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