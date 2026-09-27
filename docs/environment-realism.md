# 环境真实性：从"相机拍得到"到"道具站得住"（2026-09-27）

> 起因：销售口播片 8 镜**全部通过监制**，产品所有者复检第一句话是"空间布景不像实拍、像随意口播"。
> 另一条同批反馈："手机屏幕朝观众"这类物理逻辑错误也要**机制化提前发现**。
> 本文回答：环境真实感到底由什么构成、管线里怎么判、字段怎么写、以及这两类问题如何做到"渲染前就拦得住"。

## 一、现状（改造前的事实）

| 判据体系 | 关注点 | 对"不像实拍"的结论 |
|---|---|---|
| `PRODUCER_RUBRICS.keyframe`（旧） | 人物一致性 / 写实度 / 构图 / 无文字 / **场景与镜头卡一致** | 全部放行（8/8） |
| `PRODUCER_RUBRICS.shot`（旧） | 肢体 / 表情 / 口型 / 跨镜一致 / 空间物理自洽 | 全部放行 |
| 管线确定性检查（旧） | 字段齐备、长度、台词速率、朝向互斥… | 全部通过 |
| **环境真实性（当时不存在）** | 空词 / 材质工艺 / 实用光源 / 使用痕迹 / 空间实指 | —— |

**关键缺口**：旧评审只问"画面跟镜头卡对不对得上"，而**镜头卡本身写的就是空词**——
「现代明亮的商务空间」+「柔光箱主光 + 白板补光」+「原木长桌」。
于是"符合镜头卡"与"像实拍"之间没有任何判据，平均样板间可以连过所有门。

实测（`environment-realism-audit.mts` 跑原卡）：**8/8 镜判红，硬缺陷 37 项**。

## 二、机制（三层，缺一不可）

```
        ┌─────────────────────────────────────────────────────────┐
        │ ① 提示词侧：让模型有约束可用（plate-prompt 通用约束）      │
        │    ENVIRONMENT_REALISM_CONSTRAINT / PROP_INTERACTION_…    │
        └─────────────────────────────────────────────────────────┘
                              ▲ 同源判据
   sceneBible ──展开──▶ 镜头卡字段（scene/sceneDescription/lighting/props）
                              │
        ┌─────────────────────┴───────────────────────────────────┐
        │ ② 渲染前：确定性审计（零 token，fail-closed）             │
        │    environmentDefects() → 硬缺陷即停，报告落盘            │
        └─────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┴───────────────────────────────────┐
        │ ③ 评审侧：监制 rubric 两个类目（视觉复核，兜漏网）        │
        │    keyframe/shot/master：环境真实性 + 道具-人体交互逻辑   │
        └─────────────────────────────────────────────────────────┘
```

**为什么必须三层**：提示词减少发生率、确定性审计在**花钱之前**拦住（单镜关键帧 ~85s、视频 ~160s，还要重后期）、
评审兜住"写对了但生成得不对"。三层判据同源，避免"提示词里写了、评审侧没有对应类目"的老问题。

## 三、字段规格（片级 `sceneBible`）

写在 `shotlist.json` 顶层（或用 `--scene-bible <file>` 单独维护）：

```jsonc
{
  "spaceId": "shanghai-jingan-1936-mill-hq",     // 片级空间标识
  "space": {
    "city": "上海", "district": "静安",
    "building": "1936 年日商纺织厂改建的 6 层办公楼（挑空中庭+开放工位+会议室+剪辑间+露台）",
    "areaM2": 1800, "ceilingM": 4.2,
    "orientation": "南向整面钢框水泥窗（原厂房窗框保留），西侧中庭挑空",
    "timeOfDay": "同一营业日 09:40 → 23:40（时段只许推进，不许回跳）"
  },
  "otherSpaces": [                               // 可选：门店/客户现场/街景等第二空间
    { "spaceId": "store-xuhui-front", "city": "上海", "district": "徐汇",
      "building": "距总部 1.2 公里的沿街品牌门店（打烊后前厅）",
      "orientation": "临街玻璃门内", "timeOfDay": "当日 23:10" }
  ],
  "materials": [                                 // ≥3 项；每项要 material + (finish 或 wear)
    { "item": "会议桌", "material": "胡桃木饰面长桌", "finish": "哑光打蜡", "wear": "中央咖啡杯痕、边缘 2cm 磕痕" }
  ],
  "practicalLights": [                           // ≥1 项带色温或方向；棚具语言不算
    { "type": "窗光", "kelvin": 5600, "direction": "南向钢框窗，午后斜射" },
    { "type": "天花筒灯", "count": 12, "lit": 6, "kelvin": 3000 }
  ],
  "traces": ["桌面咖啡杯痕", "档案夹卷边", "扶手指纹与细微氧化"],   // ≥1 项
  "colorDiscipline": "低饱和写实；肤色中性不偏黄；暗部保留材质纹理"
}
```

