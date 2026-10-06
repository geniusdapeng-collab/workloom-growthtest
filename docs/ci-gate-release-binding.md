# 本仓 CI 并发策略与桌面 Release 源绑定

本文件对应 `T-2026-1006-0001`，只描述 `workloom-ai/workloom-growthtest` 的本仓实现。隔离副本的冻结上游摘要、公共舰队规则和其它仓库不接受本次改动。

## 需求与适用场景

维护者需要同时完成三个具体场景：两个普通业务 PR 同改一个文件时得到准确提醒并在当前合并上下文重跑；两个任务同改明确的协议、同步、迁移等独占模块时让后到者等待；桌面 producer 打包和 publisher 等候选期间，受保护 main 正常合并其它工作后，仍能发行最初绑定的同一提交、稳定 tag 和签名资产。

普通路径提醒依赖后续完整合并校验。任何缺少实际 PR 身份、完整 Git 范围、稳定 API 集合、完整文件路径或最新 CI 的情况均拒绝。API 失败和事实缺失不能通过 `warn` 放行。两个 producer 只上传提交候选，唯一 publisher 才能创建和公开 Release；现有平台锁和签名检查继续执行。

P0 行为是完整身份/范围/路径采集、明确模块互斥、首检观察、固定发布 SHA 的最新三 CI、稳定 tag、真实后继证明和实际公开状态回执。少任一项都会使任务碰撞、漏检 source 提交或错报已公开副作用。P1 是结构化提醒与回执，便于定位另一 IID、观察到的状态和资产哈希。P2 没有新增排期功能；集中锁服务、跨仓协调和自动回滚不在此变更中。

## 候选方案与选择

| 决策 | 候选 | 优点 | 成本与风险 | 适用前提 |
|---|---|---|---|---|
| 普通路径 | L1：普通路径和明确模块都硬拦截 | 所有同文件编辑直接排队 | 普通业务同文件 PR 容易长时间等待，合入后的 push 仍需独立提醒语义 | 人为要求完全串行业务编辑 |
| 普通路径 | L2：普通路径提醒，明确模块在 PR 硬互斥（采用） | 普通工作能通过当前合并检查推进；治理模块仍按队列等待 | 提醒本身不能证明最终合并安全；仍须当前 source/target/checkout、真实平台保护和完整 CI | 完整事实采集、平台合并流程与 CI 均可用 |
| 发布 main | R1：每个后续步骤都要求 main 等于发布 SHA | 判定简单 | 数小时的构建/候选等待内一次正常合并就令发行失败；PATCH 后错误还会隐藏已公开副作用 | 全程冻结 main |
| 发布 main | R2：首检 exact；后续证明受保护 main 的真实后继（采用） | 发行 source/资产固定，main 可正常向前 | 增加 compare、稳定重读、首检文件和公开状态回读；不可证实的祖先关系仍失败 | 首检属于同一 CI build/角色，稳定 tag 与发布 SHA 最新 CI 保持有效 |

选择 L2/R2 是本仓已授权的治理语义。没有添加数据库、服务或依赖。根 `package.json` 和 runtime metadata 输入保持原有内容；新测试由 `.cnb.yml` 明确列出。

## L2：完整采集与两种冲突策略

`scripts/ci/protocol-rules.mjs#resolveLockPolicies` 返回三项独立策略：普通路径默认 `warn`；预合并 PR 的明确模块为 `fail`；API 事实为 `fail`。push 默认对两类冲突提醒。`LOCK_OVERLAP_MODE=fail|warn` 仅改变普通路径，`--strict` 改为两类硬校验。未知模式直接失败。

自身身份仅为相同目标仓库和相同实际 `CNB_PULL_REQUEST_IID`。`CNB_PULL_REQUEST`/`CNB_PULL_REQUEST_LIKE` 布尔值用于识别事件，不能当作 IID。同分支、同 SHA、短 SHA 前缀和祖先关系不排除其它 PR。source/target 的非零完整 40 位 SHA、source 仓库、双方分支绑定官方变量；PR 范围不接受 `--base` 改写。子进程继承的 ambient `CNB_*` 先清除，再显式传入本次字段。

