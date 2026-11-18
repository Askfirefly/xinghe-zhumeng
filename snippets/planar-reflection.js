// planar-reflection.js — 水面平面反射：镜像相机 + 斜裁剪投影 + **屏幕 UV 采样**
// 验证：星河追梦 @60fps。比 three 官方 Reflector 更适合「水面就在眼前」的场景。
//
// 为什么不用投影纹理矩阵（texture2DProj）
//   · 矩阵必须在【斜裁剪改投影之前】构建（Reflector 的顺序），顺序反了整体偏掉
//   · 贴地平线时投影 w→0，ndc 飞出 [0,1]，整片海会退回某种「备胎颜色」——表现为一片死白/死灰
//   · 对「平面镜 + 镜像相机同投影」这种特例，屏幕 UV 就是精确解，还省一次矩阵乘法

// ---------- 1. 镜像相机 ----------
const reflCam = new THREE.PerspectiveCamera();
const _N = new THREE.Vector3(0, 1, 0);          // 水面法线
const _P = new THREE.Vector3(0, SEA_LEVEL, 0);  // 水面一点
const _view = new THREE.Vector3(), _target = new THREE.Vector3(), _lookAt = new THREE.Vector3();
const _rot = new THREE.Matrix4(), _up = new THREE.Vector3();
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q = new THREE.Vector4();

function updateReflection() {
  const cam = camera, cp = cam.position;
  _view.subVectors(_P, cp);
  if (_view.dot(_N) > 0) return false;                 // 相机在水面下
  _rot.extractRotation(cam.matrixWorld);
  _view.reflect(_N).negate().add(_P);
  _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(cp);
  _target.subVectors(_P, _lookAt).reflect(_N).negate().add(_P);

  reflCam.position.copy(_view);
  _up.set(0, 1, 0).applyMatrix4(_rot).reflect(_N);
  reflCam.up.copy(_up);
  reflCam.lookAt(_target);
  reflCam.near = cam.near; reflCam.far = cam.far;
  reflCam.updateMatrixWorld();
  reflCam.matrixWorldInverse.copy(reflCam.matrixWorld).invert();
  reflCam.projectionMatrix.copy(cam.projectionMatrix);

  // ---------- 2. 斜裁剪近平面：把近平面压到水面上，水下几何天然被裁 ----------
  _plane.setFromNormalAndCoplanarPoint(_N, _P).applyMatrix4(reflCam.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const pm = reflCam.projectionMatrix;
  _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
  _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
  _q.z = -1.0;
  _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
  _clip.multiplyScalar(2.0 / (_clip.x * _q.x + _clip.y * _q.y + _clip.z * _q.z + _clip.w * _q.w));
  pm.elements[2] = _clip.x;
  pm.elements[6] = _clip.y;
  pm.elements[10] = _clip.z + 1.0;
  pm.elements[14] = _clip.w;
  return true;
}

// ---------- 3. 渲染 ----------
// 反射 pass 里藏掉：水面自己 + 所有透明物体（雨/雾/粒子）+ 点精灵
if (updateReflection()) {
  sea.visible = false;
  for (const o of hiddenInRefl) o.visible = false;
  renderer.setRenderTarget(reflRT);       // 半分辨率足够
  renderer.clear();
  renderer.render(scene, reflCam);
  sea.visible = true;
  for (const o of hiddenInRefl) o.visible = true;
  seaU.tReflect.value = reflRT.texture;
  seaU.uReflTexel.value.set(1 / reflRT.width, 1 / reflRT.height);
  seaU.uReflValid.value = 1.0;
}

// ---------- 4. 水面 shader 里采样（屏幕 UV） ----------
const seaFrag = /* glsl */`
  uniform sampler2D tReflect;
  uniform vec2 uRes, uReflTexel;
  uniform float uReflValid;
  void main() {
    // ...先算出波浪法线 N、视线 V、反射方向 R、距离 dist...
    vec2 suv = gl_FragCoord.xy / uRes;
    suv += N.xz * (0.020 / (1.0 + dist * 0.012) + 0.0035);   // 法线扰动：近大远小
    vec2 tx = uReflTexel;
    float bl = clamp(dist * 0.0018, 0.0, 2.2);               // 远处更糊
    vec3 refl = (texture2D(tReflect, suv).rgb
      + texture2D(tReflect, suv + vec2(tx.x * bl, 0.0)).rgb
      + texture2D(tReflect, suv - vec2(tx.x * bl, 0.0)).rgb
      + texture2D(tReflect, suv + vec2(0.0, tx.y * bl)).rgb
      + texture2D(tReflect, suv - vec2(0.0, tx.y * bl)).rgb) * 0.2;
    // 贴地平线时平面反射不可靠（会采到天空的暗带），退回解析天空
    float rh = clamp(R.y, 0.0, 1.0);
    refl = mix(skyAt(R), refl, smoothstep(0.015, 0.20, rh));
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    gl_FragColor = vec4(mix(deepColor, refl, F), 1.0);
  }`;

// 坑 1：反射 pass 里别忘了 renderer.shadowMap.autoUpdate = false + 主 pass 前 needsUpdate = true，
//       否则一帧要重算两次阴影贴图（8192² 时非常贵）。
// 坑 2：波浪法线幅度别失控。dn 超过 ~0.5 法线就躺平，菲涅尔算出来只剩 0.2，海面既不反光也不像水。
