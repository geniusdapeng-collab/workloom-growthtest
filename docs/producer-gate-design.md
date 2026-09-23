# 制片人门（AI 监制）机制设计 v1

> 任务：T-2026-0924-0001 · 生效范围：AI 视频预生产内部门（G1–G7）与全链路出片
> 一句话：**把人从"逐门点确认"里拿掉，换成"机器评审 + 打回重跑"，人只保留花钱与对外的否决权。**

## 〇、要解决的问题

预生产链路上原有 7 个确认门（G1–G7）。历史上实现走了两个极端：

1. **等人点**：每门插一条 `approvals` 行、轮询到超时（默认 2 小时）。结果是"全自动出片"名不副实——
   真机 2026-09-21 就卡在定妆照门，`completedPortraits=0` 无人放行，渲染门直接 `BINDING_MANIFEST_INVALID`。
2. **一律放行**：`HR_AUTO_GATES` 默认把 G1–G7 全部 `approved:true`。取消防线后，坏产物（空提示词、字段被
   下游补齐、定妆照只有规格包）会被静默带到渲染与成片，问题只在最终成片暴露。

产品口径是**全自动预生产 + 人工只管花钱与对外**，所以内部门需要的既不是"等人"，也不是"没有门"，而是
**一个能看懂产物的机器监制**：看产物、按纪律判定、不合格就打回重跑，并把裁决留痕。

## 一、机制

```
vendor 确认门 → resolveGate(G1..G7)
      ↓
[确定性硬闸]  空内容 / 占位符 / 内容过短 / 定妆照未真出图 / 必需角度缺失
      ↓ 全过
[模型评审]    环节要点 rubric + 产物（图像类附基准图）→ {approved, score, issues, suggestions}
      ↓
放行 → 推进管线      打回 → 返回 approved:false（本 run 终止，由发起方按建议重跑）
      ↓
五元事件留痕：gate / producerMode / approved / score / via / model / degraded / issues / suggestions
```

- 实现：`packages/video-studio/src/producer-gate.ts`（新增）+ `apps/server/src/video/studio-worker.ts`（接线）
- 岗位：`bundles/ai-video/presets/producer.yml`（制片人，绑定 G1–G7）
- 纪律：`bundles/ai-video/skills/producer-gate-review/SKILL.md`
- 全链路执行器：`scripts/tools/full-chain-film.mts`（脚本 → 提示词 → 关键帧 → 镜头 → 合成 → 调色 → 字幕 → 弹幕 → 配乐 → 封面 → 母版）

### 三档开关（`HR_PRODUCER`）

| 值 | 行为 | 用途 |
|---|---|---|
| `review`（默认） | AI 监制评审放行/打回 | 生产口径 |
| `auto` | 内部门无条件放行（事件标 `autoApproved`） | 应急/离线演示 |
| `human` | 恢复 approvals 行 + 轮询等人点 | 客户要求人工把关时 |

`HR_PRODUCER_FALLBACK_APPROVE=1` 时，模型不可用可降级放行，但裁决里 `degraded=true` 必须可见；
默认 **fail-closed**（模型不可用即打回并写"需介入"）。

## 二、为什么必须"先硬闸后模型"

- 硬闸结论**可复算、零 token**，且能抓住模型看不见的事实（例如"定妆照 0 张却报成功"）。
- 模型用在它真正擅长的地方：像不像、真不真、顺不顺、有没有遮挡与畸变。
- 打回要带**可执行建议**，否则重跑还是会得到同样的产物。

## 三、真机证据（2026-09-24 · VID-PJL01 平江路 30 秒人物短片）

| 环节 | 监制结论 | 证据 |
|---|---|---|
| 提示词（6 镜） | 首轮**打回** | 交付闸报"台词总占比超标 4.3s/5s>80%"与"【情绪】缺可见部位微动作"→ 按建议改台词与情绪字段后，第二轮 6/6 放行（1866–2064 字） |
| 定妆照 v1（纯文生图 8 角度） | **打回**（score 28） | "生成人物与基准照片明显非同一张脸（眼型/鼻型/唇形/脸型均不同）" → 建议用授权真人照片做图生图重跑 |
| 定妆照 v2（图生图 8 角度） | **放行**（score 86） | "与基准照片为同一张脸、同一发型服装，纯写实无塑料感" |
| 关键帧 6 镜 | 放行 6/6（84–87） | 逐镜给出人物一致性、写实度、构图、场景与镜头卡比对的理由 |

## 四、配套的两个真机修复（同一批次）

1. **定妆照逐角度隔离 + 幂等**（`portrait-agent.ts`）
   - 真机：`actionPose` 命中 `OutputImageSensitiveContentDetected` → 原实现整批抛错，已出的 5 张全部作废；
   - 现在：安全拦截自动换"去动作化"措辞重试一次；仍失败只记该角度（`failedAngles`），档案照常登记；
     同角度文件已存在即复用（不重复烧额度）；只有一个角度都没成功才抛错。
2. **真人题材首帧必须用托管 URL**（`full-chain-film.mts` + 探针 `work/film/probe-first-frame.mts`）
   - 真机：Seedance 对 base64 形式的真人图返回 `InputImageSensitiveContentDetected.PrivacyInformation`（first_frame / reference_image 都被拒）；
   - 同图以**同账号模型产物的 Ark 托管 URL** 引用即被受理（探针 A/B/C/D 四态实测）；
   - 因此关键帧出图后必须把 Seedream 返回的托管 URL 存下来（`plates/<shot>.hosted-url.json`，20 小时老化）。

## 五、不解决什么（边界）

- 不替代花钱门与对外门：渲染提交（G8）、公网发布（G9）、对外评论（G10）仍需人审。
- 不做渲染质量的自动返工：本机制只覆盖预生产与后期环节的评审；渲染失败仍按 `render-poller` 的失败语义处理。
- 不保证"模型评审一定对"：`degraded`、`via`、`score` 全部落账，便于事后复核与阈值调优。
