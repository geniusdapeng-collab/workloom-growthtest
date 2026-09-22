# 标题字幕 bridge 连接器（ai-video）

把 `subtitleread.* / subtitlewrite.*` 工具接到本地字幕工位（ffmpeg + libass + 工位字体目录），
供「字幕师」数字员工在后期环节做**选型 → 版式 → 烧录 → 复检**。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）          Mac 字幕工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  subtitle-bridge (127.0.0.1:9776)
                                            ├─ ffmpeg / ffprobe（kit 受控安装）
                                            ├─ libass（ass/subtitles 滤镜）
                                            ├─ 工位字体目录（kit/install-fonts.sh 按 sha256 安装）
                                            ├─ 素材区（原片只读）
                                            ├─ 产物区（新文件 + 版本链 + 证据帧）
                                            └─ 回执：sha256 / 版式体检 / 可现度 / 时间轴回读 / 字体解析
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，只回元数据、小图（证据帧）与哈希。

## 接线

```ts
import { createSubtitleBridgeExecutor } from "./bundles/ai-video/connectors/subtitle-bridge/executor.ts";

const toolExecutor = createSubtitleBridgeExecutor({
  baseUrl: process.env.WORKLOOM_SUBTITLE_BRIDGE_URL!,      // 支持逗号分隔多端点
  token: process.env.WORKLOOM_SUBTITLE_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 900_000,
});
// 注入宿主：packages/runtime/src/loop.ts 的 input.toolExecutor（部署适配器负责）
// 行业侧适配器：server-adapter.mts（读 WORKLOOM_SUBTITLE_BRIDGE_* 环境变量）
```

与调色/配乐工位同款：基座 seam 提案仍处「暂缓」（`proposals/workloom-im/0001-deployment-tool-executor-seam.md`），
因此当前生产入口是**行业侧脚本注入**（见 `runtime-smoke.mts` 与部署层 `server-adapter.mts`），不改任何基座文件。

## 工具面（9 个）

| 工具 | 类型 | 用途 |
|---|---|---|
| `subtitleread.health` | 读 | 工位与引擎健康（ffmpeg/ffprobe、libass、字体在位、编码器、配方库） |
| `subtitleread.probe` | 读 | 素材规格：分辨率/时长/帧率/音轨/编码（决定字号基准） |
| `subtitleread.analyze` | 读 | 画面可读性诊断：抽帧量化文字带**亮度**与**细节密度**、遮挡区命中、证据帧 |
| `subtitleread.fonts` | 读 | 字体档案检索与打分（场景×语言硬过滤 + 五维加权 + 账号锁定字体） |
| `subtitleread.recipes` | 读 | 平台版式与题材配方检索（安全区/字号倍率/描边/底衬/禁忌） |
| `subtitlewrite.plan` | 写 | **出方案包**：ASS 样式与事件 + 选型理由 + 版式体检（不改成片） |
| `subtitlewrite.burn` | 写 | 字幕烧录出片（SRT→ASS→libass，带六项复检） |
| `subtitlewrite.title` | 写 | 片头标题/花字渲染出片（平台版式 + 描边/底衬 + 安全区校验） |
| `subtitlewrite.best` | 写 | 择优出片：字体×描边候选池打分；**允许结论是"无需加字幕"**（不产出文件） |

## 字号与版式怎么定（可解释、可复算）

```
字号 = 短边 × 场景基准比(标题 0.11 / 字幕 0.048 / 弹幕 0.04 / 贴纸 0.07)
       × 粗细修正(1 + (2.5 − 粗细) × 0.04) × 平台字号倍率
描边 = 字号 × 0.06（花底 0.08）；安全边距 = 短边 × 0.05
```

平台版式（画幅 / 字幕位置 / 字号倍率 / 封面风格）与 **UI 遮挡区矩形**见
`library/font-catalog/font_db.json#layout_policy`；抖音/快手字幕默认上抬至底部 18%（避开点赞栏与文案区）。

## 六项复检（不达标即删产物，do-no-harm）

