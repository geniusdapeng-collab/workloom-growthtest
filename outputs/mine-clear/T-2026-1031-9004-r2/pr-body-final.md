## 目标

完成 GrowthTest AI 视频管线的二次独立验收修复，关闭自动审批越域、G11 预算失效、G10 未接线、回滚不完整和控制面门证据不足。

## 主要修复

- 自动审批绑定 `sourceBundleId=ai-video`、实际执行 tool 与显式视频门，组合工作区中的 GEO 发布、评论和投放不再被视频策略放行。
- G11 使用项目真实非 mock 算力用量，并统一标准渲染、白板和解说片三个提交入口；达到上限确定性停止。
- G10 接入生产处理入口；生成失败只保留 manual 草稿，并发重复派遣只允许一个处理器认领，manual 仍进入待处理面。
- `VIDEO_AUTO_APPROVAL=0` 时 explainer draft 必须通过新增的人工批准入口，不再由当前成员身份暗中批准。
- 控制面自动门校验阶段声明、facts snapshot、产物 role 与 schema；证据不完整时写 `unverified`。

## 验证

- `apps/server`：63 files / 1,169 passed，210 skipped。
- `packages/video-studio`：101 files / 1,812 passed。
- `packages/base`：80 files / 1,278 passed，125 skipped。
- server/base/video-studio TypeScript、bundle governance、capabilities、product content 全绿。
- MCD MC-011..MC-015 全部独立 acceptance verified，gate 通过；open P0/P1=0。
- 精确 PR head 的 GitHub `gate` 与 `ui-contract` 成功。
- G11 replay `used=999, cap=1` 实际命中 review。

## 边界

- 三端客户端 UI、U 域体验、真实付费供应商渲染与 P 域生产实测不在本轮放行范围。
- 控制面仍是影子模式，不接管真实出片。
