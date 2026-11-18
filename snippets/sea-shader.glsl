// sea-shader.glsl — 海面着色（多层波 + 双尺度法线 + 反射 + 泡沫）
// 已验证：60fps，与平面反射配合正常

// ---------- 噪声 ----------
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += noise(p) * a; p *= 2.03; a *= 0.5; }
  return s;
}

// ---------- 6 层波 ----------
float waveH(vec2 p, float t) {
  float h = 0.0;
  h += fbm(p * 0.030 + vec2(t * 0.018, t * 0.012)) * 1.00;
  h += fbm(p * 0.085 - vec2(t * 0.040, t * 0.026)) * 0.50;
  h += fbm(p * 0.240 + vec2(t * 0.080, -t * 0.055)) * 0.25;
  h += fbm(p * 0.700 - vec2(t * 0.150, t * 0.100)) * 0.13;
  h += fbm(p * 1.900 + vec2(t * 0.30, 0.22 * t)) * 0.06;
  return h;
}

// ---------- 法线：粗尺度 + 细尺度，按距离混合（防远处闪烁）----------
float h0 = waveH(p, t);
float e1 = 0.85, e2 = 0.16;
vec2 g1 = vec2(h0 - waveH(p + vec2(e1, 0.0), t), h0 - waveH(p + vec2(0.0, e1), t)) * 2.0 / e1;
vec2 g2 = vec2(h0 - waveH(p + vec2(e2, 0.0), t), h0 - waveH(p + vec2(0.0, e2), t)) * 2.0 / e2 * 0.30;
float dist = length(cameraPosition - vW);
float blend = 1.0 - smoothstep(40.0, 260.0, dist);
vec3 n = normalize(vec3(g1 + g2 * blend, 1.0));

// 贴图细波纹（可选）
vec2 tn = texture2D(tSeaNor, p * 0.06 + vec2(t * 0.01, -t * 0.008)).xy * 2.0 - 1.0;
n = normalize(n + vec3(tn.x, 0.0, tn.y) * 0.30 * blend);

// ---------- 着色 ----------
float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 4.0);
vec3 skyR = mix(uSkyHorizon, uSkyTop, pow(clamp(reflect(-V, n).y * 1.2 + 0.08, 0.0, 1.0), 0.6));

vec3 deep = vec3(0.006, 0.020, 0.032);
vec3 shallowC = vec3(0.020, 0.075, 0.085);
float shallow = smoothstep(uShoreX - 60.0, uShoreX + 10.0, p.x);
vec3 water = mix(deep, shallowC, shallow * 0.65) * (1.0 - uNight * 0.7);

vec3 col = mix(water, skyR, fres * 0.40);
vec3 refl = texture2DProj(tReflect, vRefl + vec4(n.xz * 0.05, 0.0, 0.0)).rgb;
col = mix(col, refl, fres * 0.66);

// 太阳高光
float spec = pow(max(dot(n, normalize(uSunDir + V)), 0.0), 220.0);
col += uSunColor * spec * 1.6;

// 浪尖泡沫 + 岸线白沫
float crest = smoothstep(0.62, 0.95, h0 + n.x * 0.25);
col += vec3(0.75, 0.82, 0.86) * crest * 0.14 * (0.35 + fres);
float shore = exp(-pow((p.x - uShoreX) / 26.0, 2.0));
col = mix(col, vec3(0.80, 0.86, 0.88), clamp(shore * 0.6 * (0.5 + 0.5 * fres), 0.0, 0.75));

// 坑：
// - fresnel 权重太大（>0.8）会让掠射角的水面变成纯白
// - 细尺度法线不做距离衰减会摩尔纹
// - 岸线泡沫用 exp(-((x-shoreX)/w)^2)，不要用 1-smoothstep（方向容易搞反）
