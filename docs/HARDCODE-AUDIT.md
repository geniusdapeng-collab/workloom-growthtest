# 硬编码排查报告（workloom / WorkLoom 酒店获客系统）

> 排查日期：2026-08-29 · 方法：六类维度自动扫描（`scripts/hardcode-scan.mjs`）→ 白名单过滤 → 逐条语义复核
> 范围：apps/（server+web+webc+desktop+site）、packages/（base/runtime/shared/db/audit-engine/video-studio）、bundles/（hotel/ai-video/geo-growth）、scripts/、.github/
> 结果：候选 949 条 → 白名单豁免 774 条 → 疑似 175 条逐条复核 → **真问题 5 项（已全部修复）+ 测试/套件硬编码 3 处（已一并治理）**

## 一、复核结论总表

| 类别 | 疑似数 | 真问题 | 判定 |
|---|---|---|---|
| A 环境配置 | 98 | 0 | 全部为 CI 连接串、本地开发脚本默认值（有 env 兜底）、第三方官方端点（微信/LLM 预设/平台上传地址）、dsh-gate 本机配置、注释与 placeholder——标准实践，豁免 |
| B 身份演示 | 17 | **3** | trpc.ts 演示登录默认值写死 slug/成员号（P1）、P7 草稿写死 MEM-V01（P1）、P1 页写死演示身份号码（P2→顺手修）；其余为 seed/demo/release-gate/e2e 白名单 |
| C 密钥凭据 | 0 | 0 | 全仓无明文密钥（25 条候选均为白名单内变量名/示例） |
| D 行业泄漏 | 0 | **1** | 扫描器 D1（底座纯电商词：拼多多/亚马逊/千川/ACoS）**0 命中**；人工加扫发现 service-dialog mock 兜底写死种子品牌「云栖酒店」（P1，底座品牌串味）。bundle 串味双向加扫（ai-video/geo-growth 内酒店词、hotel 内社媒词）**0 命中**；audit-core 注释已先行中性化（随本提交带上） |
| E 规则外溢 | 6 | **1** | charter.ts 自治额度默认值 5000/2000 经核与 seed.ts:211 完全一致，且匹配酒店获客量级（房价带 358–788），**判定合理豁免**；decision.ts 注释「1.3 倍宽限」表述不精确（P2→顺手修）；E8.3 校准系数 ×2 为有注释依据的产品逻辑常量（豁免） |
| F 文案展示 | 54 | 0 | 唯一 F1 命中为「API Key」通用术语（豁免）；F2 命中均为角色枚举逻辑变量与 display 字典本体（豁免） |

## 二、修复清单（5+3 项，全部完成）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 1 | P1 | `apps/web/src/lib/trpc.ts` | 演示登录默认值写死 `workspaceSlug: "video-studio"` + `MEM-V01`——客户自建工作区时演示登录即坏 | 抽为 `VITE_DEMO_WORKSPACE` / `VITE_DEMO_MEMBER` env 可配（保留默认值兜底，对齐电商仓口径） |
| 2 | P1 | `apps/web/src/pages/p7/P7.tsx`（2 处） | 技能发布草稿 `ownerMemberNo: "MEM-V01"` 写死 | 默认空，页面加载时以当前登录身份 `members.me.identity.memberNo` 填充；提交后重置同样不再写死 |
| 3 | P2 | `apps/web/src/pages/p1/P1.tsx` | 文案写死「演示身份 MEM-V01 陈主理」 | 去除写死号码，显示实际身份名 |
| 4 | P1 | `packages/base/service-dialog/dialog.ts:251` | 无 LLM 时 mock 兜底写死种子品牌「云栖酒店智能客服」——非酒店工作区（video-studio/geo-growth）应答串味 | 中性化为「智能客服」，不绑定任何种子品牌 |
| 5 | P2 | `packages/base/captain/decision.ts:183` | 注释「1.3 倍宽限」与代码 0.85/1.15 不对称放宽表述不精确 | 注释精确化（标准带再放宽 ±15%：下限≈0.72、上限≈1.32） |
| 6 | 治理 | `packages/base/captain/captain.test.ts` | 断言绑死默认值魔法数（5000/2500/3000/2000…）——默认值行业化调整即破，属测试硬编码 | 引入 `CAP = defaultCharter().autonomy.procurement_cap`，断言全部动态化（对齐电商仓 CAP 模式） |
| 7 | 治理 | `packages/base/captain/captain-v2.test.ts` | 同上（12000/800/3000） | 同上（CAP×2+1000 / ⌊CAP×0.16⌋ / ⌊CAP×0.6⌋） |
| 8 | 治理 | `scripts/suite-hotel.ts`（2 处） | 套件断言绑死资产计数（29 技能/三客群），与近期 audit_only 客群+fast-scan 技能特性演进脱节——预存失败（git stash 验证与本次修改无关） | 断言跟进事实（30 技能/四客群）；audit_only 只读体检期不装配获客组，豁免获客组校验（仅校验 patch 存在） |

## 三、豁免判定摘录（代表性）

- **CI 连接串**（.github/workflows/ci.yml）：CI 环境 postgres service 标准做法
- **本地开发脚本**（reset.sh/preview-all.sh/dev-note.js/doctor.sh 等）：localhost 提示与默认值，均有 env 兜底；`workloom-im-pg` 容器名与 docker-compose.yml 一致，为本仓自我命名口径（非跨仓残留）
- **第三方官方端点**（api.weixin.qq.com、api.deepseek.com 等 LLM 预设、publish-rpa 六平台上传地址、bing RSS 检索兜底）：产品预设，非硬编码缺陷
- **dsh-gate 127.0.0.1:8799**：local-first 架构的本机 gate 地址，有意设计
- **charter 默认值 5000/2000**：与 seed.ts 种子口径一致，匹配酒店获客量级（房价带 358–788 元/夜），行业语境合理——**不为消除而消除**
- **runtime DEMO_TOOLS**（tools.ts）：首版 L3 确定性演示剧本工具表，文件头明确声明演示口径（真实 PMS/OTA 适配器进 L1/L2 层），数字与种子剧本同源，有意设计
- **suite.ts NLU 句式夹具**：OCC/入住率/差评/保底价/满房/小红书文案/携程差评——酒店+获客句式，与本仓行业匹配，**无纯电商句式残留**，豁免
- **base 内酒店/社媒业务模块**（service-kb/service-dialog/service-ticket/inspection/publish-rpa/social-listening 等）：本仓为酒店+社媒+GEO 复合系统，上述模块即本仓的酒店业务层与营销业务层本体，行业词属合法；扫描确认无任何纯电商词（拼多多/亚马逊/千川/ACoS）泄漏
- **E8.3 校准系数 ×2**：驳回降权的产品逻辑常量，有注释依据
- **API Key**：行业通用术语（中文化口径中明确保留）

## 四、验证

- `pnpm -C packages/base typecheck` + `pnpm -C packages/base test`：typecheck 全绿；测试 **444 passed**（含 captain 动态化断言）
- `pnpm typecheck`：全仓 9 包全绿
- `pnpm suite`（独立库 workloom_main，避免共享库冲突）：**452/452 全绿**
- `pnpm suite:hotel`：**43/43 全绿**；`pnpm suite:geo`：**77/77 全绿**

## 五、后续纪律

- `scripts/hardcode-scan.mjs` 已入仓——六类维度一键复扫，可作为 CI 防回归门禁（`node scripts/hardcode-scan.mjs .`）
- 默认值调整时**禁止**在测试中写死具体数值——一律动态引用（CAP 模式）
- 底座包新增文案/兜底应答不得绑定种子工作区品牌名