逐镜字段（可选，按镜覆盖）：

| 字段 | 作用 |
|---|---|
| `sceneId` | 指认本镜属于哪个空间；出现在 `otherSpaces` 之外的空间 → `space-continuity` 硬失败 |
| `envNarrative` | 本镜的环境叙事任务（"桌面档案与杯痕让人读出这里刚开完一场会"） |
| `propInteraction` | 可交互道具的物理关系（见下） |

```jsonc
"propInteraction": {
  "prop": "手机",
  "orientation": "手机斜立于桌面支架、屏幕朝向主播本人；观众只见机身背面与侧缘的冷光",
  "operatedBy": "左手（指尖伸向手机又停住）",
  "contact": "手机立在简易支架里，与台面夹角约 65°",
  "occlusion": "指尖停在屏幕上方未遮挡；屏幕内容不可辨"
}
```

## 四、审计规则表（`environmentDefects`）

| 规则 | 级别 | 判据 |
|---|---|---|
| `generic-wording` | 硬 | 出现空词（简约/现代/高级/大气/通透/温馨/氛围感/干净留白/宽敞明亮/商务空间/样板间…） |
| `material-depth` | 硬 | 材质与工艺项 <3（材质词表 + 工艺/状态词表） |
| `practical-light` | 硬 | `lighting` 无场景内实用光源（窗光/日光/筒灯/台灯/屏幕光/烛光…） |
| `practical-light`（色温） | 软 | 有实用光源但未标 K 值或"色温" |
| `usage-traces` | 硬 | 全文无使用痕迹词（指纹/水渍/卷边/划痕/薄灰/杯痕/旧钉眼…） |
| `space-specificity` | 硬 | 本镜 `scene`+`sceneDescription` 的实指 <3 项（年代/地段/尺度/朝向/时段/空间类型） |
| `space-continuity` | 硬 | `shot.sceneId` 不在圣经登记的空间里 |
| `prop-interaction` | 硬 | 含被手持/被操作器物却未声明物理关系；或声明的条目缺 `orientation`/`operatedBy` |
| `prop-screen-orientation` | 硬 | 屏幕类道具的 `orientation` 未声明"朝向使用者"（写"朝观众/正对镜头"即判红） |
| `optic-signature` | 软 | 缺等效焦段/光圈口径 |
| `scene-bible` | 软 | 圣经自身不完备（实指不足 / 材质缺工艺 / 无实用光源 / 痕迹为空） |

规则细节（避免误伤）：

- **桌面设备只在"在用"时要求声明**：合盖静置的笔记本不要求（"在用"只认设备语境词，见 BADCASE-2026-0927 的规则收紧记录）；
- **静置道具不强制**：杯子/笔/书/椅/门不要求声明物理关系（否则每镜判红、规则失去信号）；
- **屏幕朝向与"界面不可辨"是同一件事的两面**：写清朝向，界面不可辨才成立。

## 五、管线接线（`full-chain-film.mts`）

| 位置 | 行为 |
|---|---|
| 装载期（读 shotlist 之后、任何阶段之前） | 读 `sceneBible`（或 `--scene-bible`）→ `expandShotWithBible` 展开进每镜字段 → `environmentDefects` **与 `deviceDefects`（设备口径，见 `docs/device-standard.md`）合并审计** → 报告写 `<work-dir>/env-realism-report-<project>.json` → 落 `env-audit` 阶段记录 |
| 闸门 | 本轮要做 **spec / plates / material-gen / videos** 任一阶段时，环境 + 设备硬缺陷 **fail-closed**（`exit 7`）；纯后期复跑（compose/subtitle/mux…）不拦。带瑕疵放行：`--accept-rejected env` 或 `--accept-env-defects`（记为 `degraded` 留痕） |
| G7（花钱前最后一道门） | 判据清单增加 `env-realism` 检查（硬，含设备口径），证据带硬/软缺陷数、圣经 id、设备清单版本与报告路径 |
| 关键帧 / 视频提示词 | 展开后的字段 + `plate-prompt` 的通用约束一起进提示词（`ENVIRONMENT_REALISM_CONSTRAINT`，含道具时再加 `PROP_INTERACTION_CONSTRAINT`） |

