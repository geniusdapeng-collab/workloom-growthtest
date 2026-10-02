# WorkLoom 获客系统 · 系统详解（给 AI Coding Agent）

> 这份文档回答一个问题：**这套系统到底是什么、怎么运转、你该怎样在其中工作。**
> 阅读顺序建议：本文（认知）→ AGENTS.md（行动入口）→ docs/capability-map.md（全量能力清单）。
> 适用仓库：workloom（主仓）。workloom-im / workloom-hotel / hyperreality-system 共享同一底座，差异见文末。

---

## 1. 一句话定位

**WorkLoom 获客系统是一套面向 B 端商家的「AI 获客经营系统」**：以短视频社媒营销 × GEO（生成式引擎优化）双引擎触达客户，以「获客五环」（意图洞察→双域触达→四路承接→线索转化→归因复盘）闭环经营，每一环可度量到钱。首个深度垂直行业是**酒店**，底座支持按 Bundle 复制到各行业。

它不是 demo 玩具：有完整的多租户底座、围栏安全体系、人审机制、事件溯源和 400+ 条场景测试。

## 2. 业务模型（先懂生意，再懂代码）

```
意图洞察 → 双域触达 → 四路承接 → 线索转化 → 归因复盘
（雷达）   （内容+分发）（接住询盘） （券/私域）  （算清每块钱）
```

- **客户是谁**：低星单体酒店、民宿、无人酒店（三类默认客群配置），抽象后是"缺人、缺流量、被平台抽佣的中小商家"。
- **卖的是什么**：一支住进通讯录的 AI 获客班组——商家只做三件事：定方向、拍板、收钱。
- **关键业务对象**：intent_signal（意图）、content（内容）、lead（线索）、coupon_sku（券）、booking_order（订单）、conversion（成交归因）、poi_store（门店）、live_campaign（直播）。
- **人机权责红线**：AI 提案、人拍板。报价/券定价/线索出域/客资隐私等事项**必须人审**（围栏 R21–R26 强制），这是系统信任的根基，改代码时不可削弱。

## 3. 运行时形态（三端 + 服务 + 数据）

| 部件 | 位置 | 端口 | 说明 |
|---|---|---|---|
| server | `apps/server` | :8787 | tRPC（`/trpc/*`）+ C 端网关（`/c/*`）；无 /healthz |
| PC · B 端工作台 | `apps/web` | dev:5173 / preview:3000 | 经营主页（Canvas 剧场）+ 任务中心 + 规则中心 + 装配中心 |
| C 端 AI 服务前台 | `apps/webc` | dev:5176 / preview:3002 | 小程序入口 H5 模拟：对话/服务/工单/消息/我的 |
| B 端移动高保真 | `docs/demo/*.html` | preview:3001 | 12 页糖果色演示页 + 手机壳容器 |
| 数据 | PostgreSQL 17 + pgvector | :5432 | docker 容器 `workloom-im-pg`；RLS 工作区隔离 |

**一键看全貌：`pnpm preview:all`**（Mock 模式强制：种子数据 + 离线确定性模型 + C 端演示直登，无需任何密钥）。

## 4. 代码结构（四层）

```
apps/          三端应用 + server + site(官网) + desktop(Mac 桌面包)
packages/
  base/        业务底座 22 包（见下）
  db/          全部 SQL 迁移（sha256 漂移拒跑，单事务按序应用）
  runtime/     意图路由（规则+LLM 分类器）、QUEST 执行、L3 工具注册
  shared/      跨端共享类型
  video-studio/ 视频成片管线
bundles/       行业垂直包：hotel(获客 v3.3.0) / geo-growth(GEO 双域) / ai-video(短视频)
skills/official/ 自带技能 7 个（release-gate / industry-entry / demo-mirror 等）
scripts/       套件/种子/门禁/巡游/预览/生成器
docs/          设计规范、方案、能力地图、本文
```

### packages/base 关键包速记

| 包 | 职责 | 你必须知道的点 |
|---|---|---|
| `workdata` | 五元事件 + RLS + 记忆/检索 | 事件号源必须走 `biz_events_max_event_no()` SECURITY DEFINER 函数（RLS 会遮蔽 max(event_id)，这是踩过的坑） |
| `fence-engine` | 围栏 DSL 事前裁决 | 支持列表字面量/`in`/`contains`/`contains_any`；缺失路径在比较语境宽容 |
| `captain` | L2 编排（ASK/QUEST） | QUEST 内容域五步拆解：情报→脚本→人审→分发→回收 |
| `review-console` | 人审台 | 审批必须先有真实审批行；队列按规则隔离 |
| `night-shift` | 夜班自动运行 | ensureReady 幂等（裸 ON CONFLICT DO NOTHING） |
| `model-router` | 模型路由 | 离线确定性模型兜底；`TOOL_UNVERIFIED_RATE=0` 关闭扰动 |
| `publish-rpa` | 六平台 RPA 发布 | 不 import playwright；注入 `BrowserDriver` 接口接真浏览器（接法见 docs/agent-computer-guide §4） |
| `im-channels` | IM 渠道出入站 | 审批卡片直达企微；驱动可 mock |
| `service-*`（4 包） | C 端客服 | 知识库 385 问预置；C 端网关 `/c/*` |
| `bundles` | Bundle 装配器 | 装配在 RLS 属地工作区内执行；17 员工需 fence_bindings |

## 5. 核心概念（不懂这些会改错代码）

