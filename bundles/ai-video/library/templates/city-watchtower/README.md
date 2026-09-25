# 瞭望塔式城市片模板（city-watchtower）

给"一座城市的 45–60 秒快剪片"用。设计依据是对《Watchtower of Turkey》的深度拉片
（`docs/watchtower-deconstruction.md`），把它的可复刻部分落成我们的管线可执行参数。

## 一句话口径（产品所有者 2026-09-25 三次纠偏后）

**参考素材只作实景依据**：素材以 `reference_image` 提交（不作 first_frame），
画面里的机位、视差、环境运动由模型**构建**；不是"把照片动起来"，也不是"后期做个运镜了事"。
硬闸：`scene-constructed`（首帧 ≥32dB / 直比 ≥40dB / 中段 ≥34dB 判"参考图被推动"）+ 围栏 G-MAT4。

## 怎么用（南昌示例可直接跑）

```bash
# 0) 先按 examples/nanchang/brief.json 的 referenceNeeds 备齐参考素材（官方授权/自制优先）
#    素材放到 <WS>/work/nanchang/selected/，并把 shotlist 里的 photo 路径改成实际路径

# 1) 素材镜 → 构建视频场景（reference_image 模式；带场景构建与参考独立性硬闸）
node_modules/.bin/tsx scripts/tools/full-chain-film.mts \
  --shots <WS>/work/nanchang/shotlist.json --project VID-NC-WT01 \
  --library <WS>/work/character-library --work-dir <WS>/work/vm-nc --out <WS>/outputs/film-nc \
  --brief <WS>/work/nanchang/brief.json --keys-file ~/.workloom/live.env \
  --stages cine-kb,continuity,micromotion,spec,material-gen,videos,voice \
  --narration-profile chen-zhuo-film --max-attempts 2

# 2) 后期：合片（逐刀甩镜转场 + 时长补偿）→ 调色 → 字幕 → 配乐 → **转场音效** → 封面 → 终审 → 交付
node_modules/.bin/tsx scripts/tools/full-chain-film.mts \
  --shots <WS>/work/nanchang/shotlist.json --project VID-NC-WT01 \
  --work-dir <WS>/work/vm-nc --out <WS>/outputs/film-nc \
  --stages compose,color,subtitle,bgm,sfx,cover,master,deliver \
  --subtitle-mode burn --no-danmaku --platform 小红书 \
  --cut-transition hblur --cut-transition-duration 0.18 --cut-transition-at 2,3,4,5 \
  --bgm-track electronic-pulse-city-beneath-the-waves-v001-133 \
  --color-mode grade --color-profile cool-technical --color-intensity 0.6 \
  --max-attempts 2
```

模板参数（段落镜长、转场、声音三层、人物策略、门禁清单）见 `template.yml`；
南昌的分镜、简报与角色表见 `examples/nanchang/`。

## 与我们的其它片子的差别

| 维度 | 口播片（滕王阁 30s） | 瞭望塔式城市片 |
|---|---|---|
| 人物 | 主讲人贯穿、有台词 | 主讲人只在开场/收尾；中间是临时角色（无台词） |
| 节奏 | 6 镜 × 5s，硬切 | 14–18 镜，镜长 1.2–4.5s 曲线化，逐刀甩镜转场 |
| 声音 | 音乐 + 台词 | 音乐 + 人声短句 + **转场音效层（whoosh/impact/riser）** |
| 素材 | 参考图 → 生成场景 | 参考图 → 生成场景（更多机位、更多镜） |
| 字幕 | 台词字幕 | 只在必要处给 1–2 条钩子（不做逐句字幕） |

## 已知缺口（如实）

- **SFX 层已实现**（`sfx-synth`，合成无第三方采样），但音色库只有三种（whoosh/impact/riser）——
  更细的"人声呼吸、市场嘈杂、脚步"等生活音效仍属后续扩展；
- 真实航拍与真实群众抓拍**不可复刻**（需现场拍摄 + 肖像/场地授权），模板用生成式场景替代；
- 参考素材必须换成官方授权或自制素材后才能对外正式发布。
