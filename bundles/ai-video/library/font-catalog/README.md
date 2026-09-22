# 字体档案库（font-catalog）· 字幕师的选型事实源

来源：供应商字体包 **font-library v1.1**（29 款：中文 13 + 英文 16，全部开源或免费商用），
档案由包内 `font_db.json` v1.1 机械转换而来（见本目录 `font_db.json` 的 `schemaVersion`）。

## 为什么是「档案 + 引脚」，不是「把字体塞进仓库」

| 方案 | 问题 | 本仓选择 |
|---|---|---|
| 字体二进制进仓库 | 29 款 ≈ 128MB，所有克隆、CI、桌面载荷都要背这份体积；OFL 再分发还要随附许可文本 | ❌ |
| 字体不进仓库也不登记 | 工位装了什么字体没人知道，选型结果不可复现，许可无人核对 | ❌ |
| **档案进仓库 + 字体按引脚获取** | 选型事实与许可能审、可测；二进制留在工位 | ✅ 本方案 |

与配乐工位「曲库只登记不搬运」（`library/bgm-library/README.md`）同一纪律。

## 档案结构（`font_db.json`）

| 字段 | 说明 |
|---|---|
| `schemaVersion` / `version` / `source` | `workloom.font-catalog/v1`；来自 font-library v1.1 |
| `licensePolicy.commercialWhitelist` | 可商用许可白名单（`ofl-1.1` / `apache-2.0` / `vendor-free-commercial`） |
| `size_policy` | 字号策略：字号 = 短边 × `base_ratio[场景]` × 粗细修正；描边比与安全边距比 |
| `layout_policy` | 平台版式：画幅 / 标题与字幕的位置·边距比 / 字号倍率 / 封面风格（默认、抖音/快手、B站、小红书、视频号、YouTube） |
| `account_persona` | 账号调性示例：**锁定字体**（品牌视觉锤，优先于打分）与**艺术气息区间** |
| `fonts[]` | 29 款字体：打标八维（语言 / 场景 / 风格标签 / 气质关键词 / 适合作品类型 / 艺术气息 / 字体粗细程度 / 适配BGM节奏）+ `file` / `sha256` / `license` / `source` |

字段口径与供应商原始档案一致（中文键名保留），新增字段只做三件事：路径改为**相对工位字体根目录**、
许可归一为白名单 id、补 `id` / `sha256` / `bytes` 供核验。

## 获取与安装（字体不进仓库）

```bash
# ① 从本地字体包/目录导入（离线、客户自备字体的通用路径；按 pin 逐文件校验 sha256）
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --from-dir /path/to/font-library-v1.1/fonts

# ② 从登记的上游直链获取（只对实测逐字节一致、带 downloadVerifiedAt 的字体放行）
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --download

# ③ 只检查工位现状
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --check
```

安装目录：`${WORKLOOM_SUBTITLE_FONTS_DIR:-$HOME/.workloom-subtitle/fonts}`，布局与档案里的 `file` 字段一致：

```
~/.workloom-subtitle/fonts/
├── cn/  NotoSansSC-Variable.ttf · LXGWWenKai-Regular.ttf · SourceHanSansCN-Heavy.otf …
├── en/  Inter-Variable.ttf · Montserrat-Variable.ttf …
└── LICENSES.md            # 随字体一并落盘的许可文本（OFL 再分发要求）
```

## 许可纪律

1. **商用交付只允许白名单许可**；厂商免费商用授权（`vendor-free-commercial`）登记时必须附许可证明链接；
2. **不做字体子集化**：子集属于「修改后再发布」，OFL 要求在改名并标注来源后才允许——本能力直接使用原始文件；
3. **字体文件不随产品分发**：工位本地获取，凭据与素材留在客户侧；
4. 客户自备的商用字体（方正/汉仪/华康等）由客户提供授权证明，工位按同一 `--from-dir` 通道导入并登记许可，
   **未登记许可的字体不会进入选型候选**（`G-SUB5` 一票否决）。

许可明细见同目录 `LICENSES.md`；上游获取与逐文件核验结果见 `connectors/subtitle-bridge/kit/fonts-pin.json`。
