# 环境、主体与道具：按本镜事实生成与审查

环境真实性不是“每镜都要旧办公室”。本版把空间、可见对象、使用状态和道具用途变成明确合同；同一合同用于展开、关键帧提示词和可选的结构化监制输入。确定性文本审计只证明声明自洽，不能证明生成影像已经真实。

## 三个使用场景

1. 会议室切到街道：街道只读取自己的石板、天光和自然状态，不继承会议桌、台灯或咖啡杯痕；否则外景会被室内清单污染。
2. 全新产品或洁净室：按真实工艺、照明与洁净状态呈现，不为满足“痕迹”指标添加划痕；产品棚可以使用明确柔光箱。
3. 双人展示手机：两人留在构图内，屏幕向观众是明确展示用途；自己读取时则检查操作者能看清。固定“第二人禁止/屏幕朝内”会破坏这两个合法场景。

## 每个空间独立存储事实

```json
{
  "spaceId": "office",
  "space": { "city": "上海", "building": "旧银行改建会议室", "orientation": "东向窗", "timeOfDay": "上午" },
  "environmentProfile": { "setting": "interior", "condition": "used" },
  "eraProfile": { "storyDate": "2025-03-12", "devicePolicy": "apple-2024plus" },
  "materials": [{ "item": "会议桌", "material": "胡桃木", "finish": "哑光", "wear": "桌角杯痕" }],
  "practicalLights": [{ "type": "窗光", "direction": "东侧照入", "kelvin": 5600 }],
  "traces": ["桌角杯痕"],
  "otherSpaces": [{
    "spaceId": "street", "city": "苏州", "building": "平江路街道", "timeOfDay": "傍晚",
    "environmentProfile": { "setting": "exterior", "condition": "natural" },
    "materials": [{ "item": "路面", "material": "砂石", "finish": "接缝可见" }],
    "practicalLights": [{ "type": "阴天天光" }], "traces": [], "colorDiscipline": "保留天光原色"
  }]
}
```

镜头 `sceneId` 选择空间；未登记的 ID 报硬失败，不回落主空间。第二空间的材质、灯光、痕迹、颜色和环境档案**不继承**主空间。只有项目故事年代可继承，空间或镜头可用完整档案明确闪回。

`environmentProfile.setting` 为 `interior / exterior / studio / product`，`condition` 为 `used / new / maintained / sterile / natural`。模型不会把档案当“已通过”的证据。

`expandShotWithBible` 只在当前卡片追加可追溯贡献，不改动作、台词、时长或构图。空间描述写 `scene`，材质写 `props`，已声明的镜头光线与色调优先。`visibleMaterials` 可限制本镜可见物件；空数组表示不补材质。JSON 往返和重复展开幂等；更换空间或圣经时只去掉已证明的旧后缀。来源被篡改则 `unverified`，不会猜测删除作者内容。

输入圣经、面积、灯具数量/点亮数量、可见材料列表和重复空间均有形状校验。结构化原 `props` 不会被替换成拼接字符串；调用方须先明确字段合同。

## 道具用途合同

```json
{
  "propInteraction": {
    "prop": "手机", "purpose": "present", "orientation": "屏幕朝向观众",
    "screenFacing": "audience", "operatedBy": "女人右手", "contact": "右手握住机身两侧"
  }
}
```

| purpose | 可核朝向 | 使用要求 |
|---|---|---|
| `operate` | `operator` 或 `shared` | 读取/点击者可见屏幕，并有操作人和接触 |
| `present` | `audience` 或 `shared` | 观众可见展示面，不因朝镜头而判错 |
| `shared-view` | `shared` | 参与者共同可读 |
| `rest` | 按静置合同 | 不加操作人，仍需承重/接触关系 |