1. **五元事件**：一切业务动作落事件（who/what/when/where/envelope + hash 链），`pnpm db:verify-chain` 验链。回放/种子事件用 `E-RPL-`/`E-SEED-` 前缀隔离。
2. **RLS 工作区隔离**：跨区互不可见；探针/围栏查验必须切到 Bundle 属地工作区内执行。>500 大空洞查他区填充率≥50% 甄别共享序列正常消耗。
3. **围栏（Fence）**：规则即数据（fence_rules 表），事前裁决 allow/review/deny。酒店域 R1–R26、GEO 域 17 条。哨兵规则按仓选空位（主仓 R16）。
4. **Bundle 装配**：preset（员工）/围栏/技能/触发器/对象以 Bundle 为单位装载；装配器保证幂等与属地隔离。
5. **Mock 运行态**：种子数据 + 内置确定性模型 + `SERVICE_C_DEMO_AUTH` 演示直登。界面常驻"全模拟运行态"横幅是**刻意设计**。
6. **号源纪律**：T-###/VID-### 等主键全库唯一但按本区分配，用 `threads_max_t_no()`/`video_projects_max_vid_no()` 函数分配；bigint 返回 string，必须 `Number()` 后再 +1。
7. **内置人物资产（开箱即用的默认模特）**：本仓自带 1 号模特「陈卓」（`chen-zhuo`）——
   `bundles/ai-video/library/characters/` 里有档案正文（`profile.json`）+ 8 角度定妆照（`portraits/v3/`）+ 选角规则（`registry.json`）。
   **镜头卡不写 `character` 时，出片链路自动使用 `defaultModel`**（日志：`未显式指定模特 → 使用系统默认模特：陈卓（chen-zhuo，1 号）`）；
   不要以为"仓库里没有人物资产"而重复建档。真人肖像只能走方舟 `asset://` 授权素材，直传真人照片会被平台隐私闸拦。
   详见 `docs/character-registry.md` 与 `bundles/ai-video/library/characters/README.md`。

## 6. 你的工作流（照此执行，不会踩坑）

```bash
# ① 进仓
cat AGENTS.md                              # 行动入口（含 computer-use 浏览器能力 30 秒上手）
pnpm preview:all                           # 强制首启：看三端全貌（:3000/:3001/:3002）
pnpm agent:tour                            # 能力自检巡游（--full 含套件+门禁）

# ② 开发
pnpm dev                                   # server:8787 + web:5173（仅 PC 端）
# 改 UI → 必须用浏览器能力实际打开截图核对（preflight → browser_goto → snapshot → screenshot）
# 改能力面（脚本/包/技能/演示页）→ 必须 pnpm capabilities 重新生成人类版导览

# ③ 验证（硬性）
pnpm suite                                 # 445 条（主套件；geo/hotel 域另有 suite:geo/suite:hotel）
pnpm db:verify-chain                       # 改事件/号源后必跑
pnpm release:gate                          # 发布门禁：未全过禁止发布
pnpm capabilities:check                    # 能力产物与代码同步校验
```

**测试前纪律**：先停残留 8787/5173 服务——残留服务致 E2E 打错库，且 dev 侧夜班/扩编节拍产生的提案会污染套件断言（实测 R-26 误报）。库被污染时 `bash scripts/reset.sh` 复位。

## 7. 已知雷区（前人踩过，别再踩）

1. RLS 遮蔽 max(event_id) → 事件号源必须用 SECURITY DEFINER 函数（迁移 0015）。
2. bigint 返回 string → `"133"+1` 拼成 T-133111111111111111；先 `Number()`。
3. PG 不支持 `\d` 正则 → 用 `[0-9]`。
4. 围栏 DSL 的 `in [...]`/`contains_any` 曾不支持导致实战误杀——已在 expr.ts 补齐，新增 DSL 语法必须同步套件用例。
5. Canvas 区域（经营剧场地板）browser_snapshot 读不到内部元素 → 用 L3 截图定位 + 坐标点击；DOM 按钮仍走 L1。
6. 直连 GitHub 被网络策略拦截 → git 走 `ghfast.top` 镜像；npm 用 `registry.npmmirror.com`。
7. 8787 没有 /healthz，根路径 404 是正常的。

## 8. 四仓关系

| 仓 | 定位 | 与主仓差异 |
|---|---|---|
| **workloom**（本仓） | 获客系统主仓 | 全量：geo-growth + ai-video + hotel 获客域 + publish-rpa |
| workloom-im | IM 底座仓 | 无 geo/video/publish-rpa； bundles/hotel 基础版 |
| workloom-hotel | 酒店垂直仓 | + 数字孪生演示（demo:twin 系列） |
| hyperreality-system | 视频制作仓 | ai-video + video-studio + publish-rpa；无 geo-growth |

四仓共享 WorkLoom 底座（fence/captain/workdata/night-shift/RLS），同一套验证纪律与 Agent 引导体系（AGENTS.md / agent:tour / capability-map / preview:all）。

## 9. 索引（按需深入）

- 能力全量清单：`docs/capability-map.md`（机器版）/ `docs/capabilities.auto.md`（人类版，自动生成）
- 浏览器/电脑操作：`docs/agent-computer-guide.md`
- 视觉规范：`docs/design-system.md`（Candy Design System v1.0，UI 改动必须遵守）
- 发布清单：`docs/release-checklist.md`
- 业务方案：`docs/plan-acquisition.md`（获客五环）、`docs/geo-fusion-plan.md`（GEO 融合）、`docs/fusion-design.md`（架构）
- Mock 数据口径：`mock/README.md`
- 视频人物资产：`docs/character-registry.md`（内置默认模特「陈卓」规则 + 常见问题）｜ `bundles/ai-video/library/characters/README.md`（目录内说明）
