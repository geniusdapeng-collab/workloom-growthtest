# 随仓精选 BGM 曲库（12 首 · 自算合成）

> 生成器：`scripts/bgm-library-build.mjs --curated`｜生成日期：2026-09-23｜总量：12 首 / 约 11.4MB
> 用途：**离线兜底曲库**——在线取源（Jamendo / Freesound / Mubert / 客户自建索引）不可用时，工位直接用这里的曲目配上成片。

## 一、为什么是"自算合成"而不是下载流行音乐

用户要的"海内外平台比较火的音乐"绝大多数是**受版权保护的商业曲目**：既不能随开源仓库分发，也不能直接用于客户商用交付。
所以本曲库走的是**本仓自研作曲引擎**（`bundles/ai-video/connectors/bgm-bridge/synth.mjs`）生成：

| 维度 | 口径 |
|---|---|
| 权利来源 | 本仓代码合成，**不含任何第三方样本、模型权重或曲目片段** |
| 许可 | `workloom-self-generated`（可商用于客户交付，无署名义务） |
| 可核验 | 每首附 sha256、实测响度、结构分段；同种子可逐字节复现 |
| 可分发 | 可随仓库/制品分发（这也是它能进云端的唯一合法方式） |

需要"平台热门曲"时走**在线取源**通道（许可白名单内的 CC0 / CC BY / CC BY-SA / 免版税曲目），
而不是把受版权保护的曲目塞进仓库——这条边界在技能 `bgm-library-license` 里写死。

## 二、12 首内容（风格 × 题材）

| 风格包 | 适配题材 | 说明 |
|---|---|---|
| modern-pop | 产品广告 | 鼓组 + 副旋律，现代流行感 |
| electronic-pulse | 节日促销 / 科技 | 四踩 + 泵感 + 琶音 |
| lo-fi-chill | 美食 / 美妆 | 软鼓 + 摇摆，松弛 |
| cinematic-build | 剧情 / 高端品牌 | 渐强 + 落锤，电影感推进 |
| ambient-calm | 房产 / 纪录 | 无鼓氛围铺底 |
| corporate-clean | 产品 / 科技 | 拨弦 + 铺底，商务干净 |
| acoustic-warm | 亲子 / 旅拍 | 拨弦 + 铃，原声温暖 |
| tension-dark | 悬疑 / 夜景 | 低频脉冲，暗色张力 |
| sports-hype | 汽车 / 促销 | 重鼓 + 主音，运动燃向 |
| festive-bright | 节日促销 | 铃 + 拨弦，明亮 |
| documentary-bed | 纪录片 / 口播 | 极简铺底 |
| city-night | 夜景 / 科技 | 低频 + 琶音，都市夜行 |

每首 **60 秒**、含 `intro → drop → breakdown → drop → outro` 段落结构（12/12 具备 drop），
所以配乐师的"自动选段（含高潮段对齐）"能直接在这些曲目上工作。

## 三、清单字段（`tracks.json`）

`id / title / artist / genre / mood / style / recipeId / bpm / durationSec / license / file / sha256 / bytes /
loudness{integratedLufs,truePeakDbtp,lra} / energyScore / dynamicsDb / structure{segments,hasDrop,climaxCandidate} /
generation{recipeId,style,seed,masteredWith} / instrumentation / mixHints{musicLevelDb,duckingDb,avoid} / tags`

实测口径（全部达标）：响度 -14 ±1.5 LUFS · 真峰值 ≤ -1.0 dBTP · 每首含 drop 段。

## 四、怎么用

```bash
# 工位联网时：在线优先（需配置 provider 凭据）
export JAMENDO_CLIENT_ID=...            # 或 FREESOUND_API_TOKEN / MUBERT_* / WORKLOOM_BGM_ONLINE_ENDPOINT
bgm-cli fetch --prompt "美食探店，温柔治愈" --policy online-first

# 只想用本地曲库
bgm-cli fetch --prompt "美食探店" --policy local-only

# 由提示词直接出配乐成片（内部自动：简报 → 取曲 → 选段 → 混音 → 复检）
bgm-cli best --in clip.mp4 --out scored.mp4 --prompt "美食探店，温柔治愈，保留现场声"
```

## 五、完整曲库（50–70 首）与重新生成

随仓分发的只是**精选子集（12 首）**；工位本地可生成完整曲库：

```bash
node scripts/bgm-library-build.mjs --full 60 --out ~/.workloom-bgm/library
```

工位加载顺序：`WORKLOOM_BGM_LIBRARY_DIR`（客户自建）→ 本目录（随仓精选）→ `~/.workloom-bgm/library`（工位本地 60 首）。
同 id 时前面的优先，客户可以覆盖仓库版本。

## 六、边界

- 不含任何第三方曲目/样本；不要往本目录里放来源不明的音频（会被许可闸拒收或让仓库承担版权风险）。
- 曲目是为"短视频配乐"调的音：60 秒、段落清晰、无强人声（避免与口播抢字）。
- 重新生成后 `tracks.json` 的 sha256 会变，需同步刷新 `bundle.json` 的完整性摘要（`pnpm bundle:governance --refresh-digests`）。
