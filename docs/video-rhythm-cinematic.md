# 快剪节奏与摄影执行合同

本规范给总导演、视觉语言师、提示词工程师和后期岗位使用。目标是让镜头长度、摄影关系和声音落点进入实际制作，减少「电影感」标签、固定每镜时长或给每刀铺音效造成的重复作品。

## 三个使用场景

| 作业 | 应做的具体决定 | 缺少会怎样 |
|---|---|---|
| 旅游片：场所细节、空间展开、停下来听环境 | 细节用短段，空间展开留可读时间，呼吸镜保留完整环境与动作 | 所有镜头都短会看不清地点；所有镜头都长会失去强调 |
| 商品片：打开包装、操作、结果 | 用源片时间戳保护完整操作和一句台词，只在可裁余量内快切；声音对应扣合/触碰等动作 | 裁掉操作结果或半句话，观众无法理解承诺 |
| 电影叙事：人物进入门口，再切室内 | 声明主角比例、前中后景、场景内光源、运镜原因、道具状态、屏幕方向和进入/离开状态 | 只写大片、浅景深或宽银幕，模型不能得到可执行的镜头关系 |

## 制作边界与优先级

| 优先级 | 行为 |
|---|---|
| P0 | 保留用户事实、人物/商品锚点与已成功原片；生成请求秒数与成片剪辑范围分别记录 |
| P0 | 明确快剪使用 `rhythmPlan`；明确电影/大片请求使用 `productionStyle: cinematic` 与逐镜 `cinematic` 合同 |
| P0 | 裁镜前用真实源片时长和时间戳保护整句台词、完整动作；画声相同范围、原速 1x |
| P1 | 指定动作音的类型、落点和原因；用当前合成切点定位声音和字幕；不由音乐 BPM 标签假造拍点 |
| P1 | 电影合同进入文生视频、关键帧和素材图生视频的真实提示词；连续性发生变化时说明剧情原因 |
| P2 | 需要拍点、小节、音乐进入/退出或新增环境声时，另附实际音乐/环境声素材及处理回执；没有证据保持未核实 |

本规范不自动重渲成功素材，不改变台词或商品，不代替实际观影和听检，不保证模型产物达到某部商业电影的品质。它没有新增付费供应商调用。普通完整原片标准后期继续按全片、全镜、原顺序运行；只有明确的快剪制作合同进入新剪辑分支。

## 节奏字段和真实执行

`shotlist.json` 顶层 `rhythmPlan` 的 `segments` 必须覆盖选定镜头的全部 ID，并按已声明的镜头顺序排列。每段使用源片 `inSeconds/outSeconds`；`durationSeconds` 若提供，必须等于两者之差。`role` 是 `fast/hold/breath/story`；明确快剪还需要每段 `cutReason`。供应商生成时长由现有能力/正式执行器约束，短剪辑段不是向供应商请求半秒视频。

下面只展示附加的编辑字段，不能当作绕过正式前期资格的完整生产镜头卡：

```json
{
  "editingProfile": "fast-cut",
  "rhythmPlan": {
    "profile": "fast-cut",
    "segments": [
      {"id": "detail", "sourceId": "S1", "inSeconds": 1, "outSeconds": 1.5, "role": "fast", "cutReason": "扣合动作已完成，在释放瞬间切走"},
      {"id": "reveal", "sourceId": "S2", "inSeconds": 0, "outSeconds": 2, "role": "hold", "cutReason": "给观众看清空间关系"},
      {"id": "breath", "sourceId": "S3", "inSeconds": 0, "outSeconds": 3, "role": "breath", "cutReason": "动作落定后保留真实环境声", "protectedRanges": [{"inSeconds": 0, "outSeconds": 3, "kind": "action", "reason": "开门到完全停止的完整动作"}]}
    ],
    "soundCues": [
      {"atSeconds": 0.5, "kind": "impact", "gainDb": -24, "reason": "扣合对应的轻冲击"},
      {"atSeconds": 2.5, "kind": "ambience", "reason": "保留源片环境声，不新增转场特效"}
    ]
  }
}
```

本例有效成片是 5.5 秒，切点是 0.5/2.5 秒；原始供应商素材可以各有 4 秒或更长。`scripts/tools/rhythm-edit.mts` 读取原片摘要、实际视频帧率/帧数与展示画幅，用 `trim/atrim` 取相同范围并只重置时间戳，不调用变速、TTS 或 ASR。每段验证时长、原生画幅、全解码与原片摘要；失败清理当次目录，成功回执只签当前文件。

快剪合同要求至少一段 `fast <=1.2s`、一段 `hold/breath >=1.5s` 和明确 `breath`。这些是本项目透明的编辑启发式，不是行业通用审美阈值；慢节奏/自然叙事不因此被判为失败。自然叙事等长镜头仅获得建议。

