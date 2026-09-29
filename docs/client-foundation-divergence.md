# 三端客户端基座 · 本仓产品分叉声明（growth 专用）

> 适用：`WorkLoom-growthtest` ｜ 首次落地：2026-09-19 ｜ 关联任务：`[T-2026-0919-0006]`

## 1. 背景：为什么本仓会"门禁失败"

基座的三端客户端基座（`apps/web` / `apps/webb` / `apps/webc` + `@workloom/ui` 稳定版）默认要求：
**行业仓不得直接修改受管客户端文件**，行业差异只能放在 Bundle / theme / projection / config / extension 白名单目录里
（`scripts/verify-client-foundation-consumer.mjs` 的原始口径）。

但 growth 不是"行业仓"，而是**三端壳之上的产品分叉**：页面（`src/pages/**`）、应用壳（`src/App.tsx`、`src/shell/**`）、
语音（`src/voice/**`）、首日上岗引导（`src/onboarding/**`、`src/components/mate-guide/**`）都是获客增长产品层，
天然不可能与基座三端壳逐字节一致。基座协议 §10「实验车道」正是为这种仓设计的，
但其实现（引擎 + 随仓门禁）当前只覆盖"新增文件"，受管文件的定制仍会被判分叉。

**决策（2026-09-19，产品所有者）**：该适配**不回流基座**，全部在 growth 仓内闭合。

## 2. 机制：本仓自有路径声明

新增仓内声明文件 **`.workloom-client-extensions.json`**：

```json
{
  "schemaVersion": "workloom.client-extensions/v1",
  "reason": "为什么这些路径属于本仓产品层",
  "industryExtensionPaths": ["apps/*/src/pages/**", "apps/*/src/voice/**", "..."]
}
```

本仓的 `scripts/verify-client-foundation-consumer.mjs` 读取它，并把其中路径视为**本仓自有**：

- 豁免「客户端根存在非白名单行业文件」检查；
- 豁免受管文件的**指纹比对**（这些文件的维护责任在本仓，基座历史指纹不再是判据）；
- 未声明时行为与基座原口径完全一致（缺省不放宽）。

同时**仍然强制**（不允许用声明绕过）：

| 约束 | 强制点 |
|---|---|
| 四个必备受管入口存在且受管（三端 `main.tsx` + `apps/webc/public/service-front.config.json`） | 门禁 `REQUIRED_MANAGED_ENTRIES` |
| 全局 5 条行业扩展白名单与 state 逐条相等 | 门禁白名单相等校验 |
| `@workloom/ui` 与 `.workloom-ui.json` 同版、消费门禁通过 | `scripts/verify-ui-consumer.mjs` |
| 声明路径必须是 `apps/` 下、不含 `..` | 门禁对声明本身做格式校验（非法即红） |

回归测试：`scripts/verify-client-foundation-extensions.test.ts`（`pnpm test:scripts` 内执行）——
没有声明时仍报错；有声明时 0 错误；删掉必备入口仍报错；非法声明路径报错。

## 3. 当前状态与残余风险（诚实边界）

- **当前**：`node scripts/verify-client-foundation-consumer.mjs --repo .` 通过
  （原先 38 项：20 项受管指纹漂移 + 18 项非白名单；现由 12 条声明路径接管）。
- **base-sync heartbeat（拉取式同步）**：其验证步骤执行的是**本仓这份门禁**，因此同样通过。
- **基座驱动的一键 UI 升级波次（`sync/ui-upgrade-pr.mjs`）仍会 fail-close**：
  该流程在临时 clone 中会用基座自带（未改造）的门禁与引擎复算，且会覆盖本仓这一份脚本。
  这是**有意的边界**——本仓不改基座代码。届时的两条路径：
  1. 由基座 owner 落地"仓级扩展路径全链路"（已作为基座议题记录在 workloom-im 任务卡 `#33`，未合并）；
  2. 或本仓走**人工升级**：按 release 说明同步 UI 稳定版到三端、更新 state 指纹，并保留本声明文件。

## 4. 维护约定

新增产品层目录（不在上述声明内）时：

1. 在 `.workloom-client-extensions.json` 的 `industryExtensionPaths` 增加对应 glob（`apps/` 前缀、无 `..`）；
2. 同步在 `docs/client-foundation-divergence.md` 的说明里注明用途；
3. 跑 `pnpm test:scripts` 与 `node scripts/verify-client-foundation-consumer.mjs --repo .`。

**不要**把这些路径写进 `.workloom-client-foundation.json`（那是基座下发的受管 state，
下一次升级会覆盖），也不要放宽任何"必备入口 / UI 同版"约束。
