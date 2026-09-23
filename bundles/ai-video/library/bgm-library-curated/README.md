# 随仓兜底曲库（50 首 · 可商用纯音乐选段）

> 本目录由 `scripts/bgm-curate-library.mjs` 从产品所有者提供的可商用曲库包中**按实测证据**精选生成，
> 不是手工挑曲、也不是自算合成。每次重生成都会刷新 `tracks.json` 与 `curation-report.json`。

## 这批曲目是什么

- **用途**：兜底。客户没有自建曲库（`WORKLOOM_BGM_LIBRARY_DIR`）、在线曲源也不可用时，配乐链路用这批曲目不断档；
- **形态**：每首 `60s` 选段（优先取曲子能量最饱满的 drop 段中心），线性增益到 **-14 LUFS / -1 dBTP**，
  AAC 112k 44.1kHz 立体声——与配乐工位的母版口径一致，混音前不必再猜增益；
- **检索**：`tracks.json` 是运行时契约（风格族/题材/情绪/BPM 档/能量档/配器/使用场景/结构/响度/许可），
  工位用 `bgmread.library` 检索、`bgmwrite.best` 择优；
- **许可**：产品所有者提供的可商用纯音乐包（1200可商用纯音乐）：所有者声明可直接商用；包内未见逐首上游许可文件，按所有者声明登记为 royalty-free
  
- **来源**：`owner-provided-pack:~/Downloads/1200可商用纯音乐`

## 风格分布

| 风格族 | 含义 | 曲目数 |
|---|---|---|
| `electronic-pulse` | 电子脉冲（合成器+律动） | 5 |
| `lo-fi-chill` | Lo-Fi 松弛（暖底噪+轻鼓） | 5 |
| `cinematic-build` | 电影推进（情绪爬升+编制加厚） | 5 |
| `tension-dark` | 张力暗色（低音压迫+悬念） | 5 |
| `modern-pop` | 现代流行（鼓组+副旋律） | 5 |
| `festive-bright` | 节日明亮（欢快上扬） | 5 |
| `acoustic-warm` | 原声温暖（木吉他/钢琴） | 4 |
| `ambient-calm` | 氛围静谧（长音铺底） | 4 |
| `documentary-bed` | 纪实铺底（不抢话） | 4 |
| `corporate-clean` | 企业干净（明亮克制） | 4 |
| `sports-hype` | 运动燃点（强节奏+冲击） | 4 |

## 选曲口径（可复核）

1. 打标阶段对**原始素材**逐首实测：响度（EBU R128）、真峰值、astats 平坦因子（削波证据）、
   结构分段（intro/drop/breakdown/outro）、起音密度、频谱重心、静音占比、循环友好度；
2. 精选分数 = 响度贴近 -14 LUFS + 峰值/削波 + 结构完整度 + 动态区间 + 拍速置信度 + 频谱 + 循环友好 + 风格置信度 + 时长；
3. 风格族之间**轮转取曲**（每族先保 1 首、单族上限 7 首），保证"不同风格"真的落到库里；
4. 每首为什么入选、取了哪一段、增益多少，全部写在 `curation-report.json` 里。

## 复核与再生成

```bash
# 重新打标（素材包更新后）
bgm-cli tag --in <素材目录> --out ~/.workloom-bgm/library --license royalty-free --license-note "..."
# 重新精选进仓
node scripts/bgm-curate-library.mjs --index ~/.workloom-bgm/library --out bundles/ai-video/library/bgm-library-curated --count 50
```

**待产品所有者确认的一点**：素材包内没有逐首上游许可文件，当前按"所有者声明可商用"登记为 `royalty-free`。
若这批曲目的授权条款不允许**再分发**（例如仅允许"使用"而不允许随仓分发），请把本目录改为私有存放或只保留索引——
详见 `curation-report.json` 的 `sourceIndex` 与 `sourceFile` 字段（每首都可回溯到原始文件）。
