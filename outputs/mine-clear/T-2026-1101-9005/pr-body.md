## 目标

继续完成 GrowthTest AI 视频真实案例压测，修复营销事实、叙事合同、人物/旁白边界和交付验收入口的问题，并以 Codex/CLI 路径完成独立排雷验收。

## 主要改动

- 营销事实：价格金额、币种、来源与抓取时点绑定同一证据窗口；支持安全的 HTML meta refresh 跳转；进一步收紧来源正文和资产 URL。
- 生产评审：首次请求结构化 JSON；只修复 JSON 语法，不重写模型语义；非法结构失败关闭。
- 叙事合同：修复场景时长守恒、空镜/动物/职业主体、人物定妆照、最终提示词 26 栏和 creative gate 资产元数据泄漏。
- 语音语义：区分无对白、禁旁白、允许唯一旁白；“不加字幕”不再误删明确保留的画外旁白。
- 排除语义：“无动物”不再等于“无角色”，人物片继续绑定角色与镜头主体。
- 无台词终检：标准“不适用：无台词、无旁白、无口播”声明不再被误判为残留台词。
- 验收入口：补齐 `acceptance:profile:check` 根脚本，并让 MCD handoff 输出带 `verify-deps-before-run=false` 的可执行命令。

## 验证

- MCD MC-001 至 MC-012：12 张卡、20 条 assertion 独立验收全部通过；gate `ok=true`；三基线 12/12 current。
- AI 视频 60 场景：60/60；营销 20/20、叙事 20/20、异常 20/20；供应商提交 0。
- `packages/video-studio`：101 files / 1,834 tests passed。
- `apps/server/src/video`：31 files / 903 tests passed；87 skipped。
- TypeScript：11 个 workspace 项目全部通过。
- Governance：488/488；MCD 专项 15/15。
- `acceptance:profile:check`：configuration valid，business unverified。
- Secret scan：148 个 diff 文件通过。

## 边界

- 真实 14-case 仍存在 G5/G6、营销来源抓取和模型阶段失败，未声明全链路全绿。
- 客户端 UI、U 域、P 域生产实测不在本轮 Codex/CLI 放行面内。
- 未提交视频供应商渲染，未生成付费视频。
- 隔离副本 `none-in-none-out` 不变，不向基座或其他仓回流实验语义。
