# WorkLoom 获客用增系统 · 本仓专属规则

> 本文件只适用于 workloom-ai/WorkLoom-growth（及其隔离实验副本的对应版本）。
> 开始实质性工作前，必须先完整阅读根级 `AGENTS.md` 与 `WORKLOOM_PRODUCT_CONTEXT.md`；
> 本文件只补充本仓的运行、验证与目录约定，**不替代、也不放宽**共享安全不变量与产品边界。

## 一、视频工位：内置角色资产（新接手最容易踩的一条）

**本仓自带默认模特「陈卓」（`chen-zhuo`），开箱即用——不要以为"仓库里没有人物资产"而重复建档。**

- 资产位置：`bundles/ai-video/library/characters/`（`registry.json` + `model-01-chen-zhuo/`，8 角度定妆照随仓分发）。
- 默认规则：镜头卡**不写** `character` / `characters` 时，出片链路自动使用 `registry.json#defaultModel`；
  运行日志会打印 `未显式指定模特 → 使用系统默认模特：陈卓（chen-zhuo，1 号）`。
- 装载方式：`scripts/tools/full-chain-film.mts` 固定装载 `bundles/ai-video/library/characters/**`
  （再叠加 `--library` 指向的项目自有档案），因此**无需额外参数**。
- 真人边界：真人肖像只能走平台授权通道（火山方舟「私域真人人像库」→ `asset://<asset ID>`）；
  **直传真人照片会被平台隐私闸拦**（`InputImageSensitiveContentDetected.PrivacyInformation`），本仓不提供绕过手段。
- 读到这里的动作清单：先看 `docs/character-registry.md`（规则 + 常见问题），再看
  `bundles/ai-video/library/characters/README.md`（目录内说明）；改档案/加模特后跑
  `node scripts/verify-builtin-character-assets.mjs`。

> 这条声明由自检脚本守护：`node scripts/verify-builtin-character-assets.mjs` 校验默认模特可解析、
> 四角度定妆照齐备（>50KB），且声明在 README / `docs/character-registry.md` / `docs/capability-map.md` /
> `bundles/ai-video/library/characters/README.md` 四处同步——声明被删会直接红灯。
> （把它接进流水线需按协议 §3 人审后在 `.cnb.yml` 的 static-gate 加一行调用。）

## 二、本仓运行与验证约定（摘要，详情见 docs/capability-map.md）

- 视频任务的第一步：完整读取 `docs/ai-video-workbench-guide.md`，或调用只读 `growth.video.workbench.guide`；实际 Codex 插件调用 `workloom_video_guide({})`。先冻结用户指定模特、商品、平台、时长、账号调性、声音和特殊要求，再走正式前期→渲染→后期→真实交付核验。方案/草案不代表已放行；不手搓生产流程，不擅自替声、变速或重渲。完整原片后期按本仓标准入口执行。

- 首启：`pnpm setup` → `pnpm preview:all`（三端：PC:3000 / B 移动:3001 / C 移动:3002，Mock 直登）。
- 能力自检：`pnpm agent:tour`；全量能力清单：`docs/capability-map.md`。
- 改能力面（脚本 / 包 / 技能 / 演示页）→ 必须 `pnpm capabilities` 重新生成人类版导览，再 `pnpm capabilities:check`。
- UI 改动必须用仓内 browser/computer-use 能力打开真实页面截图核对，不能只看 curl 与日志。
- 发布前 `pnpm release:gate` 全过（硬性门禁）；任务号与提交规范见 `docs/DEVELOPMENT-PROTOCOL.md`。

## 三、认证真人素材：先建档，再出镜（T-2026-0929-0007）

**客户给出的平台认证真人素材 ID（`asset://asset-…`）不等于"人物属性已知"。** 2026-09-29 真机事故：
镜头卡按上下文猜成"男性"，而认证素材本人是女性 → 模型跟文案、6 镜渲错人、全部被监制拒收，白烧算力。

硬规则（进出片链路前必读）：

1. 拿到 assetId 的**第一动作是问属性**（性别/年龄段/授权范围/有效期）并建主档
   `bundles/ai-video/library/real-person-assets/<assetId>/profile.json`；**不许"先渲一版看看"**。
2. 镜头卡（含代词）必须与主档一致；`g-real-person`（G-RP1）门在出片前逐镜核对，冲突即硬阻断。
3. 授权和人物属性在付费提交前核对；成功渲染镜头默认直接正式后期，**不做 canary、身份/服装/动作/口型/台词品质复审或因此重渲**。保留原始字节与任务事实；不能把默认采用写成人物认证。
4. 缺属性、缺授权、素材未登记 → fail-closed；禁止在文案里临时代替平台事实。

细则见 `docs/real-person-asset.md`。

## 四、影视制作：完成度最高优先级

**给用户或客户交付高完成度作品是影视制作的最高优先级。** 完整动作、整句口播、叙事推进与收束、自然观看节奏高于名义总时长。普通“30 秒”是创作目标，完整的 28、32、35 秒方案允许交付；不得为了凑秒把 4 秒多的镜头压成或截成 2 秒，不用补帧、冻结、循环或填充制造名义时长。

只有客户或实际投放合同明确登记的硬上限才约束总时长，不能自行把平台、模板或预算秒数解释成硬上限。超出时在付费前修订创作方案；已有素材不自动损坏，也不自动新增付费。规划给有明确动作的源镜登记 `lockTrim=true`，正常标准后期始终保留全部原片帧和同文件原声。交付记录目标、实测时长及差值。

该宗旨不新增渲染后质量复审。默认采用继续执行，技术事实通过不代表审美、发音或口型通过；未评审质量分写 `null/unverified`，不得虚构 100 分。执行点、输入及异常路径见 `docs/film-completion-policy.md`。
