# 无版权曲库接入规范（bgm-library）

> 本目录**不携带任何第三方音频**：只定义"曲目怎么登记、许可怎么判、署名怎么出"的契约。
> 曲库本身由客户/工位提供（本地目录或已授权的云端音源），配乐工位只做检索、许可校验与署名。

## 1. 目录形态

```
<曲库根目录>/                 # 由 WORKLOOM_BGM_LIBRARY_DIR 指定；缺省指向本目录
  tracks.json                # 曲目索引（唯一事实源，见下）
  audio/                     # 音频文件（可由 path 指向库内任意相对路径）
    warm-ukulele-loop.mp3
```

未接入时 `bgmread.library` 会如实返回 `libraryPresent=false`，并提示走自算作曲
（`bgmwrite.compose`）——**不会**伪造"已接入曲库"。

## 2. tracks.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 库内唯一标识（引用与署名都用它） |
| `title` / `artist` / `source` | ✅ | TASL 署名三元组（标题/作者/来源） |
| `license` | ✅ | 许可标识，取值见下表；未知一律按"不可商用"处理 |
| `path` | ✅ | 相对曲库根目录的音频路径 |
| `bpm` | 建议 | 与 `bgmwrite.compose` 一样参与卡点对齐 |
| `durationSec` | 建议 | 短于片长时工位会循环铺满（`-stream_loop`） |
| `mood` / `genre` | 建议 | 检索用；与 `library/bgm-recipes/recipes.json` 的词汇保持一致 |

许可取值（`core.mjs#LICENSE_TABLE` 为唯一实现）：

| license | 可商用 | 需要署名 |
|---|---|---|
| `cc0-1.0` | ✅ | ❌ |
| `cc-by-4.0` | ✅ | ✅ |
| `cc-by-sa-4.0` | ✅（衍生作品需同许可） | ✅ |
| `royalty-free` | ✅（以平台授权条款为准） | ❌ |
| `workloom-self-generated` | ✅（本仓自算合成） | ❌ |
| `cc-by-nc-4.0` / `cc-by-nd-4.0` / `cc-by-nc-nd-4.0` | ❌ | ✅（但仍不可商用） |
| 其它/未标注 | ❌ | — |

## 3. 许可纪律（围栏 G-BGM5 的可执行口径）

1. **商用交付只允许白名单许可**：CC0 / CC BY / CC BY-SA / 明确写着可商用的免版税曲目；
   CC-NC、CC-ND、来源不明一律阻断（`license_blocked`），不做"先用了再说"。
2. **署名随片交付**：`attribution_required` 的曲目必须产出署名文件（TASL 格式），
   随成片/说明页一起交付；工位在 `bgmwrite.mix` 支持 `attribution_out` 直接落盘。
3. **首批使用人审**：新曲库/新平台的**第一次**入片走 `G-BGM1` 人审（`license_reviewed=false` 即挂起），
   核验通过后的曲目复用自动放行。
4. **不搬运**：工位不下载、不转存第三方音源；链接与凭据留在客户侧，工位只读客户已授权的本地文件。

## 4. 与各音乐库/平台的关系（2026-09-22 核验）

| 平台/工具 | 形态 | 许可要点（已核验口径） | 本仓态度 |
|---|---|---|---|
| 自算作曲（本仓 `synth.mjs`） | 内置 | 本仓合成，无第三方权利，可商用、无署名义务 | **默认路径** |
| Mubert | 商业 API（v3） | 官方宣称生成/流式音轨免版税可商用（以官网条款为准） | 可作 `tracks.json` 的上游，需登记许可与订单 |
| Jamendo | 开发者 API | 官方 API 分 **Non-Commercial / Commercial** 两种计划；曲目 CC 许可混杂，NC 曲目商用需另行授权 | 只接 Commercial 计划 + 逐曲许可登记 |
| ccMixter | 社区曲库 | 逐曲 CC 许可，需自动过滤 NC/ND | 同 Jamendo 口径处理 |
| Free Music Archive | 曲库 + API | 逐曲 CC 许可 | 同上 |
| Tunetank MCP 端点（第三方） | MCP 服务 | 由第三方运营，未在本机验证其可用性与条款 | **未验证**，接入前必须自行核验 |
| MusicGen / AudioCraft | 开源模型 | **代码 MIT，模型权重 CC-BY-NC 4.0（禁止商用）** | 商用交付**不采用**；研究/内部草稿另说 |

> 结论：**能不能商用，取决于许可，不取决于"是不是 AI 生成的"。**
> 这也是本仓把"自算作曲"设为默认路径、把外部曲库做成"登记 + 校验"通道的原因。

## 5. 示例

见同目录 `tracks.example.json`（把文件名改成 `tracks.json` 即可被 `bgmread.library` 读到；
示例里的音频路径仅作占位，不存在时工具会如实标 `fileExists=false`）。
