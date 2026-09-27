# 镜头内电子设备标准：全部使用 2024 年之后的 Apple 设备（2026-09-27）

> 产品所有者口径（原话）：**"凡是场景中出现的电子设备，例如笔记本电脑、台式机、手机、平板、显示器等，
> 全部使用 2024 年之后的苹果设备。这一条作为硬约束，写进系统底层。"**
>
> 本文是这条硬约束的**系统实现说明**：判据在哪、清单怎么维护、三层机制怎么兜、边界是什么。

## 一、为什么是"清单 + 声明 + 三处同源"，不是一句提示词

| 只写提示词 | 本方案（三层） |
|---|---|
| 降低发生率，但拦不住"模型顺手补一台杂牌笔记本/旧机型" | ① 镜头卡 `devices[]` 显式声明机型；② 渲染前确定性审计 fail-closed；③ 提示词侧约束 + 监制 rubric 同源 |
| 机型世代会变，提示词会过期 | 清单集中在 `device-policy.ts#DEVICE_ALLOWLIST`（带 `generation` 与 `source`），改一处即全链路生效 |
| 判不出来，只能靠人眼 | `deviceDefects()` 逐镜判红，报告落盘（可复核、可进 CI） |

## 二、允许清单（唯一事实源）

位置：`packages/video-studio/src/device-policy.ts`（`DEVICE_POLICY_VERSION = apple-2024plus/v1`）。
核对口径：**Apple 官网在售机型**，`DEVICE_POLICY_VERIFIED_AT` 记录核对日期；在售机型均晚于 2024 年世代。

| 类别 | 允许机型（示例） | 世代口径 |
|---|---|---|
| 笔记本 | MacBook Neo / MacBook Air / MacBook Pro | Mac 新笔电线 / M4 起 |
| 台式机 | Mac mini / Mac Studio | M4 起 / 2025 起在售世代 |
| 一体机 | iMac | M4 起 |
| 显示器 | Studio Display XDR | XDR 世代（在售新机型） |
| 手机 | iPhone 16 / 17 / 17e / Air / 18 Pro / Duo | A18 起（iPhone 16 为 2024 年世代） |
| 平板 | iPad Pro / iPad Air / iPad / iPad mini | M4 起 / 在售世代 |
| 配件 | Apple Watch / AirPods（含 Pro、Max）/ Magic Keyboard / Magic Mouse / Magic Trackpad / Apple Pencil | 在售世代 |

**在售但世代偏早**（软清单，不判红但给建议）：`Studio Display`（2022 世代）——
严格 2024+ 口径请用 `Studio Display XDR`。

扩展方式：在 `DEVICE_ALLOWLIST` 加一条（含 `generation` 与 `source`）即可，审计/提示词/监制自动跟随。
清单变更属于**产品口径变更**，应在任务卡里留痕。

## 三、判据（`deviceDefects`，确定性、零 token）

| 规则 | 级别 | 判据 |
|---|---|---|
| `device-declaration` | 硬 | 镜头文本里出现电子设备（笔记本/台式机/一体机/手机/平板/显示器/耳机/键鼠/手表/相机麦克风）但没有 `devices[]` 声明 |
| `device-model` | 硬 | 声明的机型不在允许清单（含只写裸词"笔记本电脑""平板"的情况） |
| `device-brand` | 硬 | 镜头文本里出现非 Apple 品牌（联想/戴尔/惠普/华为/小米/三星/索尼/LG/微软 Surface/罗技…） |
| `device-generation` | 软 | 命中"在售但世代偏早"清单（如 Studio Display 2022） |

> 判定纪律：**裸词不算机型**。"笔记本电脑/平板/显示器"这类词只用于**发现**设备，不能用于**声明**设备；
> 声明必须落到具体机型。纸本与设备的分辨：`笔记本` 只有在"电脑/屏幕/键盘/金属外壳/机身/盒盖"等设备语境下才算设备
> （真机实测：商务场景里"笔记本"有一半指纸质本）。

## 四、镜头卡写法

```jsonc
{
  "shotId": "GR-02",
  "sceneDescription": "桌上平放一台 iPad Pro（M4 世代），屏幕朝向主播本人",
  "props": "iPad Pro（M4 世代）、打印报表、咖啡杯",
  "devices": [
    { "category": "tablet", "model": "iPad Pro",
      "role": "展示报表（界面虚化不可辨）",
      "placement": "平放桌面、屏幕朝向主播本人，观众只见机身边缘与冷光反射" }
  ]
}
```

屏幕类设备仍需同时满足**道具-人体交互**口径（`propInteraction`：屏幕朝向使用者本人，观众只见机身背面或侧缘）。

## 五、三层机制与接线

| 层 | 落点 | 行为 |
|---|---|---|
| 声明 | 镜头卡 `devices[]` | 机型是唯一可声明项；裸词不通过 |
| 审计 | `deviceDefects()` → `full-chain-film` 装载期 / `environment-realism-audit.mts` | 生成类阶段硬缺陷 **fail-closed**（与环境审计合并为同一道闸、同一份报告） |
| 提示词 | `plate-prompt.ts#DEVICE_STANDARD_CONSTRAINT`（含设备的镜头追加） | 画面语言：机型按卡片呈现、无其他品牌标识、旧世代外观禁止；**不重复机型清单**（避免第二事实源） |
| 监制 | `producer-gate.ts#PRODUCER_RUBRICS` | `keyframe`/`shot`/`master` 增"设备口径"必判类目（含跨帧/跨镜一致性） |

## 六、验收口径

1. 单测：`pnpm -C packages/video-studio test`（`device-policy.test.ts` 8 例 + `plate-prompt.test.ts` 设备约束 1 例）；
2. CLI：`tsx scripts/tools/environment-realism-audit.mts --shots <卡> [--expand]`
   —— 改造前应报 `device-declaration` 硬红（模板 18 镜实测 8 镜命中），补齐 `devices[]` 后应为 0；
3. 端到端：模板示例（销售讲解型 18 镜）在 `--expand` 下环境 + 设备**双零**；
4. 真机：`keyframe`/`shot` 监制按"设备口径"类目给出可读结论（机型与卡片一致、无其他品牌标识）。

## 七、边界（本方案不解决什么）

- **不做像素级品牌识别**：判据是"写没写、写得对不对"（声明 + 文本），"生成出来像不像该机型"由监制视觉评审兜；
- **不做设备世代的时间校验**：清单按"Apple 官网在售"维护，`verifiedAt` 记录核对日期；清单过期需人工更新（属产品口径变更）；
- **非列举类设备**（硬盘盒、读卡器、线材、电子时钟，以及**Apple 没有对应品类的相机/云台**）：不进声明与品牌判据
  （否则规则不可满足），但适用提示词侧的"无其他品牌标识"约束与监制视觉复核；
- **已交付成片不追溯**：本约束对**新提交渲染**生效；已在库的成片（如 VID-GROWTH-SALES01 的 CF-02/CF-06 含泛指手机）如需合规，需重渲——费用与排期由产品所有者决定。

---

**关联**：`docs/environment-realism.md`（环境真实性机制，与本标准的闸门合并为同一道）、
`BADCASE-2026-0927-phone-screen-toward-audience.md`（道具朝向 badcase）。
