# 导演 V2 和客户首启的执行证据

代码修复基线是 `5f02a02830f8d0dbb337ab94aef354296e0eb5a4`，审计及 main 基线是 `da06fdf1e1ead0cafc078ea27695397d2e9209db`。台账有 15 张卡、4 条不变量，14 张问题或修复卡为 fixed，1 张通用 GEO 回执资格卡为 unfixed。fixed 是修复者回归状态；verified_by 均为空，独立 M6 未执行。

入库的是最小化 JSON 与文本证据、逐文件覆盖率和执行用例。Mac ZIP、真人素材、环境文件、运行数据库、媒体工具与合成 MP4 没有入 Git。完整中文报告和 Mac 安装指引作为当前任务的本地 outputs 交付；Mac ZIP 的哈希、代码版本与首启关联可核对 `../../mac-trial-artifact-receipt.json`。

| 证据 | 数据模式和结果 |
|---|---|
| `evidence/real-text-llm.json` | 真实文本模型 12 条链、48 次调用；另有真实服务 4 次文字和 4 次健康查询；图像视频 0 |
| `evidence/reused-source-service.json` | 已捕获真实文字方案的可信准备，6 条本地合成镜头；受保护服务四版、媒体 GET、选择、配乐返修、24 条声音来源；通过 |
| `evidence/local-ffmpeg.json` | 可重现本地合成四片、六对差异、连续按层返修、CAS/幂等/竞争/篡改/缺音乐；通过 |
| `evidence/director-json-roundtrip-before.json` | 修前真实 PostgreSQL 回读数组失败，15 用例中 14 通过、1 失败 |
| `evidence/test-summary.json` | 修后导演 PG 15/15、模型路由 PG 11/11、相关 1119/1120 通过且 1 pending、Node 105/105、辅助门禁 10/10 |
| `evidence/mac-final-firstboot.json` | 最终 clean2 载荷 Mac ARM64 原生首启，中文空格、最小 PATH、51.605 秒；通过 |
| `evidence/nats-foreign-port.json` | 实际外来端口占用走本实例 memory fallback，退出不关闭外来监听器；通过 |
| `evidence/corrected-release-gate.txt` | 通用发布门禁真实 exit 1、10/11，Q-01 因 GEO mock 缺步骤回执为红；旧假绿无效 |
| `evidence/agent-clients.json` | Codex CLI 和 DSH 官方插件各完成两次 MCP 调用；原生 GUI 未执行 |
| `evidence/ledger-gate.json` | 台账结构门禁通过，不是独立生产验收 |

## 复测入口

在隔离的测试目录和数据库中准备本仓规定的依赖、有效数据库角色与已迁移 schema。`DIRECTOR_TEST_ENV_FILE` 指向该测试数据库环境；不要把其内容提交。

```bash
RUN_DB_TESTS=1 node --env-file="$DIRECTOR_TEST_ENV_FILE" \
  node_modules/vitest/vitest.mjs run apps/server/src/video/director.pg.test.ts

node scripts/test-director-local-media.mjs \
  --work-dir "$DIRECTOR_TEST_DIR" \
  --ffmpeg "$VERIFIED_FFMPEG" \
  --ffprobe "$VERIFIED_FFPROBE"

node --experimental-strip-types --test scripts/release-gate-quest.test.mjs
```

本地媒体回归不调用图像或视频供应商。声音来源签发仅对人工测试来源有效，不代表真实原片的分轨能力、上游音乐版权审核或真人审美通过。

Windows 原生首启、Developer ID、公证、稳定 Bundle 资格、付费媒体、真人美观、长期运行和独立 M6 没有通过记录。完整服务脚本的可信测试准备不属于公共 API，不能用准备步骤代替正常生产资格。