PR 使用实际提交 checker 的 source/target/checkout/canonical 双亲及 tree 契约，差异取 `target...source`。本地/显式范围和 push 使用真实 Git 对象；`--name-status -z` 保留 A/M/D/T、rename/copy 的旧新路径及路径中的换行、制表、Unicode 和首尾空格。合法空 diff 不回退另一基线，浅历史或未知显式基线直接失败。

API 的 open PR 列表逐页读到末页，详情在文件采集前后重读，再完整重扫列表。重复 IID、集合变化、PR 移动/关闭、页数超限、超时或错误响应都失败。PR 文件接口是不分页数组；完整路径取固定 base/head compare 的 `path` 和 rename/copy 的 `previous_filename`。PullFiles 交叉核对数量、状态及文件名；基名不冒充路径。存在 path/raw/blob URL 时还须相互一致，URL 绑定 CNB 来源、实际仓库和完整 source SHA。fork 先在实际 source 仓库取得同 SHA commit，权限不足或对象缺失不能回退目标仓猜测。

官方 Swagger 的 compare 状态为 `added/modified/deleted/renamed/copied`；实际 CNB 留存响应中也出现 `add/modify`。实现仅将已知 `add/modify/delete/rename/copy` 五种服务短写归一化为对应长写，路径、旧路径、完整 SHA、数量和未知状态拒绝仍按同一契约执行。真实响应的 94 项文件差异和合成 rename/copy 负例均纳入回归。

默认请求超时 10 秒、全次采集预算 60 秒、页大小 10、最多 100 页；边界可在隔离测试中显式注入。错误只输出稳定原因，令牌、响应错误正文和签名 URL 不打印。本地缺少仓库/令牌输出 `local-skip`，同时 `verified:false`、`complete:false`；CI 缺少这些信息即失败。

成功结果为 `workloom.lock-conflict/v2` JSON，包含决策、完整性、页数、实际 source/target SHA、self IID、Git 范围、完整路径、三项策略及每个冲突的另一 IID/类型/是否阻断。失败退出非零。普通提醒不替代平台合并条件；static-gate 不等待自己的 pending 状态，三项 CI 在合并和发布阶段验证。

## R2：首检与后检

首检同时要求：产品清单仓库、`api_trigger_desktop_release` 事件、main/default main、角色流水线、合法 build ID、稳定 tag、触发 SHA/触发分支 SHA/checkout/release SHA 完全一致、签名模式 `signed`、实际远端 main 受保护且等于 release SHA、tag 精确指向该 SHA，以及目标 Release 尚不存在。

固定 SHA 的 `git/commit-statuses/{sha}` 接口返回数组。三项必需上下文是 `pipeline-1(static-gate)`、`pipeline-2(db-gate)`、`pipeline-3(test-gate)`。只要出现任一 `cnb/push/` 必需上下文，整组使用 push；缺少另外两项或新的 pending/error/failure/skip 不能回落旧 PR success。仅在没有必需 push 家族时使用完整 `cnb/pull_request/` 家族。每项先按合法 `created_at` 选择最新 run，再按该同一 run 的 `updated_at` 选择最新状态。旧 run 晚完成的 success 不能覆盖较新 run 的 pending/failure。同创建时刻有不同目标 run 标识、没有 run 标识却状态矛盾、同更新时间不同状态、未知状态、空列表、缺项或错误形状均失败；回执只保留目标标识哈希，原 `target_url` 不打印。

`preflight --receipt <path>` 写入全新、0600、不可覆盖的 `workloom.desktop-preflight/v1` JSON，绑定 repository/tag/sha/buildId/role/platformSigning、exact main、protected、tag SHA、观察时间和完整 CI。各角色使用自己工作区里的文件；`stage-platform`/`publish --preflight-receipt` 必须读同 build、同角色观察，缺失、篡改、symlink、超大文件或工作区外路径都失败。

首检文件是同 CI build 的执行观察，**不是独立密码学认证**，不能把任意用户提供 JSON 当作平台签名。没有提供观察的单独函数调用会先执行一次实际 exact 首检，再将此次观察用于函数后续步骤。

