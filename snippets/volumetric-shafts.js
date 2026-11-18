// volumetric-shafts.js — 屏幕空间体积光（32 步深度步进，已验证 60fps）
// 原理：从每个像素的世界坐标沿太阳方向步进，投影回屏幕比深度判断遮挡

const shaftsRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const shaftsMat = new THREE.ShaderMaterial({
  uniforms: {
    tDepth: { value: rtScene.depthTexture },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uSunDir: { value: SUN_DIR },
    uSunColor: { value: new THREE.Color(1, 0.85, 0.62) },
    uDensity: { value: 0.55 },
    uMaxDist: { value: 30.0 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDepth;
    uniform mat4 uInvProj, uCamWorld, uViewProj;
    uniform vec3 uSunDir, uSunColor;
    uniform float uDensity, uMaxDist;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uInvProj * ndc; view /= view.w;
      vec3 wpos = (uCamWorld * view).xyz;

      float jitter = hash(vUv * 1024.0);
      float stepLen = uMaxDist / 32.0;
      vec3 p = wpos + uSunDir * stepLen * jitter;
      float lit = 0.0, dark = 0.0;
      for (int i = 0; i < 32; i++) {
        p += uSunDir * stepLen;
        vec4 cp = uViewProj * vec4(p, 1.0);
        vec3 cndc = cp.xyz / max(cp.w, 1e-4);
        vec2 suv = cndc.xy * 0.5 + 0.5;
        float seen = 1.0;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
          float sd = texture2D(tDepth, suv).x;
          seen = cndc.z > sd * 2.0 - 1.0 + 0.0012 ? 0.0 : 1.0;
        }
        lit += seen; dark += 1.0 - seen;
      }
      // 关键：只有「部分被挡」的光线才形成可见光束，纯开阔处不出光柱
      float acc = min(lit, dark) / 32.0 * 2.0;

      vec3 V = normalize(wpos - uCamWorld[3].xyz);
      float phase = pow(max(dot(-V, uSunDir), 0.0), 3.0) * 0.85 + 0.15;
      float hFall = exp(-max(wpos.y, 0.0) * 0.02);
      gl_FragColor = vec4(uSunColor * acc * phase * hFall * uDensity, 1.0);
    }`
});

// 每帧在场景渲染之后：
//   shaftsMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
//   shaftsMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
//   shaftsMat.uniforms.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
//   pass(shaftsMat, shaftsRT);   // 半分辨率
//   comp.uniforms.tShafts.value = shaftsRT.texture;

// 坑：
// 1. rtScene 必须挂 DepthTexture，否则永远采不到深度
// 2. 不加 min(lit,dark) 调制，开阔天空会整屏泛黄
// 3. three r185 的阴影贴图是「带比较模式的深度纹理」（需 sampler2DShadow），
//    不能当普通 sampler2D 采样 —— 所以走屏幕空间而不是阴影贴图步进
