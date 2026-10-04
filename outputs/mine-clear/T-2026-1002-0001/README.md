# 导演 V2 和客户首启的执行证据

代码修复基线是 `df019d6be6a5a9409d8b5da5d255364ad8332c61`，审计及 main 基线是 `da06fdf1e1ead0cafc078ea27695397d2e9209db`。台账有 30 张卡、4 条不变量，28 张问题或修复卡为 fixed，2 张为 unfixed：MC-006 通用 GEO 步骤回执资格、MC-016 旧全局原生视觉与不稳定检查。fixed 是修复者回归状态；verified_by 均为空，独立 M6 未执行。

覆盖范围为 3138 个受控源文件：A 精读 158、B 机检 2960、C 抽样 20，未处理 0。B 文件未人工阅读全文，C 文件只读列明区段，机检覆盖不代表全仓理解。逐文件方法、区段、哈希见 ../../implementation-coverage.csv；2561 条执行记录见 ../../implementation-test-cases.csv，重复测试组不合计为独立用例总数。

入库的是最小化 JSON 与文本证据、逐文件覆盖率和执行用例。Mac ZIP、真人素材、环境文件、运行数据库、媒体工具、截图和合成 MP4 没有入 Git。完整中文报告和安装指南作为本任务的本地 outputs 交付；包哈希、代码版本与首启关联可核对 ../../mac-trial-artifact-receipt.json。代码头三条 CNB CI 通过，最终证据提交头的远端状态在任务交付回执中单独核对。

| 证据 | 数据模式和实际结果 |
|---|---|
| evidence/real-text-llm.json | 真实文本模型六场景、两轮、并发 2/4，12 条链与 48 次调用；真实服务另 4 次文字和 4 次健康查询；图像视频 0 |
| evidence/reused-source-service.json | 已捕获真实文字方案的可信准备，6 条合成镜头；受保护服务四版、媒体 GET、选择、配乐返修、24 条声音来源；通过 |
| evidence/local-ffmpeg.json | 可重现合成四片、六对差异、连续返修、CAS/幂等/竞争/篡改/缺音乐；通过 |
| evidence/director-json-roundtrip-before.json | 修前真实 PostgreSQL 数组回读失败，15 用例中 14 通过、1 失败；修后 15/15 和完整服务通过 |
| evidence/clean-dependency-install.json | 物理 frozen 依赖安装、全 11 包类型检查和三端构建；通过 |
| evidence/ci-linked-regressions.json | BGM 导入闭包与真实 PG 安全探针 55/55；通过 |
| evidence/ci-third-regressions.json | 默认委托/资格 focused 105/105；完整服务器 994/996、0 失败、2 FFmpeg 环境跳过；通过 |
| evidence/ci-fourth-regressions.json | 完整网页 142/142、类型、生产构建和客户端边界；通过 |
| evidence/cnb-code-head-passed.json | 代码头 df019d6 的 static/db/test 三条流水线成功；不等同正式发布资格 |
| evidence/test-summary.json | 相关 1119/1120 且 1 pending、导演 PG 15/15、模型路由 PG 11/11、Node 105/105、辅助门禁 10/10、最终两宽度 UI；测试组存在重叠 |
| evidence/director-final-ui.json | 最终载荷复用原生新装数据库，1440/390 实际输入、返回片库、重新进入导演页、专业跳转通过；无创作提交，完整成片 UI 未验证 |
| evidence/director-final-ui-loading-before.json | 早前权限加载超过 30 秒的失败保留；最终通过没有对应应用代码修改，不声明已定位或修复等待原因 |
| evidence/mac-final-firstboot.json | clean6 全新中文空格、最小 PATH，约 293 秒 ready，原生 exit 0；438.383 秒含渲染与退出；外部观察 exit 1，全面视觉未合格 |
| evidence/mac-native-attempts.json | 首轮口型零、种子外部限时、最终原生通过但弹窗观察失败、同库 3D 职场失败四组记录；旧全局视觉发现未修 |
| evidence/nats-foreign-port.json | 外来端口占用走本实例 memory fallback，退出保留外来监听器；通过 |
| evidence/corrected-release-gate.txt | 通用发布门禁 exit 1、10/11，Q-01 GEO mock 缺步骤回执；旧假绿无效 |
| evidence/agent-clients.json | Codex CLI 和 DSH 官方插件各完成两次 MCP 调用；原生 GUI 未执行 |
| evidence/ledger-gate.json | 台账结构检查结果，不是独立生产验收 |

## 复测入口

在隔离测试目录中准备本仓规定的依赖、有效数据库角色和已迁移 schema。DIRECTOR_TEST_ENV_FILE 指向测试数据库环境，不提交其内容。

```bash
RUN_DB_TESTS=1 node --env-file="$DIRECTOR_TEST_ENV_FILE" \
  node_modules/vitest/vitest.mjs run apps/server/src/video/director.pg.test.ts

node scripts/test-director-local-media.mjs \
  --work-dir "$DIRECTOR_TEST_DIR" \
  --ffmpeg "$VERIFIED_FFMPEG" \
  --ffprobe "$VERIFIED_FFPROBE"

node --experimental-strip-types --test scripts/release-gate-quest.test.mjs
```

本地媒体回归不调用图像或视频供应商。测试声音签发不证明真实原片的分轨能力、上游音乐版权审核或真人审美提升。完整服务的可信准备不属于公共 API，不能代替正常生产资格。

Windows 原生首启、Developer ID、公证、稳定 Bundle 资格、付费媒体、真人美观、原生 Agent GUI、长期运行和独立 M6 没有通过记录。原生 ready、浏览器输入与跳转已取得证据，全面原生视觉仍未合格；PR 保持 WIP。
