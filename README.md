# 星河追梦 · 深空行星

两个实时 3D 场景，一套视觉规格。

| 场景 | 内容 | 大小 | 帧率 |
|---|---|---|---|
| **地面**（`ground/`） | 雨天滨海公路 + 长征五号发射工位，可点击拆解看内部结构 | 9.7 MB 单文件 | 60 fps @1280×720 |
| **深空**（`space/`） | 太阳 + 八大行星 + 月球，大气/环/昼夜/程序化气态条带 | 5.6 MB 单文件 | 60 fps @1080p |

两个都是 **three.js r185 + 全内联单文件 HTML**：双击就能开，不需要服务器、不需要网络。

## 在线预览

| 场景 | 地址 |
|---|---|
| 入口页 | **https://askfirefly.github.io/xinghe-zhumeng/** |
| 地面 · 星河追梦 | https://askfirefly.github.io/xinghe-zhumeng/ground/dist/scene.html |
| 深空 · 太阳系 | https://askfirefly.github.io/xinghe-zhumeng/space/dist/深空太阳系.html |

> 首次打开要等下载：地面 9.7 MB / gzip 后约 5.9 MB，深空 5.8 MB / gzip 后约 3.1 MB。
> GitHub Pages 会自动 gzip，一般 3–10 秒能进。慢网下会看到加载页停留较久，这是文件体积决定的，不是卡死。

---

## 直接看

```
ground/dist/scene.html        ← 双击：地面场景
space/dist/深空太阳系.html     ← 双击：深空场景
```

推荐 Chrome / Edge；Safari 16+ 也可以。

**地面场景怎么玩**

- 拖拽转视角、滚轮缩放
- 走到发射工位，**点火箭的某个部件** → 那个部件缓缓升起、外壳变半透明、露出内部结构
- 右下角：`一键合体`（收回所有部件）、`塔架张开`（两侧塔臂外摆 90°）
- URL 参数可以直接切机位：
  `?day=0.487&cam=34,20,-88&yaw=0.56&pitch=0.24&q=high&hud=0`

**深空场景怎么玩**

- 拖拽旋转、滚轮缩放、点击行星聚焦
- 底栏：暂停 / 减速 / 加速 / 轨道线 / 标签 / 全景
- 低配机加 `?q=low`

---

## 目录

```
ground/                 地面场景（星河追梦）
  dist/scene.html       发布文件（单文件，直接打开）
  src/                  app.js（~4600 行）+ shell.html + 18 张贴图 b64
  vendor/three.cjs      three r185（构建用，随包自带）
  build.js              node build.js → dist/scene.html
  tools/                errcheck（查 shader 错误）/ eval_shot（出图）/ shots（9 机位）
  screenshots/

space/                  深空场景（深空行星）
  dist/深空太阳系.html    发布文件
  src/                  app.js（~1240 行）+ shell.html + 8 张行星贴图 b64
  assets/               原始 2K 行星贴图（Solar System Scope, CC BY 4.0）
  vendor/ build.js tools/ screenshots/

snippets/               两个场景里可独立拿走的 14 个 shader / 模块
docs/                   实现记录、合并约定、待办清单
```

## 构建

```bash
cd ground && node build.js      # → ground/dist/scene.html
cd space  && node build.js      # → space/dist/scene.html（与发布文件一致）
```

两个都不需要 `npm install`：three.js 已经放在各自的 `vendor/` 里。
构建产物与仓库里的发布文件**逐字节一致**，可以自己验证。

---

## 技术要点

**地面**
- 天空、海面、雨、体积光全部是手写 GLSL，没有用 three 的天空/雾 addon，也没有一张云贴图
- 平面反射用镜像相机 + 斜近裁剪面；TAA + 半分辨率 SSAO + AgX
- 火箭是 7 个可独立驱动的部件，每个都有内部结构（贮箱/发动机/管路/气瓶/伺服）

**深空**
- `logarithmicDepthBuffer` + **浮动原点**（相机恒在原点，宇宙整体反向平移）解决 1e8 量级尺度
- 行星大气是球形壳层单次散射；气态巨行星的条带是程序化 FBM，不是贴图
- 与地面场景共用一套 look spec（AgX / 曝光 1.3 / grain 0.02 / vignette 0.24 / 5600K）

细节见 `docs/`。

---

## 已知限制

- 地面场景**还没有发射流程**（只有塔架张开 + 部件拆解），这是下一步
- 深空场景的行星半径是**视觉尺度**（非线性），轨道周期是真实值
- 两边都还没在移动端适配
- Safari 未做完整验证

---

## 素材署名

- 行星贴图：**Solar System Scope**（https://www.solarsystemscope.com/textures/），CC BY 4.0
- 地面 PBR 贴图：**Poly Haven** / **ambientCG**，CC0
- three.js：MIT
- 音乐：项目自制
- 其余几何、shader、代码：程序化生成 / 原创

> CC BY 4.0 要求署名，`space/dist/深空太阳系.html` 页脚已保留署名链接，二次分发时请不要删除。

---

## 状态

| 模块 | 状态 |
|---|---|
| 地面场景 | 可玩，缺发射流程与科普层 |
| 深空场景 | 可玩，缺与地面的转场 |
| 合并 | 已统一 look spec 与构建约定，尚未做同一条时间线 |

待办清单见 [`docs/待办清单.md`](docs/待办清单.md)。
