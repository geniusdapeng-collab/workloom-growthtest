# T-2026-1031-9004 M6 独立验收报告

## 覆盖率声明

- 范围内文件总数：7；精读：7；机检/脚本解析：0；抽样：0；未读：0。
- 精读清单：`final-shot-character-qualification.ts`、其测试、`data-pipeline-finalize.mts`、其测试、`studio.test.ts`（cwd 修复段）、`data-mining-executor.test.ts`（cwd 修复段）、`docs/video-finalization-qualification.md`。
- 另有 3 个实际执行证据：M6 断言 run、真实 m3 finalizer 回读、真实 n21 finalizer 回读。未将 `pnpm-lock.yaml` 的机械变化冒充人工精读。

## 基线

- 审计基线：`e5111931d59fa662ab81163fe909a2c89f7543ef`
- 修复基线：`bb297c6a26e9aca1c6f5ec9396be21b78bc1e999`
- 验收基线：`41c2874cc9cba490e5071fb0b3dc0ad6d6ce3e43`
- 后代关系：`git merge-base --is-ancestor` 通过。

## 结果

| 卡 | 严重度 | 独立验收 | 结果 |
|---|---|---|---|
| MC-009 | P1 | finalizer 人物/定妆照资格 | verified |
| MC-010 | P1 | 包级标准测试 cwd 可复现 | verified |

### MC-009

- `data-pipeline-finalize.test.ts` 在独立 actor 下通过。
- 当前 finalizer 对真实 m3 返回 exit `4`、`blocked`，报告 `CHARACTER_ID_UNREGISTERED`、`PORTRAIT_BINDING_REQUIRED`、`PORTRAIT_REFERENCE_INVALID` 等。
- 当前 finalizer 对真实 n21 同样返回 exit `4`、`blocked`，正确拦截 `PENDING_GENERATION`、占位定妆照和空镜/人物冲突。
- 两个结果均保持 `providerSubmission=false`、`renderSubmitted=false`。

### MC-010

- `pnpm -C packages/video-studio test`：101 files / 1,812 tests 全部通过。
- `pnpm -C apps/server exec vitest run src/video --testTimeout 30000`：29 files / 884 tests 通过，另有 7 files / 87 tests skipped。
- `packages/video-studio` 与 `apps/server` 的 `tsc --noEmit` 再次通过。

## 证据分级

- **A**：上述 7 个文件完整精读；MC-009/010 的根因、修复与生产入口直接核对。
- **B**：M6 3 条断言 run、两份真实 finalizer 产物散列、包级测试和 TypeScript 命令实际结果。
- **C/D**：无。

## 边界

- 本轮是 MCD M6 独立验收；不是完整 RDAS v3.1 生产验收。
- 真实 m3/n21 被正确阻断，说明尚未得到“人物绑定完整、可进入 G8”的真实成功产物。
- 未提交任何图片、视频或付费生成请求。

## 收尾报告

- 已完成：原始 8 卡 11 条断言独立验收；新增 MC-009/MC-010 的修复后独立复验；真实 m3/n21 finalizer 回读；包级标准测试与类型检查。
- 未完成/未覆盖：完整 RDAS 276 项、生产 release gate、真实供应商提交和成片回执。
- 自主追加事项及理由：复跑真实 finalizer 并记录 issue codes，防止只用单测确认资格边界。
- 采用的假设：本轮环境档位为 `local-preview`；真实模型产物可做无付费的确定性 finalizer 回放。
- 置信度：高。
- 建议复核：`m6/ledger.json`、m6 的两个真实 finalizer qualification、`m6/report.md`。

## 自检表

- [是] 覆盖了本次 M6 全部范围，而非挑了容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论有实际 run、文件或命令依据，证据等级标注准确？
- [是] 经得起资深工程师逐行审查？

