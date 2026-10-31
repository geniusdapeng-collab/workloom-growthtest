# T-2026-1031-9004 独立验收发现

验收基线：`783c929b47ecd8d7ff79c4a77cd286b040bd95c1`

结论：**不通过**。8 张既有卡的 11 条声明断言已独立通过，但标准包级测试和真实模型产物复核发现以下未闭环问题。

## A-001 P1：finalizer 把未绑定定妆照/未授权人物误判为可进入 G8

复跑命令：

```bash
node_modules/.bin/tsx scripts/tools/data-pipeline-finalize.mts \
  --result outputs/ai-video-stress/T-2026-1031-9004/canary-m3/result.json \
  --out outputs/mine-clear/T-2026-1031-9004/acceptance-finalize-m3 \
  --no-dialogue --aspect 9:16 --resolution 1080x1920 --fps 30
```

实际结果：命令退出 `0`，`qualification=eligible_pending_G8`、`finalShotContract.pass=true`、PipelineGuard `0/0`。

同一输入的未闭环事实：

- `canary-m3/result.json.success=false`，G5 `portraitStudio.status=skipped`；
- `portraitResolver` 为 `studioCount=0`、`uploadedCount=0`、`textCount=1`；
- PRD 角色为 `char_001 / 女孩`，production 却使用 `小满: PENDING_GENERATION`；
- 6 个镜头的 `fields.portraits` 均为占位值 `/characters/character/portrait_v1.png`，`portraitPath` 为空；
- prompt 中混有 `image://characters/xiaoman/portrait_01.png`、`image://characters/xiaoman/home_night.png` 和“角色定妆照参考图”，均不存在于 `bundles/ai-video/library/characters/registry.json`；
- `canary-n21` 同样为 `success=false`、`portraitResolver.studioCount=0`，production 镜头仍是 `陈卓: PENDING_GENERATION` 与占位 portrait，尽管 PRD 已有 `chen-zhuo` 的真实图片和授权证据。

根因：`packages/video-studio/src/final-shot-contract.ts` 只检查 prompt、台词、时长和降级标记，不检查人物身份、真实定妆照、字节摘要、授权、PRD 与镜头字段一致性；`scripts/tools/data-pipeline-finalize.mts` 也未把源结果中的 G5/portrait blocker 纳入 `status`。

证据等级：A（代码精读）＋B（两条真实模型产物和当前 finalizer 实际运行回读）。

## A-002 P1：包级标准测试存在 cwd 相对路径回归

复跑命令：

```bash
pnpm -C packages/video-studio test
pnpm -C apps/server exec vitest run src/video --testTimeout 30000
```

实际结果：

- video-studio：`1 failed | 99 passed` 测试文件，`1 failed | 1806 passed` 用例；失败在 `packages/video-studio/src/studio.test.ts:94`，包 cwd 下 `existsSync(anchored.portraitRef)` 对仓内相对路径返回 false。
- server：`1 failed | 28 passed | 7 skipped` 测试文件，`868 passed | 87 skipped` 用例；失败在 `apps/server/src/video/data-mining-executor.test.ts:15`，包 cwd 下 `resolve("vendor/...")` 被解析为 `apps/server/vendor/...`。

根级 `pnpm test` 执行 `pnpm -r --if-present test`，因此上述失败会进入标准递归测试/CI。

证据等级：A（失败栈和测试源码逐行定位）＋B（标准包命令实跑）。

## 已验证通过

- 既有 8 张卡、11 条断言在独立 actor `codex-acceptance-v2-01a19273` 下全部通过。
- `apps/server` 与 `packages/video-studio` TypeScript typecheck 通过。
- MCD delivery 回归 `140/140` 通过。
- n21/m3 的当前 finalizer 确实能把 prompt 长度、台词和 PipelineGuard 文本问题收口；失败点是角色/定妆照资格未被纳入判定。
