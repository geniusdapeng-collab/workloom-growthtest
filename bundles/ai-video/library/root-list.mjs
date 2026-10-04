import path from "node:path";

/** Directory-list syntax: JSON is portable; legacy OS-separated lists remain valid. */
export function parseRootList(value, { fallback = [], platform = process.platform } = {}) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return [...fallback];
  let list;
  if (raw.startsWith("[")) {
    try { list = JSON.parse(raw); }
    catch (error) { throw new TypeError(`允许目录 JSON 无法解析：${error.message}`); }
    if (!Array.isArray(list) || !list.length || list.some(entry => typeof entry !== "string" || !entry.trim())) {
      throw new TypeError("允许目录必须是非空字符串数组");
    }
  } else {
    // Windows drive letters are never a directory-list delimiter.
    const delimiter = platform === "win32" || /(?:^|;)[A-Za-z]:[\\/]/u.test(raw) ? ";" : path.posix.delimiter;
    list = raw.split(delimiter);
  }
  const clean = [...new Set(list.map(entry => entry.trim()).filter(Boolean))];
  if (!clean.length || clean.some(entry => entry.includes("\0"))) throw new TypeError("允许目录列表为空或含非法字符");
  return clean;
}
