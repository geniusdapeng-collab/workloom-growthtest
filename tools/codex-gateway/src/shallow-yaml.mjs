/**
 * 浅层 YAML 读取器（P0 专用，零依赖）。
 *
 * 只解析能力目录真正需要的字段，不追求 YAML 兼容：
 *  - preset：preset_key/name/kind/description/readonly/night_shift/high_risk/
 *            fence_bindings/skills/tools
 *  - fence：version/default_level/rules(rule_id|id/name/level/is_baseline/note/actions)
 *  - pipeline：quest/name/version/description/schedule/steps(step_key/name/owner/gate/outputs)
 *  - SKILL.md：frontmatter 的 name/description
 *
 * 这是有意的范围裁剪：真源仍是 bundle.json / 各 YAML 文件本身；
 * 若解析失败，调用方必须记录 warning 并把该文件计入 unparsed，不允许静默省略。
 */

const stripComment = (line) => {
  const idx = line.indexOf(" #");
  return (idx >= 0 ? line.slice(0, idx) : line).replace(/\s+$/, "");
};

const unquote = (value) => {
  let v = String(value ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
};

const boolOf = (value, fallback = false) => {
  const v = unquote(value).toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
};

export function inlineArray(value) {
  const v = unquote(value);
  if (!v.startsWith("[") || !v.endsWith("]")) return null;
  const body = v.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((item) => unquote(item)).filter(Boolean);
}

function parseInlineObject(value) {
  const v = unquote(value);
  if (!v.startsWith("{") || !v.endsWith("}")) return null;
  const body = v.slice(1, -1);
  const out = {};
  for (const part of body.split(",")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = unquote(val);
  }
  return out;
}

function parseTopLevel(lines) {
  const out = {};
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line || line.startsWith("#") || /^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || value === "" || value === "|" || value === ">") continue;
    out[key] = unquote(value);
  }
  return out;
}

function parseStringList(lines, startIndex) {
  const items = [];
  let index = startIndex + 1;
  for (; index < lines.length; index += 1) {
    const line = stripComment(lines[index]);
    if (!line) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+-\s+(.*)$/);
    if (!match) continue;
    const value = match[1].trim();
    if (value.startsWith("{")) continue;
    items.push(unquote(value));
  }
  return { items, nextIndex: index };
}

export function parsePreset(text) {
  const lines = text.split(/\r?\n/);
  const top = parseTopLevel(lines);
  const tools = [];
  const skills = [];
  const warnings = [];
  let block = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i]);
    if (!line) continue;

    const topLevel = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (topLevel) {
      block = topLevel[1];
      if (block === "skills") {
        const inline = inlineArray(topLevel[2]);
        if (inline) skills.push(...inline);
      }
      continue;
    }

    if (block === "tools") {
      const toolMatch = line.match(/^\s+-\s*(\{.*\})\s*$/);
      if (toolMatch) {
        const obj = parseInlineObject(toolMatch[1]);
        if (obj?.name) {
          tools.push({
            name: obj.name,
            access: obj.access === "write" ? "write" : obj.access === "read" ? "read" : "unknown",
            desc: obj.desc ?? "",
          });
        } else {
          warnings.push(`tools 条目无法解析：${line.trim()}`);
        }
        continue;
      }
      continue;
    }

    if (block === "skills") {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && !item[1].trim().startsWith("{")) {
        skills.push(unquote(item[1].trim()));
        continue;
      }
      // skills 块里的其它行（多行结构）本轮不解析，但不算错误。
      const { items, nextIndex } = parseStringList(lines, i);
      if (items.length) {
        skills.push(...items);
        i = nextIndex - 1;
      }
    }
  }

  return {
    presetKey: top.preset_key ?? "",
    name: top.name ?? "",
    version: top.version ?? "",
    kind: top.kind ?? "",
    description: top.description ?? "",
    readonly: boolOf(top.readonly, false),
    nightShift: boolOf(top.night_shift, false),
    highRisk: boolOf(top.high_risk, false),
    fenceBindings: inlineArray(top.fence_bindings) ?? [],
    skills: [...new Set(skills)],
    tools,
    warnings,
  };
}

export function parseFence(text) {
  const lines = text.split(/\r?\n/);
  const top = parseTopLevel(lines);
  const rules = [];
  const warnings = [];
  let current = null;

  const push = () => {
    if (current?.ruleId) rules.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    const start = line.match(/^\s+-\s*(?:rule_id|id):\s*(.+)$/);
    if (start) {
      push();
      current = {
        ruleId: unquote(start[1]),
        name: "",
        level: "review",
        baseline: false,
        note: "",
        actions: [],
      };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+(name|level|is_baseline|note|when|actions):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "name") current.name = unquote(value);
    else if (key === "level") current.level = unquote(value);
    else if (key === "is_baseline") current.baseline = boolOf(value, false);
    else if (key === "note") current.note = unquote(value);
    else if (key === "actions") {
      const arr = inlineArray(value);
      if (arr) current.actions.push(...arr);
    }
  }
  push();

  if (!rules.length) warnings.push("围栏文件未解析出任何规则");
  return {
    version: top.version ?? "",
    defaultLevel: top.default_level ?? "review",
    rules,
    warnings,
  };
}

export function parsePipeline(text) {
  const lines = text.split(/\r?\n/);
  const top = parseTopLevel(lines);
  const steps = [];
  let current = null;

  const push = () => {
    if (current?.stepKey) steps.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    const start = line.match(/^\s+-\s*step_key:\s*(.+)$/);
    if (start) {
      push();
      current = { stepKey: unquote(start[1]), name: "", owner: "", gate: "", outputs: [] };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+(name|owner|gate|outputs):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "name") current.name = unquote(value);
    else if (key === "owner") current.owner = unquote(value);
    else if (key === "gate") current.gate = unquote(value);
    else if (key === "outputs") current.outputs = inlineArray(value) ?? [];
  }
  push();

  return {
    quest: top.quest ?? "",
    name: top.name ?? "",
    version: top.version ?? "",
    description: top.description ?? "",
    schedule: top.schedule ?? "",
    steps,
  };
}

export function parseSkillFrontmatter(text) {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  const body = match[1];
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name: unquote(name), description: unquote(description) };
}
