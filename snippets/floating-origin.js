// 来源：深空·太阳系 src/app.js:1113-1135（浮动原点 / floating origin）
// 大尺度场景（0.02 .. 5000 世界单位同框）标配：logarithmicDepthBuffer + 浮动原点。
// 世界坐标用 JS double 存（bodyGroups[key].worldPos / cam.target），
// 渲染空间 = 世界 - 原点；相机恒在 (0,0,0)，整个 universe 反向平移。
// 前提：renderer = new WebGLRenderer({ logarithmicDepthBuffer: true, ... })，
//       且所有自定义 ShaderMaterial 插 logdepth chunk（见 logdepth-chunks.js）。

// --- 每帧：相机阻尼（球坐标环绕 + 目标点 lerp）---
if (cam.focus) cam.gTarget.copy(bodyGroups[cam.focus].worldPos);
const k = 1 - Math.exp(-dt * 4.2);
cam.theta += (cam.gTheta - cam.theta) * k;
cam.phi   += (cam.gPhi   - cam.phi)   * k;
cam.r     += (cam.gR     - cam.r)     * k;
cam.target.lerp(cam.gTarget, k);
cam.r = Math.max(cam.r, minR() * 0.9);          // minR(): 按聚焦天体半径防穿模

// --- 浮动原点核心 ---
camWorld.set(
  cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
  cam.target.y + cam.r * Math.cos(cam.phi),
  cam.target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta));
origin.copy(camWorld);                          // 原点 = 相机世界位置
universe.position.copy(origin).negate();        // 世界整体反移 → 相机相对坐标
camera.position.set(0, 0, 0);
tmpV.copy(cam.target).sub(origin);
camera.lookAt(tmpV);

// --- near 随焦距动态收紧（变化 >2% 才重建投影矩阵，避免每帧开销）---
const near = Math.max(0.02, cam.r * 0.0015);
if (Math.abs(near - camera.near) / camera.near > 0.02) {
  camera.near = near;
  camera.updateProjectionMatrix();
}

// 注意：shader 里若需要"世界位置"（如光照方向），用 modelMatrix 算出的 vW 已是
// 渲染空间；太阳位置 uniform 也要传渲染空间（worldPos - origin），否则光照方向错。