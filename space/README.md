# 深空场景 · 深空行星

太阳 + 八大行星 + 月球。单文件 three.js r185，60 fps @1080p。

## 看

双击 `dist/深空太阳系.html`。

- 拖拽旋转、滚轮缩放、点击行星聚焦
- 底栏：暂停 / 减速 / 加速 / 轨道线 / 标签 / 全景
- 聚焦后右上信息面板给出直径 / 轨道 / 周期 / 温度
- 低配机：`?q=low`

## 构建

```bash
node build.js        # → dist/scene.html（与 dist/深空太阳系.html 逐字节一致）
```

## 尺度

- 1 AU = 40 世界单位
- 行星半径是**视觉尺度**（非线性），轨道周期 / 倾角 / 自转周期是真实值
- `logarithmicDepthBuffer` + 浮动原点，见 `../snippets/logdepth-chunks.js`、`../snippets/floating-origin.js`

## 调试句柄

```js
window.__solar  // { focus, home, setCam, setDays, setSpeedIdx, pause, simDays, focusKey,
                //   bodies, renderer, camera, scene, universe }
```

## 素材

行星贴图来自 [Solar System Scope](https://www.solarsystemscope.com/textures/)，**CC BY 4.0**。
成片页脚保留了署名链接，分发时请勿删除。原始 2K JPEG 在 `assets/`。