`orientation` 与 `screenFacing` 相互矛盾为 `failed`；用途、操作者或必要接触缺失为 `unverified`。可以给数组，实际操作的不同道具各自需要对应声明。明确的旧动作动词可推导用途，但不明确时不会假定朝内。静置器物不强制添加人。有限否定规则保留“无划痕的木桌”的木桌，不把“无磨损”当痕迹证据。

## 审计行为

| 范围 | 行为及失败状态 |
|---|---|
| 明确 `interior` | 当前文字需至少两个可见材质/工艺线索，缺失为硬 `unverified` |
| 明确 `product` | 至少一个材质/工艺线索，支持声明棚灯 |
| `exterior` / `studio` | 不要求凑室内家具数量；仍核对适用光源 |
| `used` | 缺明确可见使用状态为硬 `unverified`；其他 condition 不强制磨损 |
| 缺清晰范围或仅抽象风格 | 软 `unverified`，不替作者选择浅景深 |
| 缺场景、未知空间、交互冲突 | 硬缺陷；明确矛盾 `failed`，缺事实 `unverified` |
| 设备 | 按独立年代目录和明确 profile 判定，详见 device-standard.md |

环境档案未提供时保持兼容的有限审查，不宣称档案要求已被完整证明。规则并非完备自然语言解析；像素真实性和长时连续性仍需媒体证据。

关键帧实际输出横/竖/方画幅，不强制默认人物、肤质、第二人禁令、5600K 或浅景深。桥梁按本镜可见结构核对承重与连接，特写不强迫两个桥头入画。未知主体、非法画幅、时代/道具合同缺陷在生成前报错。

## CLI 与监制接口

仓内脚本调用方式：

```sh
pnpm exec tsx scripts/tools/environment-realism-audit.mts --shots ./shotlist.json --expand --json --report ./report.json
```

可用参数只有 `--shots`、`--scene-bible`、`--report`、`--expand`、`--json`、`--accept-soft`。外部圣经优先于嵌入值；顶层 `eraProfile` 继承到未覆盖的镜头。每镜含原卡/展开卡 hash、状态和缺陷，报告含 `evidence: deterministic-text-only`。

- 退出 0 表示没有硬缺陷；有软缺证时 `status: unverified`、`qualified: false`，不等于交付资格。
- 退出 1 表示硬缺陷阻断。`failed` 是明确冲突，`unverified` 是缺事实或来源不可核。
- 退出 2 表示参数、JSON、形状或文件错误；报告不可覆盖输入或指向输入的符号链接。
- `--accept-soft` 只减少文字提示，不修改证据状态或授予正式通过。

`reviewStage` 可传 `contracts: { shots, eraProfile?, sceneBible? }`。`buildProducerReviewContract` 先按共享规则编译事实，将完整合同与 hash 送审；超预算拒绝而不截断，审中源数据改变则不能通过。旧无合同调用方明确缺少结构化事实，不凭默认 rubric 宣称年代或人数已经核实。监制仍执行现有文件 hash、实际图像/时序抽帧、分批全部通过、必要音频证据等边界。

本批新增接口已在真实函数和实际 CLI 回归验证；项目 full-chain 的完整合同传参与新生产证据资格由后续独立集成批接入，不在本文提前声明已部署或已实片通过。

## 方案选择与边界

候选一是继续增加全局例外词，成本低但三处规则会漂移，而且镜头无法解释为什么例外。候选二是复用单一 ShotIntent，加显式空间/年代/交互合同；迁移旧卡成本较高，但提示词、文本检查和监制能核对同一事实。本版采用第二种，不新增依赖、数据库或外部 API。

P0 是空间隔离、原始主体与画幅保真、时代型号、道具用途和失败关闭；不用会持续生成矛盾画面。P1 是逐镜可追溯展开与监制 hash，避免旧增强或变化合同被当新证据。P2 的更多历史设备和材料语言须带官方来源或样例再扩展，当前未知项保持未验证。人物资产缓存、知识正文升级、真实视觉盲评和完整服务交付资格不由本模块冒充完成。
