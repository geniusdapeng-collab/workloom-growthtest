# 视觉工位部署与运行手册（Compositor）

> 定位：给获客增长系统的「视觉设计师」数字员工配一台 Mac 工位。
> 技术事实：渲染内核复用上游 Compositor 源码（MIT），本仓以 headless 方式调用；
> 固定版本 **Compositor v1.0.4**（2026-09-18 发布，MIT，上游 `robbietilton/Compositor`）。

## 1. 适用边界

| 能力 | 是否需要 GUI App | 系统要求 |
|---|---|---|
| 配方→`.comp`→PNG/JPEG 渲染、文字预渲染、尺寸/哈希校验 | 否（headless 引擎） | macOS 15+ + Xcode Command Line Tools |
| 打开 `.comp` 人机精修、导出 | 是（Compositor.app） | 官方 DMG：macOS 26.5+；本机已验证 macOS 15 自编译路径（见 §1.1） |
| GUI 自动化（AX 驱动菜单/保存面板） | 是 | 需辅助功能/屏幕录制授权（TCC，一次性人工授予） |

生产建议：**先用 headless 引擎承接批量素材**；GUI 仅用于「人机协作精修」与必要的人工复核。
未装 Compositor.app 的工位，`visualread.snapshot` 会明确返回 `compositor_not_installed`，不伪造回执。

### 1.1 macOS 15 自编译（本机已落地）

上游 PR #8 提供 macOS 15 兼容改动；配合剥离两处 macOS 26 SDK 符号（`ToolbarSpacer`/`borderShape`）
与移除 Sparkle，可在 macOS 15 + Command Line Tools 环境用 SwiftPM 构建可运行的 `Compositor.app`。
该构建是**本地验证构建**（ad-hoc 签名、无自动更新、无图标），渲染内核与上游一致：
同一 `.comp` 在 app 文档模型路径与 headless 引擎下导出的 PNG sha256 **逐字节一致（5/5）**。
构建步骤与补丁清单见 kit 的 `work/compositor-app/patches/UPSTREAM-APP-PATCHES.md`。

## 2. 安装（headless 工位）

```bash
# 1. 渲染引擎：用上游 Compositor 源码构建 headless CLI（见 work/compositor-kit）
swift build -c release            # 产物：.build/release/compositor-cli
./compositor-cli selftest ./var/selftest   # 5 项金样本自检须全绿

# 2. bridge 常驻（LaunchAgent，安装到 ~/Library/Application Support）
bash bridge/install.sh --port 9773 --host 127.0.0.1

# 3. 冒烟
python3 bridge/smoke.py           # health / auth / compose / verify / async / mcp / audit
python3 bridge/demo_call.py       # 经 HTTP 出一张 1200x1600 成品并校验
```

macOS TCC 注意：LaunchAgent 不能读取 `~/Documents` 下的脚本与二进制，安装脚本会把运行时复制到
`~/Library/Application Support/WorkLoomVisualBridge/`，源目录仅作为安装来源。

## 3. 与 WorkLoom 的接线

- 岗位：`bundles/geo-growth/presets/visual-designer.yml`（视觉设计师，写岗位，绑定 G-GEO2/G-VIS1..4）
- 技能：`bundles/geo-growth/skills/compositor-designer/SKILL.md`
- 围栏：`bundles/geo-growth/fences/geo-growth-visual.yml`（G-VIS1..G-VIS5）
- 连接器：`bundles/geo-growth/connectors/visual-bridge/executor.ts`
  （结构兼容 `packages/runtime/src/tools.ts` 的 ToolExecutor；部署适配器负责注入）
- 事件：`visualdesign.brief / compose / render / qc / publish`，回写入一客一档 `content_assets`

### 3.1 运行时端到端（真实 PG + 围栏 + bridge，本机实测）

```bash
set -a; source .env; set +a
./node_modules/.bin/tsx bundles/geo-growth/connectors/visual-bridge/runtime-smoke.mts
```

- clean：3/3 `completed`，`biz_events.receipt.synced=true`，rule_impact=G-VIS0 pass；
- blocked：`paused`，`blockedBy=视觉文案事实红线`（G-VIS2），工具未执行；
- review：`pending_review` + 审批号；
- 产物 sha256 与 `visualread.verify` 事件结果一致。

宿主接线的基座侧改动以提案形式给出：`proposals/workloom-im/0001-deployment-tool-executor-seam.md`；
行业侧适配器 `connectors/visual-bridge/server-adapter.mts` 已随分支提供。

### 3.2 过渡生产入口（基座 seam 落地前）

