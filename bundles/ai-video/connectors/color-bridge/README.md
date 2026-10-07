# 成片调色 bridge 连接器（ai-video）

把 `colorread.* / colorwrite.*` 工具接到 Mac 调色工位（ffmpeg 内核），供「调色师」数字员工在
后期环节执行已声明的调色/LUT/校正配方。成功镜头默认直接后期，`grade/best` 不自动诊断或用品质分数挑选候选。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）        Mac 调色工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  color-bridge (127.0.0.1:9774)
                                            └─ ffmpeg / ffprobe（kit 受控安装）
                                                ├─ 素材区（原片只读）
                                                ├─ 产物区（新文件 + 版本链）
                                                └─ 回执：真实滤镜 / 源与产物 SHA / 普通规格与标签 / 品质未评审
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，只回元数据、小图（scope/对比帧）与哈希。

## 接线

```ts
import { createColorBridgeExecutor } from "./bundles/ai-video/connectors/color-bridge/executor.ts";

const toolExecutor = createColorBridgeExecutor({
  baseUrl: process.env.WORKLOOM_COLOR_BRIDGE_URL!,      // 支持逗号分隔多端点
  token: process.env.WORKLOOM_COLOR_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 900_000,
});
// 注入宿主：packages/runtime/src/loop.ts 的 input.toolExecutor（部署适配器负责）
// 行业侧适配器：server-adapter.mts（读 WORKLOOM_COLOR_BRIDGE_* 环境变量）
```

基座 seam 提案仍处「暂缓」（`proposals/workloom-im/0001-deployment-tool-executor-seam.md`），
因此当前生产入口是**行业侧脚本注入**（见 `runtime-smoke.mts` 与部署层 `server-adapter.mts`），
不改任何基座文件。

## 工具面

| 工具 | 类型 | 用途 |
|---|---|---|
| `colorread.health` | 读 | 工位与 ffmpeg 健康探针（含可用 profile / 白名单根目录） |
| `colorread.probe` | 读 | 素材规格：分辨率/帧率/时长/编码/色彩空间/是否 log |
| `colorread.analyze` | 读 | 抽帧量化诊断：曝光/裁切/偏色/饱和/肤色 + 修复建议（显式诊断，不是 grade/best 前置条件） |
| `colorread.scope` | 读 | 波形/矢量/直方图 + 前后对比帧 |
| `colorread.recipes` | 读 | 声明题材/平台配方检索 |
| `colorwrite.best` | 写 | 兼容入口执行一个声明配方，候选为空、评分为 null |
| `colorwrite.grade` | 写 | 单次应用声明的 look/LUT/校正滤镜产出成片；旧 `auto` 不触发品质分析 |
| `colorwrite.match` | 写 | 显式匹配：输入统计计算请求变换，不做 after/residual 品质票决 |

## 安装与自检（工位一次性）

```bash
bash kit/install.sh            # 受控下载 ffmpeg/ffprobe（pin 版本 + sha256 校验）
bash kit/selftest.sh           # 引擎在位 → 滤镜齐备 → 真实跑一遍 → 回执核验
```

## 运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg）

```bash
set -a; source .env; set +a
node_modules/.bin/tsx bundles/ai-video/connectors/color-bridge/runtime-smoke.mts
```

四个场景（脚本自动起停 bridge）：

| 场景 | 期望 |
|---|---|
| clean：干净调色 | `completed`，产出成片，回执 sha256 与磁盘文件一致（G-COL0 auto 直通） |
| blocked：覆盖原片 | `paused`，`blockedBy=覆盖原片禁止`（G-COL2 block） |
| 品牌 look 变更 | 普通后期执行声明配方；无默认品质人审（G-COL1） |
| outage：工位不可达 | `failed` + 全部步骤标未核实（软失败不伪造回执） |

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- bridge 默认只监听 `127.0.0.1`，跨机置于内网反代 + mTLS 之后；
- **路径监狱**：`WORKLOOM_COLOR_ALLOWED_ROOTS`（冒号分隔）之外一律拒绝，软链逃逸同样拦；
- **原片只读**：输出路径等于输入路径直接拒绝（`overwrite_source_forbidden`），并由围栏 G-COL2 一票否决；
- 客户素材与成品只落工位/租户素材区，不上行蜂群；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 错误码

可重试：`network_error` / `timeout` / `ffmpeg_failed` / `decode_failed` / `engine_failed` / `bad_response`

不可重试：`path_not_allowed` / `tenant_mismatch` / `overwrite_source_forbidden` / `disk_quota_exceeded` /
`ffmpeg_not_installed` / `bad_media` / `bad_lut` / `bad_profile` / `bad_patch` / `not_found` / `not_provided` / `not_configured`

## LUT 与许可

- 所有 LUT 由 `bundles/ai-video/library/luts/generate-luts.mjs` **自算生成**（S-Log3 公开曲线 + BT.709 OETF + 本仓自有 look 参数），
  仓库不携带任何第三方 LUT（避开相机厂商再分发条款）；`--check` 模式保证磁盘产物与生成器一致。
- 工位 ffmpeg 为静态构建，configure 含 `--enable-gpl --enable-nonfree`：**仅限工位本地使用，不可随产品分发**，
  pin 与许可说明见 `kit/ffmpeg-pin.json`；如需随产品分发请替换为 LGPL 构建。

## 与调色纪律的对应

| 纪律 | 落点 |
|---|---|
| 先校正后创作、LUT 最后 | `core.mjs` 的 `buildChain` 顺序 + 技能 `color-grade` |
| 强度默认不满档（0.6–0.8） | `grade.intensity` 默认 0.8；技能给出选型表 |
| 原片只读 | `assertOutputWritable` + 围栏 G-COL2 |
| 无回执不算完成 | 源/输出摘要、实际媒体与处理回执；`qualityReviewPerformed=false`，不伪造品质指标 |
| 声明配方一次执行 | 实际参数/文件/源字节回执；各请求变体记录复用或重算 |



## 成功素材默认采用

`grade` 单次执行请求配方，保留原片音轨，记录源/输出摘要及实际色彩标签。`best` 兼容指令执行一个声明配方，`candidates=[]/finalScore=null`，不作候选评分、缺陷/肤色/可见性复审或自动返工。旧 `onUnfixable` 不建立品质否决；微小强度和失焦源仍正常出片。显式 `analyze/scope` 是独立诊断；`match` 输入统计仅计算用户要求的变换，无成品残差/直方图票决；这些工具不能作为成功镜头的默认验收门。缺源、非法 LUT、覆盖原片、输入字节变化、真实 FFmpeg 错误和导出标签失败继续报错。
