// foliage-translucency.js — 卡片植被的背光透射（逆光下叶子发亮，而不是褐色剪影）
// 验证：星河追梦 60fps。MeshStandardMaterial 本身没有透射模型，逆光时叶背拿不到任何光。
//
// 做法：在 #include <lights_fragment_end> 之后往 reflectedLight.directDiffuse 里加一项
//       「视线与太阳反向对齐程度」的假透射。视图空间里算，不需要额外传太阳方向。

const transU = { value: 0.85 };
const transTintU = { value: new THREE.Color(1.15, 1.02, 0.52) };  // 阳光穿过叶子偏黄绿

const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.22, side: THREE.DoubleSide, roughness: 0.9 });
mat.alphaToCoverage = true;
mat.onBeforeCompile = (sh) => {
  sh.uniforms.uTransAmt = transU;
  sh.uniforms.uTransTint = transTintU;
  sh.fragmentShader = `
    uniform float uTransAmt;
    uniform vec3 uTransTint;
  ` + sh.fragmentShader.replace(
    '#include <lights_fragment_end>',
    `#include <lights_fragment_end>
    #if NUM_DIR_LIGHTS > 0
    {
      vec3 Vv = normalize(vViewPosition);            // 表面 → 相机（视图空间）
      vec3 Lv = directionalLights[0].direction;      // 表面 → 太阳（视图空间）
      float back = pow(clamp(dot(Vv, -Lv), 0.0, 1.0), 2.6);
      reflectedLight.directDiffuse += diffuseColor.rgb * uTransTint * back * uTransAmt;
    }
    #endif`
  );
};

// 坑：写 uniform 那一行别用带转义换行的字符串拼（'\n' 在某些注入路径里会变成真换行 → 语法错误），
//     用模板字符串换行最稳。
// 可调：uTransAmt 0.6–1.0；指数 2.6 越大越只在正逆光时亮。
