# Alpine Flow Lab

一个从旧版单文件实验重新设计的低多边形山脉与水流沙盒。项目保留“雕刻地形 → 观察水流响应”的核心体验，但将渲染、地形生成、地形编辑、水体与界面拆成独立系统，便于继续增加天气、生物群系、侵蚀或导出功能。

## 技术选择

- **Vinext / React / TypeScript**：负责界面与应用生命周期。
- **Three.js**：低多边形渲染、光照、雾效、相机和实例化植被。它足够轻、生态成熟，不需要引入体积更大的游戏引擎。
- **simplex-noise**：提供可复现的连续噪声；同一 seed 总会得到同一座山。
- **自定义高度场水体**：水量在相邻单元之间按水面高度差守恒交换，地形变化后会重新计算水深。

## 项目结构

```text
app/
  page.tsx                 页面入口
  globals.css              全局视觉系统与响应式布局
components/
  AlpineFlowLab.tsx        React 界面、状态和快捷键
engine/
  config.ts                集中的世界、笔刷与水流参数
  types.ts                 系统间的稳定数据契约
  math/random.ts           Seed 随机数与二维哈希
  terrain/
    MountainGenerator.ts   山脊 + 分形噪声 + 热力侵蚀
    TerrainSystem.ts       高度图、低多边形网格、笔刷与生物群系着色
  water/
    WaterSimulation.ts     守恒水流、冰川水源与水面着色器
  scenery/
    ScenerySystem.ts       实例化低多边形针叶林和碎岩
  world/
    AlpineWorld.ts         场景装配、相机、交互、渲染循环
```

`AlpineWorld` 只负责装配与协调；每个功能系统持有自己的数据和 Three.js 资源。新功能应优先作为独立系统加入，而不是继续扩大 `AlpineWorld`。

## 山脉生成逻辑

1. 一条经过 domain warp 的主山脊决定整体方向。
2. 宽、窄两层山脊函数分别形成山体肩部与锋利山脊。
3. 三个沿主脊分布的高斯峰形成可读的主峰节奏。
4. 五层 ridged fractal noise 刻出岩面褶皱与细节。
5. drainage noise 切开谷地，边界衰减让地形自然落入盆地。
6. 少量热力侵蚀搬运超过 talus angle 的高度，使山脚更可信。
7. 面片根据相对海拔、坡度与稳定随机值分配草地、林线、裸岩和积雪颜色。

## 运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

## 操作

- `O`：观察 / 旋转镜头
- `D`：下切地形
- `B`：抬升地形
- `S`：平滑地形
- `Space`：开启或暂停冰川融水
- 左键拖动：使用当前工具
- 右键拖动：始终旋转镜头
- 滚轮：缩放

## 建议的后续扩展

- 在 `terrain/generators/` 中增加岛屿、峡谷等生成器，并让 `TerrainSystem` 注入生成策略。
- 将高分辨率水体计算迁移到 Web Worker，保持现有 `WaterSimulation` 接口不变。
- 新建 `WeatherSystem`，只通过世界时间与材质 uniforms 影响现有系统。
- 新建序列化层，将 seed、笔刷操作与水体参数保存为场景预设，而不是直接保存大型网格。
