# 字体授权说明（font-library v1.1 · 全部可免费商用）

> 事实源：供应商随包说明（`font-library-v1.1.zip` 内 `fonts/LICENSES.md`）+ 各字体上游仓库的许可文件。
> 本仓只登记许可与获取方式，**不携带字体二进制**（见 `README.md` §获取与安装）。

| 字体 | 许可证 id | 许可 | 上游 |
|---|---|---|---|
| 思源黑体 / 思源宋体（Source Han Sans/Serif CN、Noto Sans/Serif SC） | `ofl-1.1` | SIL OFL 1.1 | [adobe-fonts/source-han-sans](https://github.com/adobe-fonts/source-han-sans)、[google/fonts](https://github.com/google/fonts) |
| 霞鹜文楷（LXGW WenKai） | `ofl-1.1` | SIL OFL 1.1 | [lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai) |
| 得意黑（Smiley Sans） | `ofl-1.1` | SIL OFL 1.1 | [atelier-anchor/smiley-sans](https://github.com/atelier-anchor/smiley-sans) |
| 站酷快乐体 / 庆科黄油体 / 小薇（ZCOOL 系列） | `ofl-1.1` | 站酷免费商用授权，Google Fonts 以 OFL-1.1 发布 | [google/fonts](https://github.com/google/fonts) |
| 马善政 / 志莽行书 / 流建毛草 / 龙藏体 | `ofl-1.1` | SIL OFL 1.1 | [google/fonts](https://github.com/google/fonts) |
| Inter、Montserrat、Poppins、Oswald、Bebas Neue、Anton、Archivo Black、Playfair Display、Cinzel、Dancing Script、Lobster、Pacifico、Bangers、Caveat、Roboto | `ofl-1.1` | SIL OFL 1.1（Roboto 现以 OFL-1.1 发布，历史版本为 Apache-2.0） | [google/fonts](https://github.com/google/fonts) |

## OFL 1.1 要点（决定了本能力的使用边界）

1. **可自由用于商业用途与嵌入**：成片、封面、贴纸里用字体渲染文字属于「输出作品」，不受限制。
2. **不得单独转售字体文件本身**：字体文件只能随产品/工位分发，不能作为字体商品售卖。
3. **修改后再发布必须改名**：子集化（subset）、改字重、改度量都属于修改——改写后的字体必须换名并标注来源，
   因此本能力**默认不做字体子集化**，直接使用原始字体文件（避免改名与再发布义务）。
4. **保留声明**：再分发字体文件时需随附 OFL 文本与著作权声明；工位安装脚本把许可文件一并落到字体目录。

> 本仓的围栏 `G-SUB5`（`fences/ai-video-subtitle.yml`）只放行 `licensePolicy.commercialWhitelist`
> 白名单许可；未登记许可的字体一律按不合规处理（fail-closed）。
