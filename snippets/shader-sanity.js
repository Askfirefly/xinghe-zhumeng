// shader-sanity.js — 编译期自检：把 GLSL 编译错误直接抛到脸上
// 背景：一次 `float patch = ...`（patch 是 GLSL 保留字）让整块地面消失，
//       画面上只表现为"右边变成了水"，肉眼以为是材质问题，排查了三轮。
//
// 用法：在任何 renderer 建好之后调用一次。
(function installShaderErrorHook(renderer) {
  const orig = renderer.compile.bind(renderer);
  renderer.compile = function (scene, camera) {
    try {
      return orig(scene, camera);
    } catch (e) {
      console.error('[shader] compile failed:', e);
      throw e;
    }
  };
  // three 的着色器错误默认只打 console.error，不会中断；
  // 想让它在开发期直接炸出来，把下面这段挂到 window.onerror 之外再用：
  const ce = console.error;
  console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].indexOf('THREE.WebGLProgram: Shader Error') >= 0) {
      window.__shaderErrors = (window.__shaderErrors || 0) + 1;
      // 开发期：throw new Error(args.join(' '));
    }
    return ce.apply(console, args);
  };
})(renderer);

// GLSL 保留字（踩过的）：patch input output filter active common partition
//                         resource sample smooth superp template this