> **设备口径（2026-09-27 产品所有者硬约束）**：场景里的电子设备**全部使用 2024 年之后的 Apple 设备**，
> 逐镜在 `devices[]` 声明机型（裸词不算），与本机制共用同一道渲染前闸门与同一份报告。
> 清单、判据、写法见 `docs/device-standard.md`。

## 六、与既有能力的关系

| 能力 | 关系 |
|---|---|
| `material-scene`（素材场景策略） | 圣经里的**真实参考图只作实景依据、不得复刻构图**（沿用 `material-scene/v1` 口径）；两者不冲突 |
| `cine-kb-bridge`（摄影知识库） | 知识库注入光学/光线/材质语言（`depth_of_field`/`props`）；环境审计校验**这些语言是否落到卡上**（如光学签名） |
| `continuity`（连贯性导演） | 审计管"空间事实是否声明且自洽"；连贯性导演管"跨镜读起来是不是同一支片子"，两者互补 |
| `producer-gate`（监制） | 审计是确定性前置，监制是视觉复核；`PRODUCER_RUBRICS` 已同步加"环境真实性"与"道具-人体交互逻辑" |

## 七、验收口径

1. **单测**：`pnpm -C packages/video-studio test`（`scene-bible.test.ts`：空词/材质/光源/痕迹/实指/道具朝向/空间连续性/多空间/展开；`plate-prompt.test.ts`：约束真的进提示词；`opening-hook.test.ts` 覆盖钩子侧）；
2. **CLI 取证**：`tsx scripts/tools/environment-realism-audit.mts --shots <卡>`（原始卡 = 改造前口径）
   与 `--expand`（管线真实口径）应给出**不同结论**——差别就是"圣经写了但卡里没带"；
3. **真机**：单镜 A/B —— 原版 vs 实指化重渲，关键帧与视频都过监制（证据见 BADCASE 文档）；
4. **端到端**：模板示例（18 镜销售讲解型）在 `--expand` 下硬缺陷与软提示均为 0。

实测数据（改造前后）：

| 对象 | 硬缺陷 | 软提示 |
|---|---|---|
| 原卡（8 镜，未展开） | 37 | 8 |
| 模板示例（18 镜，展开后） | 0 | 0 |

## 八、怎么继续扩展（不用改代码）

1. **加空词**：`GENERIC_SCENE_WORDS` 追加词条（评审与提示词侧自动生效）；
2. **加材质/痕迹词表**：`MATERIAL_WORDS` / `TRACE_WORDS` 追加；
3. **加可交互器物**：`HANDHELD_PROP_WORDS` 追加（同时补单测）；
4. **加空间**：`sceneBible.otherSpaces` 登记 + 镜头 `sceneId` 指认；
5. **加评审类目**：直接往 `PRODUCER_RUBRICS` 对应环节追加一条（评审层自动对所有镜头生效）。

## 九、边界（本方案不解决什么）

- 不解决"材质写对了但生成得不对"（那是重渲与视觉评审的事）；
- 不做姿态估计/像素级真实感评分（"手机屏幕朝观众"目前靠声明 + 视觉复核，不是自动检测）；
- 不做**跨镜光照方向一致性**的像素级校验（当前只校验声明与文本）；
- `otherSpaces` 只覆盖**空间实指**；材质/光源清单仍为片级共用，第二空间的差异材质写在那一镜的 `scene`/`props` 里。

---

**关联**：`BADCASE-2026-0927-env-average-room.md`、`BADCASE-2026-0927-phone-screen-toward-audience.md`、
`docs/scene-physics-review.md`（空间与物理自洽的上一轮机制化）、`docs/opening-hook.md`（前 3 秒钩子）。
