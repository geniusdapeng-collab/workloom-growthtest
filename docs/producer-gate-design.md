# 制片人门（AI 监制）机制设计 v2

> 任务：T-2026-0924-0001（T-2026-1031-9003 修订）· 生效范围：GrowthTest 视频管线
> 一句话：**质量控制不降级，人类审批等待取消**。G1–G7 保留 AI/确定性审查，G8–G15 保留围栏与预算检查；
> 所有 review 由 `workloom.video-auto-approval/v1` 自动裁决，block 仍然 fail-closed。

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
放行 → 推进管线      打回 → 返回 approved:false（本 run 终止并如实上报；**默认不自动重跑**，是否重做由人决定）
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
| `human` | 旧回滚路径；仅 `VIDEO_AUTO_APPROVAL=0` 时可用 | 兼容旧版本，不是默认行为 |

`HR_PRODUCER_FALLBACK_APPROVE=1` 时，模型不可用可降级放行，但裁决里 `degraded=true` 必须可见；
默认 **fail-closed**（模型不可用即打回并写"需介入"）。

**默认自动审批范围（T-2026-1031-9003）**：G1–G7 全部完成原有质量审查后自动批准；
G5 必须先通过实际出图、必需角度、文件字节和项目作用域核验。G8/G9/G10/G11/G12/G15 的 review
由系统策略自动裁决，原有预算、发布包、敏感内容、授权和 block 规则不变。
`VM_PRODUCER_RETRY` 默认 **0**（质量打回即停）；系统审批不会把质量打回改成通过。

## 二、为什么必须"先硬闸后模型"

- 硬闸结论**可复算、零 token**，且能抓住模型看不见的事实（例如"定妆照 0 张却报成功"）。
- 模型用在它真正擅长的地方：真不真、顺不顺、有没有遮挡与畸变（"像不像"这类判据不稳定，只留证，不作 G5 放行依据）。
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

- 不替代花钱与对外门的质量检查：渲染提交（G8）、公网发布（G9）、评论（G10）、
  投放（G12）、商单对外文件（G15）仍执行原有 review/block 规则，只取消人类等待。
- 不做渲染质量的自动返工：本机制只覆盖预生产与后期环节的评审；渲染失败仍按 `render-poller` 的失败语义处理。
- 不保证"模型评审一定对"：`degraded`、`via`、`score` 全部落账，便于事后复核与阈值调优。
