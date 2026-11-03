# 视频生成第二轮深度审计与修复

## 覆盖率声明

- 范围内文件总数：348；精读：178；机检/脚本解析：165；抽样：5；未读：0。
- 每个路径、读取方式、角色、候选字节散列见 [coverage.csv](coverage.csv) 和 [coverage.json](coverage.json)。B 级只有 Git/字节/引用检查，C 级只覆盖列明的边界。范围按上一轮交付清单仍在树中的路径、本轮从实际调用链展开的相关文件及所有源码改动的并集；排除工作流以外的仓库子产品、历史产物和完整传递依赖闭包。
- B/C 清单逐项见上表文件。范围外为无关产品、历史产物及未进入本轮实际调用路径的传递依赖，不以全仓逐行审计表述。

## 结论与交付基线

本轮复现并修复 **21 项实现缺陷**，其中 **3 项 P0**。各卡先修复回归、后独立验收，证据与同一源码候选 SHA 绑定。
- 云端审计基线：`c028118de87f80b4ff0726c758b1ca0d964b9a63`；修复/验收源码：`16fc646d15e3bf7c65274abd1cf0b2af000320cb`；[PR #34](https://github.com/geniusdapeng-collab/workloom-growthtest/pull/34) · [Issue #33](https://github.com/geniusdapeng-collab/workloom-growthtest/issues/33)。
- A：根因来自源码精读；B：本机实跑与可回读回执；C/D 不用于宣告任何缺陷已修。环境档位：`local-preview`。
- 主链：用户原始输入 → 通用/营销分流 → 需求/情报/审批 → 剧本、镜头提示词、定妆引用 → 生成提交/查询/媒资 → 档案与控制面。
- 这次没有实施上一轮提出的前期架构调整和逐镜自动选图合同。保留现有租户、业务事实、围栏、预算和审批语义。

## 缺陷、复现与验收

下表源定位链接指向审计基线。断言 argv、期望、验收角色、退出码与实际输出散列见 [台账](ledger.json)；点击每条回执可查实际测试数量和输出索引。

| 卡 / 级别 | A：根因 | B：失败证据与最终独验 |
|---|---|---|
| MC-001 / P1 | [制片档案先读文件后校验项目，路径段可越出工作区](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/archive-resume.ts#L278) | [红1](reproductions/root/archive-access-red.log)；[独验通过](runs/MC-001-0-1793673813507.json) |
| MC-002 / P1 | [运行时更新production agents后各Phase仍调用旧实例，模型与截止策略失效](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js#L228) | [红1](reproductions/general/MC-002-red.log)、[红2](reproductions/submission/MC-002-phase35-independent-red.log)；[独验通过](runs/MC-002-0-1793673552976.json) |
| MC-003 / P1 | [查询失败或无法核实的响应被当作视频任务终态失败](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/gen/providers.ts#L114) | [红1](reproductions/submission/provider-polling-red.log)、[红2](reproductions/general/MC-003-independent-domestic-red.log)；[独验通过](runs/MC-003-0-1793673642710.json) |
| MC-004 / P1 | [成功任务入库失败后不再恢复，重叠轮询可重复终结且异常漏连接](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/render-poller.ts#L149) | [红1](reproductions/submission/render-poller-recovery-red.log)、[红2](reproductions/submission/production-client-ingest-red.log)；[独验通过](runs/MC-004-0-1793673643431.json) |
| MC-005 / P1 | [轮询running及缺provider超时更新未设置事务RLS，报告与真库状态不符](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/render-poller.ts#L173) | [红1](reproductions/submission/render-poller-red.log)；[独验通过](runs/MC-005-0-1793673645739.json) |
| MC-006 / P0 | [真实生成任务可能被自动Mock轮询并记成真实成功](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/render-poller.ts#L118) | [红1](reproductions/submission/render-poller-mock-red.log)；[独验通过](runs/MC-006-0-1793673647450.json) |
| MC-007 / P1 | [营销事实引用可错归属来源，重定向别名覆盖有效快照](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/marketing-facts.ts#L135) | [红1](reproductions/marketing/source-attribution-red.log)、[红2](reproductions/submission/MC-007-image-attribution-independent-red.log)；[独验通过](runs/MC-007-0-1793673554075.json) |
| MC-008 / P1 | [营销检索线索被兜底成已审商品身份并进入创作卡片](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/vendor/supermickey/hyperreality-system/engines/data-mining-engine/agents/product-info-collector.js#L154) | [红1](reproductions/marketing/dossier-identity-host-red.log)、[红2](reproductions/marketing/dossier-identity-studio-red.log)；[独验通过](runs/MC-008-0-1793673554765.json) |
| MC-009 / P1 | [竞品无证据仍把全部己方卖点标成差异化空位](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/vendor/supermickey/hyperreality-system/engines/data-mining-engine/agents/competitor-scout.js#L175) | [红1](reproductions/marketing/empty-competitors-host-red.log)、[红2](reproductions/marketing/empty-competitors-studio-red.log)；[独验通过](runs/MC-009-0-1793673556588.json) |
| MC-010 / P1 | [控制面同幂等命令并发重复执行，后到请求唯一键失败](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/packages/video-studio/src/pipeline-control-plane/coordinator.ts#L238) | [红1](reproductions/root/control-command-red.log)；[独验通过](runs/MC-010-0-1793673815197.json) |
| MC-011 / P1 | [控制面投影忽略自动门裁决，状态与下一动作不符](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/packages/video-studio/src/pipeline-control-plane/projection.ts#L117) | [红1](reproductions/root/auto-projection-red.log)；[独验通过](runs/MC-011-0-1793673816408.json) |
| MC-012 / P1 | [异步需求清单转换未等待，G3与PRD消费Promise](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/vendor/supermickey/hyperreality-system/index.js#L743) | [红1](reproductions/general/MC-012-red.log)；[独验通过](runs/MC-012-0-1793673557555.json) |
| MC-013 / P1 | [检索短暂失败被缓存为空结果导致12小时无法恢复](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/data-mining-executor.ts#L248) | [红1](reproductions/marketing/search-recovery-red.log)、[红2](reproductions/submission/MC-013-search-protocol-independent-red.log)；[独验通过](runs/MC-013-0-1793673558776.json) |
| MC-014 / P1 | [已审规格来源在Studio重装订时丢失](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/marketing-authority.ts#L194) | [红1](reproductions/marketing/spec-consumption-red.log)；[独验通过](runs/MC-014-0-1793673559421.json) |
| MC-015 / P1 | [档案恢复改用截断标题且遗漏原metadata和导演委托边界](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/archive-resume.ts#L226) | [红1](reproductions/root/resume-input-red.log)、[红2](reproductions/root/resume-forced-red.log)；[独验通过](runs/MC-015-0-1793673816992.json) |
| MC-016 / P1 | [film组件受理回执未及时持久化且失败写覆盖已知taskId](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/film-worker.ts#L1192) | [红1](reproductions/submission/film-provider-receipt-red.log)、[红2](reproductions/general/MC-016-late-write-independent-red.log)；[独验通过](runs/MC-016-0-1793673649060.json) |
| MC-017 / P0 | [情报商品图下载允许被重定向至私网](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/media/products.ts#L169) | [红1](reproductions/marketing/hero-source-red.log)；[独验通过](runs/MC-017-0-1793673560265.json) |
| MC-018 / P1 | [预生产审计日志跨运行混写](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/studio-worker.ts#L190) | [红1](reproductions/root/log-scope-red.log)；[独验通过](runs/MC-018-0-1793673818727.json) |
| MC-019 / P1 | [PRD 缺乏有效审批时仍消耗剧本阶段](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/vendor/supermickey/hyperreality-system/index.js#L1049) | [红1](reproductions/general/MC-019-red.log)；[独验通过](runs/MC-019-0-1793673563363.json) |
| MC-020 / P0 | [并发 vendor 子引擎复用其他工作区的模型适配器](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/packages/video-studio/src/llm-adapter.ts#L461) | [红1](reproductions/root/llm-scope-red.log)；[独验通过](runs/MC-020-0-1793673650772.json) |
| MC-021 / P1 | [并发 vendor 渲染共用最新定妆索引](https://github.com/geniusdapeng-collab/workloom-growthtest/blob/c028118de87f80b4ff0726c758b1ca0d964b9a63/apps/server/src/video/studio-worker.ts#L627) | [红1](reproductions/marketing/portrait-bridge-concurrency-red.log)、[红2](reproductions/marketing/portrait-parser-concurrency-red.log)；[独验通过](runs/MC-021-0-1793673565099.json) |

### 关键用例：前置条件 → 操作 → 预期与实际

| 卡 | 前置条件与操作 | 基线实际 | 候选预期与实际（B） |
|---|---|---|---|
| MC-001 / MC-015 | 伪造工作区或路径；再以授权项目分别恢复 v1 和旧档案 | 先碰磁盘；恢复落回截断标题或遗漏原始参数 | 无权时零归档读写；v1 原始参数完整，旧档缺必要证据时停止 |
| MC-003–006 / MC-016 | 受理后注入查询失败、下载失败、并发轮询、缺凭据；取消后迟到回执首写故障 | 任务假失败或模拟成功、重复结束、受理证据丢失 | 查询与生成终态分开；只收尾一次；同任务号和最终请求哈希保留；新增供应商 POST 为零 |
| MC-007–009 / MC-013 / MC-014 | 两个来源使用别名与同 URL，不同实际素材；缺商品/竞品证据或收到非搜索协议响应 | 图角度错归属、无证据事实进入创作；异常响应写空缓存；已审规格重装后消失 | 同快照素材可追溯；证据不足不产出已核实结论；异常可重试；规格引用未丢失 |
| MC-010 / MC-011 | 真 PostgreSQL 并发执行同一幂等键，并投影自动批准、拒绝、未核实 | 后到请求唯一键报错；投影忽略自动裁决 | 同一回执重复读取；下一步与真实裁决一致 |
| MC-002 / MC-012 / MC-019 | 实际 vendor 更换阶段模型、延迟需求转换、注入 G4 失败 | 阶段仍持旧模型，G3 读到 Promise，G4 异常仍调用剧本 | Phase 3.5 使用新模型，G3 得到已完成结果；剧本调用数为零且保留 G4 错误 |
| MC-017 | 受控公网地址返回跳转到环回；另测超长和正常图 | 本机私网接收真实请求 | 危险地址零请求；限制字节；合法来源仍可入库 |
| MC-018 / MC-020 / MC-021 | 并发两工作区、乱序退出；检查归档日志、模型计量和实际请求内联字节 | 串日志、子引擎走他人适配器、绑定取错定妆索引 | 三路均按实际运行隔离；关闭的模型范围拒绝迟到外调；桥恢复 |

## 验证矩阵

- 正常：本机模型/HTTP 协议替身、真实 vendor 调用链、真实 PG 事务与实际文件写入。验证归档、媒体入库、门投影和恢复继续路径。
- 边界与并发：无竞品或规格、历史空缓存、未知状态、同幂等键请求、迟到回执、两工作区并发、原型摘除顺序、下载字节上限。
- 错误：供应商短时异常与终态分离；先受理后本地失败不能覆盖供应商任务号；回执补写只写本地，避免重复提交；审批失败到剧本调用数为零。
- 权限与真实性：真实 PG RLS 跨工作区拒绝；未授权不读档案；DNS 和跳转均禁止访问非公网；模拟任务不能冒充真实成功。
- 全量相邻回归：Server 视频 53 套、1241 通过、1 跳过；Video Studio 117 套、1980 通过；Node 边界 21 通过。全工作区 TypeScript、发布门禁 11/11、能力生成一致性、6 条编译管线均通过。见 [检查汇总](verification-summary.json)。
- Server 唯一跳过项是依赖可选 TalkCraft 安装的 108 卡 frontmatter 检查，本机无 vendor/talkcraft/PINNED。
- 源码路径跑测真实执行；供应商边界使用替身。未在外部供应商创建任务或支付费用，未测生产画质、吞吐和实际账单。

## 收尾报告

- 已完成：第二轮静态、动态、联动和交付面审计；问题先复现再修；各卡独立验收；台账门禁与本机结构验收交接。
- 未完成/未覆盖：外部生产实单、RDAS 全量与 P 域；本轮授权范围外的新架构及选图合同。
- 自主追加事项及理由：纳入商品图私网跳转、日志/模型/定妆桥并发串线，以及独立复核发现的迟到回执和搜索协议边界；它们均可直接影响本轮生成主链。
- 采用的假设：以 GitHub 主干和当前审批策略为事实基线；用专用本机库、测试凭据与协议替身验证失败状态。
- 置信度：高。根因有代码定位，关键用例有前后对照、独立角色和固定候选回执；生产供应商行为未在本轮验证。
- 建议复核：MC-006/016 任务与回执的真实性、MC-017 下载边界、MC-020/021 两工作区的模型归属和实际参考字节。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？
