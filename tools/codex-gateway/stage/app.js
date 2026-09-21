/* WorkLoom 数字人工作台 P0：只读投影 + SSE。所有状态来自 /stage/snapshot 与 /stage/stream。 */

const STATUS_TEXT = {
  working: "在岗",
  needs_input: "待输入",
  blocked: "阻塞",
  idle: "待命",
  offline: "离线",
};

const el = (id) => document.getElementById(id);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

let snapshot = null;
const tickerItems = [];

function renderStats(data) {
  const items = [
    ["数字员工", data.counts.agents, "人"],
    ["在岗", data.counts.working, "人"],
    ["待输入", data.counts.needsInput, "人"],
    ["阻塞", data.counts.blocked, "人"],
    ["待审批", data.counts.pendingApprovals, "项"],
    ["运行 Run", data.counts.activeRuns, "个"],
  ];
  el("stats").innerHTML = items
    .map(([k, v, u]) => `<div class="stat"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}<span class="u">${escapeHtml(u)}</span></div></div>`)
    .join("");
}

function renderPipelines(data) {
  const pipelines = data.capabilities.pipelines ?? [];
  el("catalog-count").textContent = `${data.capabilities.summary.employees} 员工 / ${data.capabilities.summary.skills} 技能`;
  el("pipelines").innerHTML = pipelines
    .map(
      (pipeline) => `<div class="pipeline"><div class="name">${escapeHtml(pipeline.displayName)}</div><div class="meta">${escapeHtml(
        pipeline.id,
      )} · 闸门 <span class="gate">${escapeHtml(pipeline.gates.join(" / ") || "无")}</span></div></div>`,
    )
    .join("");
}

function renderAgents(data) {
  const runs = new Map(data.runs.map((run) => [run.runId, run]));
  el("agents").innerHTML = data.agents
    .map((agent) => {
      const run = agent.currentRunId ? runs.get(agent.currentRunId) : null;
      const progress = Math.round((run?.progress ?? 0) * 100);
      const task = run ? `${run.displayName} · ${run.currentStep ?? run.state}` : `${STATUS_TEXT[agent.status] ?? agent.status} · 近 30 天 ${agent.stats.actions30} 个动作`;
      const risk = agent.risk?.level ?? "auto";
      return `<article class="agent status-${escapeHtml(agent.status)}" title="${escapeHtml(agent.id)}">
        <div class="agent-head">
          <div class="avatar">${escapeHtml(agent.name.slice(0, 1))}</div>
          <div>
            <div class="name">${escapeHtml(agent.name)}</div>
            <div class="alias">${escapeHtml(agent.alias ?? agent.presetKey)}</div>
          </div>
          <span class="status-dot"></span>
        </div>
        <div class="task">${escapeHtml(task)}</div>
        ${run ? `<div class="progress"><i style="width:${progress}%"></i></div>` : ""}
        <div class="foot">
          <span class="tag risk-${escapeHtml(risk)}">${escapeHtml(risk)}</span>
          ${agent.nightShift ? '<span class="tag">夜班</span>' : ""}
          ${agent.pendingApprovals.length ? `<span class="tag risk-review">待审批 ${agent.pendingApprovals.length}</span>` : ""}
          <span class="tag">${escapeHtml((agent.bundles ?? []).slice(0, 2).join("/"))}</span>
        </div>
      </article>`;
    })
    .join("");
}

function renderApprovals(data) {
  el("approval-count").textContent = `${data.approvals.length} 项`;
  if (!data.approvals.length) {
    el("approvals").innerHTML = '<div class="card"><div class="desc">当前没有待审批事项。</div></div>';
    return;
  }
  el("approvals").innerHTML = data.approvals
    .map(
      (approval) => `<div class="card">
        <div class="title">${escapeHtml(approval.gate ?? "人工审批")} · ${escapeHtml(approval.risk)}</div>
        <div class="desc">${escapeHtml(approval.summary)}</div>
        <div class="row"><span>${escapeHtml(approval.objectRef)}</span><span>${escapeHtml(approval.approvalId)}</span></div>
        <div class="gestures"><button disabled>批准</button><button disabled>修改</button><button disabled>驳回</button></div>
      </div>`,
    )
    .join("");
}

function renderRuns(data) {
  el("runs").innerHTML = data.runs
    .map((run) => {
      const progress = Math.round((run.progress ?? 0) * 100);
      return `<div class="card">
        <div class="title">${escapeHtml(run.displayName)}</div>
        <div class="desc">${escapeHtml(run.state)} · ${escapeHtml(run.currentStep ?? "-")} · ${escapeHtml(run.dataMode)}</div>
        <div class="progress"><i style="width:${progress}%"></i></div>
        <div class="row"><span>${escapeHtml(run.runId)}</span><span>${progress}% · ${escapeHtml(run.cost?.amount ?? 0)} ${escapeHtml(run.cost?.unit ?? "")}</span></div>
      </div>`;
    })
    .join("");
}

function renderKpi(data) {
  const kpi = data.kpi
    .map((item) => `<div class="card"><span>${escapeHtml(item.name)}</span><span class="v">${escapeHtml(item.value)}${escapeHtml(item.unit)}</span></div>`)
    .join("");
  const quota = data.quota
    .map((item) => `<div class="card"><span>${escapeHtml(item.pool)}</span><span class="v">${escapeHtml(item.used)}/${escapeHtml(item.limit)}</span></div>`)
    .join("");
  el("kpi").innerHTML = kpi + quota;
}

function pushTicker(text) {
  tickerItems.push(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`);
  if (tickerItems.length > 20) tickerItems.shift();
  const doubled = [...tickerItems, ...tickerItems];
  el("ticker").innerHTML = doubled.map((item) => `<span>◆ ${escapeHtml(item)}</span>`).join("");
}

function renderSnapshot(data) {
  snapshot = data;
  el("workspace").textContent = `${data.workspace.name} · ${data.workspace.id}`;
  el("mode-badge").textContent = `数据模式：${data.dataMode}`;
  el("mode-badge").className = `badge ${data.dataMode === "real" ? "badge-ok" : "badge-warn"}`;
  el("night-pill").textContent = `夜班 ${data.night.status} · ${data.night.range}`;
  el("cursor").textContent = `cursor ${data.cursor} · ${new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false })}`;
  el("stage-note").textContent = data.note;
  renderStats(data);
  renderPipelines(data);
  renderAgents(data);
  renderApprovals(data);
  renderRuns(data);
  renderKpi(data);
  pushTicker("工作台快照已加载（模拟数据）");
}

function connect() {
  const source = new EventSource("./stream?demo=1");
  source.addEventListener("open", () => {
    el("connection").textContent = "已连接";
    el("connection").className = "pill";
  });
  source.addEventListener("error", () => {
    el("connection").textContent = "重连中";
    el("connection").className = "pill pill-off";
  });
  source.addEventListener("stage.snapshot", (event) => renderSnapshot(JSON.parse(event.data)));
  source.addEventListener("run.progress", (event) => {
    const data = JSON.parse(event.data);
    pushTicker(`${data.displayName} ${Math.round(data.progress * 100)}% (${data.state})`);
  });
  source.addEventListener("approval.asked", (event) => {
    const data = JSON.parse(event.data);
    pushTicker(`待审批：${data.displayName}（${data.capabilityId}）`);
  });
  source.addEventListener("stage.heartbeat", () => {});
}

connect();