| 复检 | 口径 |
|---|---|
| 时间轴回读 | 写出的 ASS 事件与源 SRT 逐条一致（条数 + 起止） |
| 字幕可现度 | 字幕带加字前后 Δ ≥ 0.004（"配了跟没配一样"直接判失败） |
| 版式体检 | 字号占短边 / 行宽 / 安全区（实测墨迹外接框 × 遮挡区）/ 对比度 |
| 字体解析 | `fontselect` 日志全部命中工位字体目录（防空回落系统字体） |
| 分辨率保持 | 输出与母版宽高一致 |
| 音轨保持 | 有/无音轨与母版一致（音轨恒 copy，字幕不动音频） |

## 字体获取与安装（字体二进制不进仓库）

```bash
bash kit/install-fonts.sh --from-dir <字体包>/fonts   # 离线导入（逐文件 sha256 校验）
bash kit/install-fonts.sh --download                  # 直链获取（只放行已核验逐字节一致的条目）
bash kit/install-fonts.sh --check                     # 只核对现状
bash kit/selftest.sh [输出目录]                        # 端到端自检
```

档案与许可：`library/font-catalog/`（29 款：中文 13 + 英文 16，全部 OFL-1.1 或厂商免费商用）。
引脚与核验：`kit/fonts-pin.json`（逐文件 sha256 + 上游核验结果）。

## 真机演示与产物导出（不依赖数据库）

```bash
node bundles/ai-video/connectors/subtitle-bridge/demo-artifacts.mjs --out /tmp/subtitle-demo --platform 抖音/快手
```

产出 `source.mp4`（自造竖屏素材：深/浅/花三种底 + 环境声）、`subtitle.srt`、`brief.json`、
`subtitle-plan.json` / `.ass`、`burned.mp4`、`best.mp4`、`evidence-*.png`、`analyze-*.png`、`report.json`、`README.md`。

## 运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg + 真实字体）

```bash
set -a; source .env; set +a
node_modules/.bin/tsx bundles/ai-video/connectors/subtitle-bridge/runtime-smoke.mts
```

| 场景 | 期望 |
|---|---|
| clean：常规字幕+标题渲染 | `completed`，产出成片，回执 sha256 与磁盘文件一致（G-SUB0 auto 直通） |
| review：品牌视觉锤变更（许可未核验） | `pending_review` + 审批号（G-SUB1 review） |
| blocked：覆盖原片 | `paused`，`blockedBy=覆盖原片禁止`（G-SUB2 block） |
| blocked-license：非白名单字体许可 | `paused`，`blockedBy=字体许可不合规`（G-SUB5 block） |
| outage：工位不可达 | `failed` + 步骤标未核实（软失败不伪造回执） |

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- bridge 默认只监听 `127.0.0.1`，跨机置于内网反代 + mTLS 之后；
- **路径监狱**：`WORKLOOM_SUBTITLE_ALLOWED_ROOTS`（冒号分隔）之外一律拒绝，软链逃逸同样拦；
- **原片只读**：输出路径等于输入路径直接拒绝（`overwrite_source_forbidden`），并由围栏 G-SUB2 一票否决；
- 客户素材与成品只落工位/租户素材区，不上行蜂群；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 错误码

可重试：`network_error` / `timeout` / `ffmpeg_failed` / `decode_failed` / `engine_failed` / `bad_response`

不可重试：`path_not_allowed` / `tenant_mismatch` / `overwrite_source_forbidden` / `disk_quota_exceeded` /
`ffmpeg_not_installed` / `bad_media` / `bad_font` / `font_not_found` / `bad_style` / `bad_srt` /
`bad_recipe` / `license_blocked` / `verify_failed` / `not_found` / `not_provided` / `not_configured`

## 与字幕纪律的对应

| 纪律 | 落点 |
|---|---|
| 字幕必须看得清 | `analyze → decideTextStyle`（亮度/细节密度决定字色/描边/底衬）+ 对比度复检 |
| 字幕不得压平台 UI | 实测墨迹外接框 × `occlusion_zones` 求交（G-SUB3 硬闸） |
| 选了字体就真用它 | `fontselect` 日志核验（防空回落系统字体） |
| 时间轴不许漂 | ASS 回读 × 源 SRT 逐条对比 |
| 配了不能像没配 | 字幕可现度 Δ < 0.004 直接 `verify_failed` 并删除产物 |
| 原片只读 | `assertOutputWritable` 同款检查 + 围栏 G-SUB2 |
| 字体许可干净 | 白名单 + G-SUB1/G-SUB5；字体不进仓库、不子集化 |
| 无回执不算完成 | 六项复检 + sha256 回执 + outage 负例 |
