// pbr-inline.js — 把 Poly Haven 的 PBR 贴图内联进单文件 HTML（已验证）
// 流程：下载 1K JPG → 压到 1024/q86 → base64 → 注入 <script type="text/plain"> → Image 解码

/* ---------- 1. 下载（Poly Haven，CC0） ---------- */
// https://api.polyhaven.com/assets?t=textures          → 列表
// https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/<name>/<name>_diff_1k.jpg
//                                                        <name>_nor_gl_1k.jpg
//                                                        <name>_rough_1k.jpg
// 实测速度约 60 KB/s，1K 单张 0.4–1.3 MB，2K 单张 2–3 MB（很慢，建议后台跑）

/* ---------- 2. 压缩 + base64（Python） ---------- */
// from PIL import Image
// im = Image.open(src).convert('RGB')
// im = im.resize((1024,1024), Image.LANCZOS)
// buf = io.BytesIO(); im.save(buf, format='JPEG', quality=86, optimize=True)
// open(f'src/{name}.b64','w').write(base64.b64encode(buf.getvalue()).decode())

/* ---------- 3. 注入（build.js） ---------- */
// shell.html 里放占位：
//   <script id="tex_rock_diff" type="text/plain">__TEX_ROCK_DIFF__</script>
// build.js：
//   for (const n of names) {
//     const b64 = fs.readFileSync(`src/${n}.b64`, 'utf8').trim();
//     shell = shell.split('__' + n.toUpperCase() + '__').join(b64);
//   }

/* ---------- 4. 运行时解码 ---------- */
function b64Tex(id, repeatX, srgb, repeatY) {
  const el = document.getElementById(id);
  const t = new THREE.Texture();
  if (el && el.textContent.trim().length > 100) {
    const img = new Image();
    img.onload = () => { t.image = img; t.needsUpdate = true; };
    img.src = 'data:image/jpeg;base64,' + el.textContent.trim();
  }
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY === undefined ? repeatX : repeatY);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;   // 只有 diffuse 设 sRGB
  return t;
}

// 用法：
// new THREE.MeshStandardMaterial({
//   map: b64Tex('tex_road_diff', 2, true, 120),
//   normalMap: b64Tex('tex_road_nor', 2, false, 120),
//   roughnessMap: b64Tex('tex_road_rough', 2, false, 120),
//   roughness: 1.0, metalness: 0.0
// });

// 尺寸参考：
//   1024² JPG q86 → diff ~350KB / nor ~400KB / rough ~250KB
//   base64 后约 ×1.33，12 张 → HTML 增加约 5 MB
//
// 坑：
// 1. 把 diffuse 直接当白漆/箭体 map 会把材质压成灰色（贴图本身是灰的），
//    白色物体应该只用 normalMap + roughnessMap，颜色留给 material.color
// 2. 沿路的重复要按实际尺寸算（7.6 m 宽 × 460 m 长 → repeat (2, 120)），
//    否则纹理被拉成长条
