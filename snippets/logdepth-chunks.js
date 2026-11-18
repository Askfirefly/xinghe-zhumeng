// 来源：深空·太阳系 src/app.js:128-131（three r185，renderer 开 logarithmicDepthBuffer: true）
// 自定义 ShaderMaterial 不会自动带 log 深度 chunk，必须手插这四段：
//   vertex: 头部 ${LOG_V}，main() 末尾 ${LOG_V_MAIN}
//   fragment: 头部 ${LOG_F}，main() 开头 ${LOG_F_MAIN}
// 关键坑：vertex 必须先 #include <common> —— logdepthbuf_vertex 依赖其中的
// isPerspectiveMatrix()，漏了会报 'isPerspectiveMatrix' : no matching overloaded function found。
const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';
const LOG_V_MAIN = '#include <logdepthbuf_vertex>';
const LOG_F = '#include <logdepthbuf_pars_fragment>';
const LOG_F_MAIN = '#include <logdepthbuf_fragment>';

// 示例：
// vertexShader: `
//   varying vec3 vN;
//   ${LOG_V}
//   void main(){
//     vN = normalize(normalMatrix * normal);
//     gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
//     ${LOG_V_MAIN}
//   }`
// fragmentShader: `
//   varying vec3 vN;
//   ${LOG_F}
//   void main(){
//     ${LOG_F_MAIN}
//     gl_FragColor = vec4(vN*0.5+0.5, 1.0);
//   }`