后检要求 main 仍受保护；等于 release SHA 可直接通过，变化时必须由实际 compare 证明 base 等于 release SHA、head 等于观察到的 main、merge-base 等于 release SHA。随后重读 main/tag；main 变化最多重试三次，持续变化失败。稳定 tag、固定 SHA 的最新三项 CI、签名模式、候选 build ID 与清单 SHA-512 始终保持绑定。错误、缺字段和不可证实的 ancestry 不放行。

## 公开副作用与回执

publisher 按顺序下载本次两个 producer 的候选，核对各自清单摘要，组装三安装包与两证据文件，创建空草稿，上传且不覆盖五资产，下载实际远端字节验证 SHA-512 和签名清单，然后再次后检，才发送一次公开 PATCH。

PATCH 网络/HTTP 失败也可能已经生效。之后只 GET 同一 release ID 和 Latest，不重复 POST/PATCH、不覆盖、不删除。最多十二轮回读、间隔五秒，记录每轮 current/Latest 的实际 draft/public/unavailable 状态。公开状态与 Latest 成立后，再核对五资产大小、下载公开字节验证 SHA-512，并重新核对 source/tag/CI/main。

`workloom.desktop-publication/v1` 成功和错误回执都绑定 repository/tag/sha/build/role、release ID、是否尝试 PATCH、五资产名/实际字节 SHA-512/大小、首检时间、状态读回和验证结果：

| published | verification | 含义 |
|---|---|---|
| `true` | `complete` | 实际 public + Latest、五资产公开字节、固定 source/tag/最新 CI/受保护 main ancestry 均已通过 |
| `true` | `violation` | 已观察到公开，但 tag、CI、保护、祖先关系或资产违反固定契约；非零退出 |
| `true` | `incomplete` | 已观察到公开，但 Latest、资产或源证明因读失败等未完成；非零退出 |
| `false` | `incomplete`/`violation` | 公开前失败，或 PATCH 后同一 ID 的实际草稿状态已读到；非零退出 |
| `unknown` | `incomplete` | PATCH 已尝试，所有可用回读均不能证明公开/草稿；非零退出 |

CLI 在非零错误文字之前输出结构化回执，避免把已经公开写成“未发布”。临时目录清理失败也保留同一公开状态与验证结果，增加 `cleanup.state:failed` 并非零退出；若已有 tag/CI/资产主错误，清理错误不能替换它。生产 API 状态、签名、公证和 runner 安装包构建须由实际 CNB 环境验证；本地 HTTP/文件夹具只验证本实现的契约，不认证真实 Mac/Windows 安装包。

## 运行与验证

```bash
node --test scripts/ci/protocol-rules.test.mjs scripts/ci/verify-lock-conflict.test.mjs scripts/ci/cnb-desktop-release.test.mjs
node --test scripts/ci/verify-commit-msg.test.mjs scripts/desktop-release-finalizer.test.mjs scripts/runtime-deps-lock.test.mjs
node scripts/ci/verify-lock-conflict.mjs --self-test
node scripts/ci/verify-commit-msg.mjs --self-test

# 每个 CI 角色首步，文件名在 .cnb.yml 明确固定
node scripts/ci/cnb-desktop-release.mjs preflight --receipt desktop-preflight-desktop-publisher.json
node scripts/ci/cnb-desktop-release.mjs publish --preflight-receipt desktop-preflight-desktop-publisher.json
```

`.cnb.yml` 同时保留原有 static/db/test 三门禁、签名、公证、resolve 摘要和唯一 publisher 锁，明确运行新 lock 测试、既有 release 测试，以及 test-gate 中 `local-cover-render` 的真实 FFmpeg/字体用例和 `film-standard-post` Node 用例。旧自由分段入口已撤除，标准后期验证必须沿用原提交的全部完整原片及同源原声。验证不得调用新图像、视频、语音或模型任务。

依据为 [CNB 默认环境变量](https://docs.cnb.cool/zh/build/build-in-env.html)、[CNB OpenAPI](https://docs.cnb.cool/zh/develops/openapi.html) 与 [官方 Swagger](https://api.cnb.cool/swagger.json)，配合本仓完整源码和实际 Git/HTTP 回归。接口数组/字段与 PR 状态来源分别绑定，不将 PR 状态 envelope 冒充提交状态数组。
