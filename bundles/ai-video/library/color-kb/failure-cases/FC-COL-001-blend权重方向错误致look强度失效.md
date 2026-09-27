# FC-COL-001 blend 权重方向错误导致 look 强度失效

| 字段 | 内容 |
|---|---|
| 编号 | FC-COL-001 |
| 发现日期 | 2026-09-21（core.mjs 注释记载；随 729be0a 于 2026-09-24 入库） |
| 严重度 | 高 |
| 状态 | 已修复 |

## 症状

调用方指定 `intensity=0.5` 期望"半强度 look"，实际出片接近满档；调低 intensity 几乎不改变观感，强度参数形同虚设。

## 检测器

- 对比不同 intensity 出片的可见性度量：`colorwrite.grade` 分别以 intensity=0.5 / 1.0 出两版，再跑 `frameDifference`（core.mjs 内置，verdict 阈值 visible ≥4/255）——若两版画面差异 negligible，说明强度未生效。
- 审查滤镜链字符串：`blend=all_opacity=<intensity>` 若写作 `[__orig][__graded]blend=...`（原片在前），即为错误方向；正确形态是 `[__graded][__orig]blend=all_mode=normal:all_opacity=<intensity>`。

## 根因

ffmpeg `blend` 滤镜的 `all_opacity` 权重作用在**第一个输入**上（ffmpeg 语义，core.mjs:665 注释标明"已实测校准"）。早期实现把原片放第一个输入、opacity=intensity，于是权重压在了原片而非已调色画面上，look 恒接近满档——即 `bundles/ai-video/connectors/color-bridge/core.mjs:667` 注释所载"2026-09-21 的'强度参数失效'事故根因"。

## 处置

修正 `buildChain`（core.mjs:668）：把「已调色」放前面、opacity=intensity，生成 `split=2[__orig][__tograde];[__tograde]<lookChain>[__graded];[__graded][__orig]blend=all_mode=normal:all_opacity=<intensity>`，使"按 intensity 叠加 look"语义成立。

## 预防措施

- 在 core.mjs 注释中固化 ffmpeg blend 语义（权重作用于第一输入），改动 `buildChain` 必须重读该注释。
- 调色回执必须带 `visibility`（平均像素差），凡 look 请求却 negligible 直接 `verify_failed` 拒付（core.mjs:765-776），从交付侧兜住强度类失效。
- 新增强度相关代码路径时，补充 0.5 / 1.0 两档出片的差异断言测试。

## 关联

- 代码：`bundles/ai-video/connectors/color-bridge/core.mjs:665-668`（buildChain 强度混合段）
- 入库提交：`729be0a`（2026-09-24，事故注释随 color-bridge 一并入库）
- SKILL 引用：`color-grade/SKILL.md`「必须真的看得见」节（2026-09-21 事故复盘）
