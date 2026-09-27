# 镜头设备：冻结故事日期、具体型号与显式品牌档案

本页对应 `device-policy.ts` 的 `workloom.device-era/v2`。目录记录已核实的**历史上市日期**，不声称某型号现在仍在售。文字合同通过也不代表生成画面的品牌或年代已经通过视觉检查。

原销售片的 Apple 要求保留为显式 `apple-2024plus` 档案。历史题材、产品片和其他品牌任务使用 `story-compatible`。调用方必须带入项目批准的档案；不得以系统今天的日期补齐缺失的故事日期。

## 合同与优先级

```json
{
  "eraProfile": { "storyDate": "2025-03-12", "devicePolicy": "apple-2024plus" },
  "shots": [{
    "shotId": "PHONE-01",
    "scene": "女人向观众演示手机报表",
    "action": "右手握持手机，向观众展示屏幕",
    "devices": [{ "category": "phone", "model": "iPhone 16", "placement": "右手握持", "role": "向观众展示报表" }],
    "propInteraction": {
      "prop": "手机", "purpose": "present", "orientation": "屏幕朝向观众",
      "screenFacing": "audience", "operatedBy": "女人", "contact": "右手包裹机身两侧"
    }
  }]
}
```

`EraProfile.storyDate` 必须是实际日历日期 `YYYY-MM-DD`，范围 1000–9999 年。`today`、无效闰日、缺日期、未知字段和未知策略均为 `unverified`。镜头的完整 `eraProfile` 优先于继承值，允许明确闪回；不同档案不按字段拼接。`devicePolicy` 缺省为 `story-compatible`。

| 策略 | 可核条件 | 不满足时 |
|---|---|---|
| `story-compatible` | 具体型号在冻结目录，类别正确，上市日期不晚于故事日期 | 未知型号/缺日期为 `unverified`；年代或类别矛盾为 `failed` |
| `apple-2024plus` | 上述条件，加 Apple 品牌、目录上市日期不早于 2024-01-01 | 品牌或世代冲突为 `failed`；2022 显示器无软清单豁免 |

`devices` 接受一个声明或声明数组，每项含 `category`、`model`，可选 `placement`、`role`。可选字段提供时须为非空文字。型号只接受完整规范名或已登记别名；`MacBook Pro`、`MacBook Pro 2012`、`iPhone 160` 不会因包含子串而通过。

发现的每个设备类别都必须有自己的有效声明；手机声明不能覆盖笔记本和显示器。无设备为 `not_applicable`。`无手机` 等已覆盖的否定不产生设备；纸质笔记本、品牌地名不自动产生设备。有限词法规则不是通用语言理解。

## 当前目录及官方证据

完整型号、别名、类别和来源在 `DEVICE_ALLOWLIST`，每条和别名数组均冻结。以下为本批使用的官方历史资料；首次可购买/交付日期与发布公告日期分别处理。

| 目录组 | 上市日期 | 官方来源 |
|---|---|---|
| MacBook Pro M4 / M4 Pro / M4 Max | 2024-11-08 | [Apple MacBook Pro 公告](https://www.apple.com/uk/newsroom/2024/10/new-macbook-pro-features-m4-family-of-chips-and-apple-intelligence/) |
| MacBook Air M4 | 2025-03-12 | [Apple MacBook Air 公告](https://www.apple.com/ca/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/) |
| iMac M4、USB-C Magic Keyboard / Mouse / Trackpad | 2024-11-08 | [Apple iMac 公告](https://www.apple.com/newsroom/2024/10/apple-introduces-new-imac-supercharged-by-m4-and-apple-intelligence/) |
| Mac mini M4 / M4 Pro | 2024-11-08 | [Apple Mac mini 公告](https://www.apple.com/uk/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/) |
| Mac Studio M4 Max / M3 Ultra | 2025-03-12 | [Apple Mac Studio 公告](https://www.apple.com/uk/newsroom/2025/03/apple-unveils-new-mac-studio-the-most-powerful-mac-ever/) |
| Studio Display 2022 | 2022-03-18 | [Apple Studio Display 公告](https://www.apple.com/au/newsroom/2022/03/apple-unveils-all-new-mac-studio-and-studio-display/) |
| iPhone 16 系列、Watch Series 10、AirPods 4 | 2024-09-20 | [Apple 首发记录](https://www.apple.com/newsroom/2024/09/the-iphone-16-lineup-airpods-4-apple-watch-series-10-arrive-around-the-world/) |
| iPad Pro M4、iPad Air M2、Apple Pencil Pro | 2024-05-15 | [Apple iPad 上市记录](https://www.apple.com/newsroom/2024/05/the-redesigned-ipad-air-and-new-ipad-pro-are-available-today/) |
| Samsung Galaxy S24 / S24+ / S24 Ultra | 2024-01-31 | [Samsung 上市记录](https://news.samsung.com/us/samsung-galaxy-s24-series-now-available-in-us/) |

扩展目录必须附官方历史证据、确切上市日期、型号及类别，并增加边界测试。未核实的新型号保持未验证，不用泛品牌或“在售”推断世代。不是目录成员不等于现实不存在，只表示当前版本没有证据。

## 实际消费与失败边界

- `deviceDefects(shots, { eraProfile })` 返回带 `rule`、`shotId`、`status`、`hard` 的缺陷；`devicePolicyStatus` 汇总四态。
- `devicePolicyPromptLines` 先核验，再把实际型号、摆放、用途和冻结日期写入提示词；有缺陷直接抛错。
- `buildPlatePrompt` 接受 `options.eraProfile` / `options.sceneBible`，不再强加 5600K、竖幅、浅景深、默认人物或禁第二人。
- `reviewStage({ contracts: { shots, eraProfile, sceneBible } })` 在外部调用前编译合同，实际请求含完整事实和 `contractHash`。评审期间源合同变化则未验证。
- `environment-realism-audit.mts` 接受 shotlist 顶层档案并生成逐镜报告。旧 full-chain 调用方的项目档案/监制合同接线由独立集成批完成；本批不声称所有旧入口已传入新字段。

现有销售模板迁移时应明确冻结批准的故事日期并写 `apple-2024plus`；裸型号换成带世代的规范名，展示屏幕增加 `purpose: present`。未迁移设备卡保持未验证，不能静默补“当前 Apple”。本模块不增加外部服务或数据库表，也不签发生产交付资格。

## 边界

相机、云台、线材等当前九类之外的器材不冒充已经过本目录核验，仍需其自身时代资料和视觉审查。旧输入/旧媒体不会自动被改写。真实机型外观、物理交互和跨帧连续性必须由实际媒体评审验证；本批测试使用真实本地函数和 CLI，外部模型为替身。
