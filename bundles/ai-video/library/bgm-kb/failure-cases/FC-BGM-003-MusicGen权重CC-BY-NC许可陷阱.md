# FC-BGM-003 MusicGen 权重 CC-BY-NC——"AI 生成的"不等于"可商用"

| 字段 | 内容 |
|---|---|
| 编号 | FC-BGM-003 |
| 发现日期 | 历史遗留（bgm-library-license/SKILL.md 第四节记载；2026-09-22 核验口径见同文件第六节） |
| 严重度 | 高 |
| 状态 | 已修复（制度层防线落地：默认自算合成 + 许可白名单 fail-closed） |

## 症状

用外部 AI 音乐模型（如 Meta MusicGen / AudioCraft）生成配乐并直接进商用交付。模型代码仓库标 MIT 许可，给人"可自由商用"的错觉；实际**模型权重许可是 CC-BY-NC 4.0（禁止商用）**，生成物用于客户交付即构成违规。三层许可——代码、权重、输出物——被混为一谈。

## 检测器

- 许可三层核查表（bgm-library-license/SKILL.md 第四节）：代码许可 / 模型权重许可 / 能否直接商用交付，逐项核对，缺一不可。
- 白名单硬闸（围栏 G-BGM5）：`cc-by-nc-4.0` / `cc-by-nd-4.0` / `cc-by-nc-nd-4.0` 商用一票否决；未标注/来源不明 fail-closed 按不合规处理。
- 取曲纪律：下载前先判许可（`license_ccurl` / Freesound `license` / Mubert 免版税声明），不可商用一律拒收，绝不"先下后审"。
- 检索侧：商用交付只检索 `commercialOk=true` 的曲目，NC/ND 在检索阶段就被过滤。

## 根因

- 认知陷阱："AI 生成的"被推定为"没有版权风险"——实际**权重许可与产出物许可不是一回事**（bgm-library-license/SKILL.md:38-39、96-104）。MusicGen 代码 MIT，权重 CC-BY-NC 4.0，商用需另行取得授权。
- 三层混同：代码许可（仓库 LICENSE）≠ 模型权重许可（权重发布条款）≠ 输出物可用性（平台条款/训练数据来源）。只看第一层就放行是事故源头。

## 处置

- 本仓默认路径改为**自算合成 + 已声明可商用曲包**（`workloom-self-generated` / `royalty-free` 白名单），不依赖外部生成模型。
- 许可白名单制度化（SKILL.md 第二节）：cc0-1.0 / cc-by-4.0 / cc-by-sa-4.0 / royalty-free / workloom-self-generated 可商用；NC/ND 系与未标注一律拒收。
- 商业 API 路线（如 Mubert）须登记合同/订单号作为授权证据；第三方端点（如 Tunetank MCP）未验证前不得接入。

## 预防措施

- 每次交付必须能回答：这首曲子的许可文件/订单号在哪、署名有没有随片交付、谁在什么时候核验的（SKILL.md 第七节"留证"）——落点为 `bgm_report.license` + TASL 署名文件 + G-BGM1 审批记录 + 五元事件。
- CC BY / CC BY-SA 系必须随片产出 TASL 署名文件（`attribution_out=CREDITS.md`），署名文件属交付物一部分。
- 新曲库首次入片走 G-BGM1 人审；平台凭据只进受控秘密存储，不进文件/日志/事件。

## 关联

- SKILL 引用：`bgm-library-license/SKILL.md` 第二节（许可白名单）、第四节（AI 生成音乐的许可陷阱对照表）、第六节（Jamendo/ccMixter/Mubert/Tunetank 核验口径）、第八节（失败模式表）
- 代码/围栏：G-BGM5（白名单硬闸）、G-BGM1（新曲库人审）、G-BGM7（爬取/绕鉴权一票否决）
- 提交：制度层防线随 `5288456`（配乐去自算作曲转向曲库白名单口径）持续维护