```bash
set -a; source .env; set +a
export WORKLOOM_VISUAL_BRIDGE_URL=http://127.0.0.1:9773
export WORKLOOM_VISUAL_BRIDGE_TOKEN_FILE="$HOME/Library/Application Support/WorkLoomVisualBridge/token"
export WORKLOOM_VISUAL_BRIDGE_TENANT=ws-geo
export WORKLOOM_VISUAL_BRIDGE_OUT_DIR="$HOME/Library/Application Support/WorkLoomVisualBridge/var/tenants/ws-geo/out"

# 单任务（--plan cover 或 --plan-file 传 QuestStep[]）
./node_modules/.bin/tsx scripts/visual-quest-runner.mts \
  --workspace ws-geo --goal "给新品做一张封面" --plan cover --write-archive \
  --report reports/visual-$(date +%F).json

# 夜班批处理（cron/launchd 调同一入口；失败退出码 1 触发告警）
./node_modules/.bin/tsx scripts/visual-quest-runner.mts --batch jobs.json --report reports/nightly.json

# KPI（周报口径：任务/渲染/成品/回执率/verify/线程状态/按天按租户）
./node_modules/.bin/tsx scripts/visual-kpi.mts --days 7 --markdown reports/visual-kpi.md
```

- `--write-archive`：成品 + sha256 + thread_id 写入一客一档 `content_assets.visual_assets`（幂等）；
- 回执 sha256 来自 `decision.after.result`（v1 ReceiptSchema 冻结，不扩字段）；
- 生产节拍建议：夜班 02:00 批处理 + 每日 08:00 KPI 进 ops-rhythm 周报。
- outage 演练：桥不可达时任务 `failed` 且步骤标未核实（`runtime-smoke.mts` 已覆盖）。

### 3.3 模板、考试题与合规

- 模板：`compositor-kit/templates/`（小红书 3:4、抖音 9:16、公众号首图 2.35:1 + 品牌包示例 + 平台规格注册表）；
  bridge 支持 `{"template": "...", "vars": {...}}`，缺参/未解析失败关闭；
- 上岗考：`bundles/geo-growth/eval/questions.json`（10 题：4 红线 + 1 holdout，覆盖 G-VIS1/2/3/4、提示注入、无回执、归档），
  已通过基座 `loadVerifiedBundleEvalQuestions` 校验；
- 合规：`compositor-kit/compliance/`（极限词/肖像/第三方素材/AI 标识/留存）与 G-VIS1/2/5 一一对应；
- 工位发行：`make-release.sh`（sha256）→ `install-release.sh`（无需 Xcode）→ `doctor.sh` / `upgrade.sh` / `rollback.sh`。

## 4. 版本与供应链

- 固定 **Compositor v1.0.4**；工位关闭 Sparkle 自动更新（上游 appcast 指向 GitHub raw，生产不跟自动更新）；
- 升级流程：`pnpm oss:watch` 周扫描 → 人工评估 → 新工位灰度（先跑 `selftest` 与 golden 图对比）→ 全量；
- 引擎来源锁定：本仓构建使用上游 v1.0.4 源码 + 机械化的 headless 裁剪补丁（见 kit 的 `patches/`）；
- 许可：MIT，保留上游 LICENSE 与修改说明。

## 5. 安全基线

1. 工位独立 VLAN/安全组，只有 WorkLoom 服务端可访问 bridge；bridge 默认仅监听 127.0.0.1，跨机必须经内网反代 + mTLS；
2. token 存工位本机（0600）或受控秘密存储，不进仓库/日志；bridge 拒绝无 token 启动；
3. 素材路径白名单（`allow_roots`）；输出路径不得逃逸工作目录；
4. 客户素材与成品不出租户域、不上行蜂群；
5. 无回执 = 未核实：`visualread.verify` 未通过或缺少 receipt 的成品禁止进入发布队列（G-VIS5）；
6. 人像/第三方素材先过合规审（G-VIS1）；极限词/未确认参数直接阻断（G-VIS2）；
7. 每租户日渲染 50 张上限，超限熔断转人审（G-VIS3）。
8. 截图回执 fail-closed：bridge 未获屏幕录制权限时返回 `screen_recording_permission_required`，
   不产出「空白图 + synced=true」的假证据；授权助手 `bash bridge/grant-screen-recording.sh`。

## 6. 故障与降级

| 故障 | 行为 |
|---|---|
| bridge 未启动 | 工具调用失败 → 任务挂起转人工，不产生假回执 |
| 渲染失败 | 重试 ≤3 次 → 仍失败挂起；事件记录 `visualdesign.render.failed` |
| 工位磁盘不足 | `visualread.health` 暴露 `disk_free_bytes`；低于阈值停止接单 |
| 上游/引擎升级 | 先 selftest + 对比 golden 图，再灰度；失败回滚到 pin 版本 |
| 无 Mac 工位可用 | 降级到 HTML/CSS→PNG 版式链路，并在素材上标注「降级产出」 |
