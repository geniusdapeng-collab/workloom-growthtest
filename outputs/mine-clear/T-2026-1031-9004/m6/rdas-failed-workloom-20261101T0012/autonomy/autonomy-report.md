# ADR / HIR 自主交付报告（RDAS v3.1）

- 工作区：geo-growth（ws-geo）｜窗口：2026-10-03T15:51:31.313Z → 2026-10-31T15:51:31.332Z｜生成：2026-10-31T15:51:31.332Z
- 原始 threads 6（夹具 0）；原始 approvals 4（夹具 1）
- profile 告警：无

## 总览（completed 交付件）

| 指标 | 值 |
|---|---|
| 交付件 N | 3 |
| ADR-0 零介入 | 100.0% (43.9–100.0%, n=3) |
| **ADR-1 制度性自主交付率** | 100.0% (43.9–100.0%, n=3) |
| ADR-2 无接管 | 100.0% (43.9–100.0%, n=3) |
| HIR 总介入率 | 0.0% (0.0–56.1%, n=3) |
| **HIR-NI 非制度性介入率** | 0.0% (0.0–56.1%, n=3) |
| H3+H4 严重介入率 | 0.0% (0.0–56.1%, n=3) |
| H1/H2/H3/H4 件数 | 0/0/0/0 |
| HMPO 估算（审批延迟代理） | 0 ms/件 |
| 回执覆盖率 | 33.3% |

## 按岗位

| 岗位 | N | ADR-1 | HIR-NI | H3+H4 |
|---|---:|---|---|---|
| ads-optimizer | 2 | 100.0% (34.2–100.0%, n=2) | 0.0% (0.0–65.8%, n=2) | 0.0% (0.0–65.8%, n=2) |
| review-analyst | 1 | 100.0% (20.6–100.0%, n=1) | 0.0% (0.0–79.3%, n=1) | 0.0% (0.0–79.3%, n=1) |

## 数据质量与反作弊信号

- 夹具过滤：threads 0/6；approvals 1/4（近零时长 0）
- 回执证据覆盖：33.33333333333333% 的 completed thread 有回执线索；覆盖不足时 ADR 不能等同于“结果已对账”
- 未关联审批：3（无法归因到交付件）
- 完成但无回执：2
- 外部动作线索：0 个交付链有外部动作事件；其中 0 个无回执证据（有则按“无回执宣告完成”红线候选复核）
- 橡皮图章信号：近零时长审批 0 件

## 口径与方法

- deliverable：terminal thread（completed/failed/paused）；ADR 分母默认 completed
- h1：approval.status=approved 且无修改/驳回/接管
- h2：approval.status=edited 或 thread 内人类动作
- h3：approval.status=rejected 或 thread.paused_by 或 failed+人类动作
- h4：c_tickets payload 关联到 thread（返工线索）
- hmpo：approval latency proxy（decided_at-created_at）；缺少人工工时登记，覆盖不足时只作下限估计

> 注意：本报告是 M1 线上遥测口径（B 级证据）；受控任务集（M2）与离线干预审计（M4）必须另行执行，才能按 A 级结论使用。
