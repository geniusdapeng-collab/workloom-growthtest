# 账号定位档案（account-profiles）

> 用途：把**账号级视觉锤**（字体/色板/版式/角标四件套）+ 钩子偏好 + 禁区落成一份可复用档案，
> 让同一账号的封面"长一个样"。口径依据：封面知识库 `ACCT-001`（账号定位→视觉锤）。
> 落仓位置：`bundles/ai-video/library/account-profiles/<账号id>.yml`

## 怎么用

```bash
# 出片时指定账号档案（缺省不传 = 无档案，行为与接入前完全一致）
tsx scripts/tools/full-chain-film.mts --shots shotlist.json --project VID-X \
  --account chen-zhuo --cover-platform xiaohongshu --theme 美食

# 只查注入载荷（不跑管线）
node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs enrich \
  --platform xiaohongshu --theme 美食 --account chen-zhuo
```

## 字段

| 字段 | 类型 | 说明 | 校验行为 |
|---|---|---|---|
| `account_id` | string | 唯一标识（= 文件名） | 必填 |
| `display_name` | string | 展示名 | 进 prompt |
| `positioning` | string | 一句话定位（≤20 字） | 进 prompt，不校验 |
| `account_type` | enum | `ip`（人设IP号）/ `brand`（品牌官号）/ `seeding`（种草号）/ `knowledge`（知识号）/ `local`（本地生活号）；也接受中文标签 | 未识别 → 忽略并记 note |
| `platforms` | list | 主发平台 ID | 仅作上下文 |
| `visual_hammer.fontId` | string | 锁定字体（`COVER_FONTS` 四选一：`smiley-sans` / `source-han-heavy` / `zcool-qingke` / `noto-serif`） | 偏离 → 告警；`strict=true` → 判非法 |
| `visual_hammer.palette` | list | `[主标题色, 强调色]`，`#RRGGBB` | 主标题色与强调色**都不在**色板内 → 告警/判非法 |
| `visual_hammer.archetype_bias` | enum | `person-led` / `subject-led` | 与片子版式不同只告警（版式以片子主视觉为准） |
| `visual_hammer.badge_series` | string | 系列角标（≤10 字） | 进 prompt |
| `hook_bias` | list | `HOOK-001` 公式 ID（question / conflict / data-shock / contrast / value-preview / curiosity-gap / pattern-interrupt） | 未收录 ID → 忽略并记 note |
| `taboo` | list | 账号禁区词（硬广话术等） | 命中 → 告警；`strict=true` → 判非法 |
| `strict` | bool | true = 偏离视觉锤判非法打回 | 缺省 false（只告警） |

## 纪律

1. **只增不改**：账号档案是账号资产，改版走产品确认；改完建议先跑一次
   `node bundles/ai-video/connectors/cover-kb-bridge/cli.mjs enrich --platform <平台> --account <id>` 自检。
2. **不静默降级**：`--account <id>` 指定的档案不存在时，管线**直接报错**（不退回"无档案"行为——
   否则会让人误以为账号一致性已生效）。
3. **偏离留痕**：非 strict 的偏离写进设计稿 `warnings` 与 `stages.jsonl` 的
   `evidence.accountProfile.warnings`，不允许静默丢弃。
4. **样例**：`chen-zhuo.yml` 是本仓内置模特「陈卓」的样例档案（城市人文旅行人设号），可直接复制改写。
