# 认证真人素材：主档 + 一致性门 + canary（G-RP1）

> 任务卡：`T-2026-0929-0007` ｜ 建立日期：2026-09-29
> 事实源：`packages/video-studio/src/real-person-asset.ts` ｜ 主档库：`bundles/ai-video/library/real-person-assets/<assetId>/profile.json`
> 使用方：`scripts/tools/full-chain-film.mts`（出片前硬门 + canary）

## 1. 事故复盘（为什么会有这道门）

客户提供了平台已认证的真人素材 ID（`asset://asset-20260101000000-demo`）。系统当时**只校验"这个引用能不能提交"**：
格式是否合法、Seedance 是否受理（不再返回 `InputImageSensitiveContentDetected.PrivacyInformation`）。

**没有任何一处记录"这位真人是谁"**：人物性别/年龄/外貌全部来自镜头卡文案。于是当文案写"男性"而素材本人是女性时，
模型跟随文案 → 6 镜渲成男性 → 监制按合同判"身份不符"全部拒收 → 白烧 6 镜 × 2 次渲染 + 大量时间。

**根因一句话**：把"素材引用"当成了"人物身份"，缺少人物属性的**唯一事实源**与**一致性硬门**。

## 2. 机制（四道锁，缺一不可）

| # | 锁 | 位置 | 失败行为 |
|---|---|---|---|
| 1 | **主档必填**：每个 `asset://` 必须在 `real-person-assets/<assetId>/profile.json` 有主档（性别、年龄段、授权、证据、来源） | 出片前 | fail-closed，提示先建档 |
| 2 | **属性一致**：镜头卡的 `character/sceneDescription/action/costume/…` 与主档逐项比对（性别词、年龄段、assetRef） | 出片前（G-RP1） | 冲突即硬阻断（"文案男性 vs 认证女性"当场停） |
| 3 | **不许猜**：主档缺 `gender` → 停下来问客户，**禁止先生成再看看** | 出片前 | fail-closed |
| 4 | **先小样后全片（canary）**：多镜真人片先渲 1 镜并通过身份比对，才渲其余镜头 | 渲染中 | canary 不过 → 停止后续渲染，不再白烧 |

出片后还有一道：监制评审带上主档属性（`identityReviewContext`）做**身份比对**，缺证据必须拒绝，不得猜测；
每次使用落一条"人物使用留痕"（谁、哪个素材、用在哪些镜头）。

## 3. 主档格式

```jsonc
{
  "schemaVersion": "workloom.real-person-asset/v1",
  "assetId": "asset-20260101000000-demo",
  "displayName": "客户方 CEO（示例企业）",
  "role": "出镜主讲人",
  "certified": {
    "gender": "female",              // 必填；缺了就是"先问客户"，不是"先拍"
    "ageBand": "三十岁上下",
    "hair": "深色及肩直发（以参考素材为准）",
    "wardrobeBaseline": "高定黑色小香风套装（小黑裙廓形）",
    "source": "火山方舟「私域真人人像库」平台认证；属性由产品所有者 2026-09-29 确认",
    "evidence": "asset://asset-20260101000000-demo"
  },
  "authorization": { "status": "real-authorized", "scope": "本项目内使用其真人形象出镜", "evidence": "…" }
}
```

## 4. 纪律（写进流程，而不是靠记忆）

1. **拿到 assetId 的第一件事是问属性**（性别/年龄段/授权范围/有效期），然后建档；不允许"先渲一版看看"。
2. **镜头卡不许写与主档冲突的性别词**（含"他/她"代词）；评审与门都会按主档核对。
3. **多镜必跑 canary**；canary 未过时，产物与门记录保留，**不得**继续渲染其余镜头。
4. **授权是平台侧事实**：本工具只校验主档登记与有效期，不向平台核验归属（`external-asset-id-not-provider-verified`）。
5. 新客户/新素材同理：**没有主档就没有出镜**。

## 5. 真机证据（2026-09-29）

| 场景 | 结果 |
|---|---|
| 主档齐备 + 镜头卡写女性 + `asset://asset-20260101000000-demo` | `G-RP1 ok`：6 镜与主档一致（门记录含资产 ID 与授权证据） |
| 镜头卡写"东亚男性/四十岁上下"（历史事故形态） | 单测硬失败：`gender-conflict` + `age-conflict`（不生成、不花钱） |
| 主档缺 `gender` | 硬失败 `gender-missing` / `gender-unspecified` → 先问客户 |
| `assetRef` 指向未登记素材 | 硬失败（提示先建主档） |