有台词的源片要裁短时，必须提供该源片完整 spoken interval 的 `protectedRanges`，类型为 `speech`；执行器只检查时间戳是否完整保留，不声称已做 ASR 或台词听检。`lockTrim: true` 锁定整片，禁止缩短。越界、漏镜、重复 ID、未知源、裁掉保护段、实测时长与计划不符均报错。

显式 `impact/whoosh` 会自动进入现有 SFX 阶段，按给定成片落点合成、混音；增益范围是 -60 到 0 dB，未给时采用克制的 -18 dB。逐包 SHA-256 比对验证视频压缩数据保持相同，原节目声音仍是 1x。`ambience/silence/music-entry/music-exit` 在这一合成器中仅保留编辑意图并列入 `unverifiedCues`，需要对应素材与音乐/环境声工位处理证据，不能冒充已执行。

`beatEvidence` 可提供 `status/sourceSha256/method/beatTimesSeconds/confidence`，且时间戳必须严格递增；有 `beatIndex` 的切点会与其比对。纯校验返回 `beatAlignment=declared`，因为它没有解码该音乐。BPM 标签、按零秒起点推算的等间距网格、音乐起音与真实强拍/小节不能混为一谈。没有实际分析回执，不得宣称音乐卡点已测。

## 摄影合同字段

片级显式请求 `productionStyle/filmStyle/editingProfile` 的电影/大片类别，或 `requireCinematicContract: true`，对本次需要新生成的镜头要求下列字段。已成功原片可继续复用，旧合同不足仅记建议，不因此付费重做。

```json
{
  "shotId": "S2",
  "cinematic": {
    "purpose": "打开门后交代人物要进入的真实空间",
    "framing": "人物在右下三分位，门框占前景，房间纵深占画面左侧",
    "depth": "手和门框清楚，桌面可读，远处窗景自然变软",
    "lighting": "左侧窗光是主光，走廊顶灯仅在门框背侧形成暖色轮廓",
    "action": "手松开门把，门完全停止，人物一步进入房间",
    "camera": "先保持门框稳定，门停后轻跟人物进入，让观众先认清空间",
    "artDirection": "黄铜门把的磨痕与木桌边缘的使用痕迹一致，保留既有商品和空间材料",
    "sound": "门把回弹、铰链轻响和房内空气声；无背景音乐",
    "continuity": {"axis": "门与桌子的连线", "screenDirection": "人物从右向左进入", "entryState": "门已打开，人物在门外", "exitState": "门停止，人物进入房间"}
  }
}
```

`purpose/framing/depth/lighting/action/camera/artDirection/sound` 都需要具体决定。`continuity` 需要轴线、屏幕方向、进入和离开状态；不适用时明确写出原因。需要匹配前镜时添加 `matchPreviousShotId`，必须指向已出现的镜头；状态、轴线或方向变化时提供 `transitionReason`。

合同可恢复现有 `director_instruction/composition/depth_of_field/lighting/action/camera_movement/scene/props/costume/color_palette/audio` 的已声明信息，不臆造镜头焦距、光源或人物。合同补入提示词时跳过已完整存在的同一段信息，保持已有字数闸；不靠截断字段过关。关键帧只消费空间/光/动作状态，不混入运镜或声音指令。素材图生视频与文生视频同时消费完整合同。生成侧的声音仍遵守镜头内禁配乐纪律；冲突写入 `CINEMATIC_SOUND_BGM_CONFLICT`，配乐留在后期。

## 回执、错误和复核

| 回执/错误 | 说明 |
|---|---|
| `cinematic-contract-*.json` | 已声明的摄影合同及连续性问题；`pictureQuality/soundQuality` 仍为未实测 |
| `rhythm-plan-*.json` | 计划摘要、切点、切镜理由及建议；计划不等于已落地 |
| `rhythm-receipt.json` | 真实原片/剪辑片摘要、实测时长/帧数、原速 1x、保护段审计 |
| `sound-receipt.json` | 实际声音落点/增益、源与结果摘要、视频包不变验证、未执行声音意图 |
| `RHYTHM_FASTCUT_PLAN_REQUIRED` | 要求了快剪却没有具体源片范围；回正式前期补编辑计划 |
| `RHYTHM_SPEECH_PROTECTION_REQUIRED` | 有台词但缺整句时间戳；保留全片或补真实台词边界，不硬剪 |
| `RHYTHM_SOURCE_CONTRACT_FAILED` | 源片越界、保护段或整片锁冲突；先修计划 |
| `RHYTHM_COMPOSE_BINDING_OR_CLOCK_FAILED` | 当前合成结果未绑定剪辑片，或实际帧/时钟/画幅变化；停止交付 |
| `CINEMATIC_CONTRACT_FAILED` | 明确电影请求缺具体摄影/美术/声音或连续性决定；新渲染前补齐 |

最终交付仍须经过正式后期的导出与交付 QC，不能把本规范的结构校验当作审美绿灯。复核最值得看的三处是：短切是否保留了完整动作/台词，呼吸镜是否仍可读可听，镜头提示词是否真正含有具体摄影合同而不是标签。
