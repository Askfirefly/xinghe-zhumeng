# 地面场景 · 星河追梦

雨天滨海公路 + 长征五号发射工位。单文件 three.js r185，60 fps @1280×720。

## 看

双击 `dist/scene.html`。

- 拖拽转视角、滚轮缩放
- 走到发射工位，点火箭部件 → 缓缓升起 + 外壳半透明 + 露出内部结构
- 右下角：`一键合体`、`塔架张开`（塔臂外摆 90°）
- URL 参数：`day`（0.487 = 17:41 黄金时刻）、`cam=x,y,z`、`yaw`、`pitch`、`fov`、`q=low|mid|high`、`hud=0`

## 构建

```bash
node build.js        # → dist/scene.html
```

不需要 npm 依赖，three.js 在 `vendor/`。产物与发布文件逐字节一致。

## 调试

```bash
node tools/errcheck.js "day=0.487&q=high"                    # 查 console 错误（改完 shader 必跑）
node tools/eval_shot.js preview/a.png "" "day=0.487&cam=34,20,-88&yaw=0.56&pitch=0.24&q=high"
node tools/shots.js preview/final final                         # 9 个预设机位
node tools/click_test.js 450 400 "day=0.487&..."                 # 真实派发点击
```

`tools/_chrome.js` 自动找 Chrome（Windows / macOS / Linux），也可以用 `CHROME_BIN` 指定。

## 代码结构

`src/app.js` 单文件约 4600 行，按注释分块：

```
渲染器 / 相机 / 后处理
├── 天空（Rayleigh+Mie 梯度 + 云海 + 太阳洞）
├── 海面（Gerstner + 平面反射 + 屏幕 UV 采样）
├── 地面 / 公路 / 护栏（PBR + 大尺度脏化）
├── 植被（卡片树 + 风摆 + 背光透射）
├── 雨（GPU 雨丝 + 屏幕水滴）
├── 发射工位（服务塔 / 可旋转塔臂 / 四座避雷塔）
├── 长征五号（7 个可拆解部件 + 内部结构）
└── 后处理（TAA / SSAO / 体积光 / 曝光 / AgX / 锐化）
```

## 已知不足

- **没有发射流程**（只有塔架张开 + 部件拆解）
- 远景有轻微 popping
- 雨滴不会真实打湿镜头
- 移动端未适配
