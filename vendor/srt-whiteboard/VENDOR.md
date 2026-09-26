# vendor/srt-whiteboard · 接入说明

上游 [geeklee/srt-whiteboard-animation](https://github.com/geeklee/srt-whiteboard-animation)（MIT）
的仓内 vendored 形态：**字幕驱动的确定性手绘白板渲染器**。

- 引脚与补丁清单：[`PINNED.md`](./PINNED.md)
- 引擎能力与局限（源码级结论）：[`../../../docs/whiteboard-engine.md`](../../../docs/whiteboard-engine.md)
- 运行时依赖闭包：[`requirements.txt`](./requirements.txt)

## 怎么用（本仓口径）

```bash
# ① 建隔离环境（幂等；末行输出 ENV_PY=<解释器>）
pnpm exec tsx scripts/tools/whiteboard-env-install.mts

# ② 全链路出片（口播稿 → 配音 → SRT → 分幕 → 线稿 → 标注 → 渲染 → 混流 → 入库）
pnpm exec tsx --env-file=.env scripts/tools/whiteboard-film.mts \
  --script <口播稿.md> --project WB-001 --workspace <workspaceId>
```

环境变量（`.env.example` 有完整注释）：`WHITEBOARD_ENABLED` / `WHITEBOARD_ENGINE_DIR` /
`WHITEBOARD_JOBS_DIR` / `WHITEBOARD_LINEART` / `WHITEBOARD_FPS` / `WHITEBOARD_CAP_LONG_EDGE`。

## 纪律

1. **不改上游行为**：本目录只允许出现 `PINNED.md` 记录过的补丁；新增能力一律放在
   `apps/server/src/video/whiteboard/**` 与 `scripts/whiteboard/**`（本仓代码）。
2. **venv 不入库**：`vendor/srt-whiteboard/.venv/` 由 `.gitignore` 排除，随机器重建。
3. **离线可跑**：渲染全程本地确定性执行，零模型成本、零 API 依赖（线稿阶段除外）。
4. **秘密不进文件**：本目录（含 `examples/`）不得出现任何密钥、令牌或客户数据。
