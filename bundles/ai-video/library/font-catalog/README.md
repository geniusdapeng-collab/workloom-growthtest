# 字体档案库（font-catalog）· 字幕师的选型事实源

来源：供应商字体包 **font-library v1.1**（29 款：中文 13 + 英文 16，全部开源或免费商用），
档案由包内 `font_db.json` v1.1 机械转换而来（见本目录 `font_db.json` 的 `schemaVersion`）。

## 字体随仓分发（v1.1 全量入库）

**29 款字体已全量入库** `library/fonts/{cn,en}/`（约 123MB，随 Bundle 一起分发）——开箱即用，
不再依赖工位单独安装；同时保留三层校验与可选的外置覆盖位：

| 层 | 事实源 | 校验方式 |
|---|---|---|
| ① 字体文件 | `library/fonts/cn|en/*.ttf|otf`（29 款） | `font_db.json#fonts[].sha256` 与文件逐字节一致（`packages/base` 回归用例每次校验） |
| ② 制品完整性 | `bundle.json#integrity.assets` | `pnpm bundle:governance` 对每个资产重算 sha256（发布门禁） |
| ③ 取用/升级引脚 | `connectors/subtitle-bridge/kit/fonts-pin.json` | 记录上游项目与逐文件摘要；升级时比对新版本再回填 |

字幕工位默认直接读随包目录（`WORKLOOM_SUBTITLE_FONTS_DIR` 可覆盖为**外置目录**，
用于客户自备商用字体或升级新版本）：

```bash
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --check     # 校验随包 + 外置
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --install   # 随包字体 → 工位外置目录
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --from-dir <客户字体目录>   # 客户自备字体入库外置目录
bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --download  # 从登记直链取新版本（仅放行已核验条目）
```

> 与配乐工位「曲库只登记不搬运」（`library/bgm-library/README.md`）不同：**字体的可复现性依赖字节一致**，
> 因此这里把二进制随仓分发并用三重 sha256 锁住；曲库则是客户侧授权素材，仓位不同、纪律不同。

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

## 目录布局

```
bundles/ai-video/library/fonts/          # 随仓分发（默认取用位）
├── cn/  NotoSansSC-Variable.ttf · LXGWWenKai-Regular.ttf · SourceHanSansCN-Heavy.otf …
├── en/  Inter-Variable.ttf · Montserrat-Variable.ttf …
└── LICENSES.md                          # 许可文本随字体分发（OFL 再分发要求）

${WORKLOOM_SUBTITLE_FONTS_DIR:-$HOME/.workloom-subtitle/fonts}/   # 可选外置覆盖位（客户自备/升级）
└── cn/ en/ LICENSES.md（布局与档案 file 字段一致）
```

## 许可纪律

1. **商用交付只允许白名单许可**；厂商免费商用授权（`vendor-free-commercial`）登记时必须附许可证明链接；
2. **不做字体子集化**：子集属于「修改后再发布」，OFL 要求在改名并标注来源后才允许——本能力直接使用原始文件；
3. **字体文件随仓分发**：29 款均为 OFL-1.1 / 厂商免费商用授权，随 Bundle 分发合规；
   客户自备的商用字体走外置目录覆盖，凭据与素材留在客户侧；
4. 客户自备的商用字体（方正/汉仪/华康等）由客户提供授权证明，工位按同一 `--from-dir` 通道导入并登记许可，
   **未登记许可的字体不会进入选型候选**（`G-SUB5` 一票否决）。

许可明细见同目录 `LICENSES.md`；上游获取与逐文件核验结果见 `connectors/subtitle-bridge/kit/fonts-pin.json`。
