# 实体调色与清晰度处理

实体层用于最终创作 look 后的局部修正。人物仅使用人物实例或人脸证据支持的当前肤色区域，食物仅使用前景实例分类命中食物词表的当前区域；不复用上一帧位置，也不把整个画面的暖色区域当作食物。

## 原片只读与本地执行

```bash
node_modules/.bin/tsx scripts/tools/edit-entity.mts \
  --input /素材区/已完成look.mp4 \
  --out /产物区/实体处理.mp4 \
  --work-dir /产物区/实体工位 \
  --report /产物区/实体回执.json \
  --fps 30 --intensity 1
```

`--out` 必须是不存在的新文件。CLI 先以排他复制创建工作副本，对副本处理；源路径、已有输出、回执的源/成片软链与硬链别名被拒绝。回执以临时文件原子写入。每次运行在 `--work-dir` 内创建唯一子目录；Swift 工位按源码 SHA 编译缓存于该目录，不写用户主目录。`--fps` 支持 1..120，决定掩膜及执行帧率，应与后期时间线一致；`--intensity` 支持 0..1，0 明确保持原样。

工位在 macOS 使用 Apple Vision，`WL_VISION_ENTITY` 可指定已存在的工位执行文件。`WL_FFMPEG/WL_FFPROBE` 指定本地引擎。编译失败、平台不支持或工位不存在时，每段回执包含跳过原因，`applied=0`；不返回伪造的实体处理成功。发生单帧检测/掩膜读取失败时，该帧清零并留原因，不拿旧掩膜补齐。

## 当前帧支持与颜色处理

每个解码帧均在最高 640 像素宽的检测图上运行工位，再把同一时刻的真实实例支持缩放至完整画面；成片输出尺寸保持输入尺寸。掩膜是逐帧灰度序列，人物和食物在 RGB 合成中使用相同的三个颜色平面权重。人物最大不透明度 0.45，当前支持初次出现时每帧最多增加 0.08，消失立即清零；不会延续已消失目标的位置。

人物的肤色支持与食物支持相互排除。食物由前景实例裁图分类决定，且使用完整词匹配，`table/mealworm/bunting/面包车` 等相似词不充当食物证据。移除旧中心椭圆和整格矩形猜测区域；分类证据不足时保持原样。该工位不是专用食物语义分割模型，存在漏检和分类误判风险，回执明确说明这一限制。

已知源色域/传递函数/矩阵/范围先实际归一化到 709，再做局部修正，最后显式从 RGB 转换至 709 limited。PQ/HLG 进入线性浮点 tone map 后输出 709；未支持源标签或 HDR 缺少色域会失败，不能仅贴 709 标签。缺失 SDR 标签的假设列在 `colorManagement.assumptions`。

## 后期适配器与回执

`bundles/ai-video/connectors/color-bridge/entity-post.mjs` 导出：

```js
const receipt = await applyPostEntity({
  input, output, workDir, fps: 30, intensity: 1, bins, env: process.env,
});
```

适配器输出必须为新文件，调用本仓的 CLI，默认使用本仓 `node_modules/tsx/dist/cli.mjs`，可由 `WL_TSX_PATH` 指定受控入口。调用成功后读取指定回执文件，核验 schema、实际 applied/skipped 数量、源/输出 SHA、路径与媒体尺寸/时长，并核验应用时的逐帧掩膜文件大小和 SHA。CLI 先在唯一候选文件上执行与核验，再以排他复制发布新输出；两个调用竞争同一路径仅一个能发布，失败者不删除成功者的文件。CLI 执行或回执核验失败会清除自己创建的本次输出并抛出明确错误；工位/tsx 不可用则复制源文件并返回跳过原因。

回执 schema 为 `workloom.video-edit/entity-grade/v2`，包括：

- `sourceSha256/sha256/outputSha256`：实际输入与成片字节摘要；
- `applied/skipped/rows/summary`：实际作用数量与每段人像/食物状态，缺掩膜不能宣称启用；
- `generations[].filterComplex/maskMode/frames/colorManagement/masks`：实际参数、帧数、掩膜路径/规格/SHA；
- `sourceProbe/outputProbe/receiptPath/adapter`：回读规格、回执位置、只读核验与本地执行出处。

## 保守清晰度与处理损伤证据

`color-bridge` 的 `grade` 另提供 `clarity='off'|'conservative'`、`qualityGuard='off'|'report'|'block'`，独立调用默认均为 off。技术处理允许不设置 look/LUT/corrections；保守模式为 3×3 亮度锐化、增益 0.25、色度不锐化。report 返回同时间点归一化前后采样，逐帧保留亮度漂移、暗/亮部裁切增加、过饱和和细节代理，以及源/输出 SHA 和本地阈值出处。block 仅拒绝本次后期产物，不重新请求付费源镜。

采样代理不能证明整个文件没有伪影，不能恢复源片已丢失的细节，也不能认证肤色身份、食物语义或审美质量。交付前还需后期工序回执、当前成片的规格/解码/哈希核验与人工视觉复核。

实现依据：[FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html) 的 zscale、tonemap、maskedmerge、unsharp；[Apple foreground instance masking](https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest)。
