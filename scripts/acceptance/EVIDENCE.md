# workloom-growthtest 验收消费链的证据约定

本次修改是在本隔离仓现有验收控制器上单独审读、修复并验证的本地治理补丁。
固定检查单仍为 276 项。产品标识、行业资产、实验语义和同步隔离规则沿用本仓现状；
这些消费链源码相同不表示本仓成为基座订阅仓。任何后续修改都须按本仓任务卡和隔离规则处理。

## 进程结果与验收结果

- `coverage.mjs` 与 `report-v3.mjs` 只有逐项证据通过才返回 0；实际失败返回 1；缺失、未知、被阻断或未运行返回 2。
- `reportGenerated` 表示诊断报告已生成；`acceptancePassed` 才表示验收通过。空任务、0/0 汇总和四域稀疏声明不能补成通过。
- `fleet-run.mjs` 的必需回归与 `release:gate` 失败会使总状态失败。生产目标的 CLI、profile 和环境必须一致，缺地址时不转向本机。
- 阶段重跑先清除旧自动产物及条目引用；真实 child 本轮生成的非空输出绑定实际 argv、退出码、信号、时刻、角色、完整提交与 SHA256。
- 回归汇总回读实际每条命令与本次 summary-input；聚合执行器、仓库、证据根、输入和输出必须指向同一组真实文件。

## 证据回读

共享的 `scripts/delivery/evidence.mjs` 和 `node-test-reporter.mjs` 捕获真实进程。Node 测试使用机器事件的逐文件计数；
空文件、全部跳过或零匹配即使退出 0 也不是通过。原退出码保留在运行记录，验证结果单列。
验收 item 必须回读同 ID 的 expected、actual 和 pass，不将整体摘要扩展成 276 条成功。
P 域另回读同一 run 的 receipt、transcript、配额 reserve→commit 账本、真实线程事件、媒体字节与解码结果；
用量缺失、冻结或语义不一致保持未验证。字段 actor/approved_by 由可信协调者分配，不能充当平台签名身份。

## 本仓永久回归

从本仓根目录运行：

```sh
node --test --test-concurrency=1 scripts/delivery/*.test.mjs scripts/acceptance/fleet-run.test.mjs
```

测试使用临时 Git 仓、合成原始观察值、真实子进程及回环 HTTP 服务；不会调用付费模型、真实客户服务或媒体 provider。
正常控制 fixture 的通过只验证控制器的语义。真实 live CLI 的阻断用例应产生完整 276 项和 18 个 P 项，同时保持 P 域未验证。
这一结果不能替代独立 M6 或真实生产业务验收。

官方运行接口依据：[Node child_process](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)、
[Node 测试 reporter](https://nodejs.org/api/test.html#custom-reporters)、
[Node realpathSync](https://nodejs.org/api/fs.html#fsrealpathsyncpath-options)。本仓用法与退出语义以上述实际实现和永久断言为准。
