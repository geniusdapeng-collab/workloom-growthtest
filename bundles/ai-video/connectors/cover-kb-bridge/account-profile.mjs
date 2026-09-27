/**
 * cover-kb-bridge · 账号档案读取（**零依赖**迷你 YAML 子集解析）
 *
 * 为什么不用第三方 YAML 解析器：工位连接器要能在**未安装依赖**的机器上直接跑
 * （与 cine-kb-bridge 同口径）。账号档案 schema 固定（见
 * `bundles/ai-video/library/account-profiles/README.md`），只用到：
 *   · 扁平键值（`account_id: chen-zhuo`）
 *   · 一层缩进对象（`visual_hammer:` + 缩进字段）
 *   · 内联数组（`platforms: [douyin, xiaohongshu]`）
 *   · 块级列表（`taboo:` + `- 硬广话术`）
 *   · 引号、行尾注释、布尔
 * 主链路的账号档案由 `scripts/tools/full-chain-film.mts` 用仓库自带 `yaml` 包解析后传入；
 * 本模块只服务 CLI 与测试，两者对同一份档案必须得到**等价结论**（core.test.ts 有对照用例）。
 */

/** 去掉行尾注释（`#` 前有空白才算注释——避免把 `#FFD166` 这类色值切掉） */
function stripComment(value) {
  const text = String(value ?? "");
  /** `key:   # 注释` —— 冒号后只剩注释，等价于空值（`\s#` 规则覆盖不到这种情况） */
  if (text.trimStart().startsWith("#")) return "";
  const hit = text.search(/\s#/);
  return (hit >= 0 ? text.slice(0, hit) : text).trim();
}

/** 去引号 */
function unquote(value) {
  let v = stripComment(value);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function parseScalar(value) {
  const v = unquote(value);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map((item) => unquote(item)).filter((item) => item !== "");
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  return v;
}

/**
 * 解析账号档案最小 YAML 子集。
 *
 * 不支持的语法（多行字符串 / 两级以上嵌套 / 锚点 / 注释块）会被**忽略而不是猜**——
 * 缺失字段由 `normalizeAccountProfile` 如实记录，不静默编造。
 */
export function parseAccountProfileYaml(text) {
  const out = {};
  /** 缩进栈：每个进入的容器记录自己的缩进，键的层级由缩进比较决定（不做"最近键"猜测） */
  const stack = [{ indent: -1, obj: out }];
  /** 最近一次出现的键：块级列表项（`- x`）挂到它下面 */
  let lastKey = null;

  for (const rawLine of String(text ?? "").split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = (rawLine.match(/^\s*/) ?? [""])[0].length;
    const body = rawLine.trim();

    /** 块级列表项：宿主是最近一次出现的键（可能是 `taboo:` 这种空对象占位） */
    const listItem = /^-\s*(.+)$/.exec(body);
    if (listItem && lastKey) {
      const { container, key, placeholder } = lastKey;
      if (!Array.isArray(container[key])) {
        container[key] = [];
        /** 占位对象被数组替换：把栈里对应的作用域帧一并撤掉 */
        const top = stack[stack.length - 1];
        if (stack.length > 1 && top && top.obj === placeholder) stack.pop();
      }
      container[key].push(parseScalar(listItem[1]));
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(body);
    if (!match) continue;
    const [, key, rest] = match;

    /** 缩进收敛：把比当前行更深或同层的容器弹出，落到真正的父容器 */
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const container = stack[stack.length - 1].obj;

    if (stripComment(rest) === "") {
      /** 空值：可能是嵌套对象，也可能是块级列表——先建对象占位，列表项到达时替换为数组 */
      container[key] = {};
      lastKey = { container, key, placeholder: container[key] };
      stack.push({ indent, obj: container[key] });
    } else {
      container[key] = parseScalar(rest);
      lastKey = { container, key, placeholder: null };
    }
  }

  /** 空对象（其实是空列表/空嵌套）归一为 null，避免调用方拿到 `{}` 当有效值 */
  const normalizeEmpty = (obj) => {
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        normalizeEmpty(value);
        if (Object.keys(value).length === 0) obj[key] = null;
      }
    }
  };
  normalizeEmpty(out);
  return out;
}
