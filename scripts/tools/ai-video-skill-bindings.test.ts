import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPOSED_SKILL_BINDINGS } from "../skill-bindings.mts";

const repoRoot = resolve(import.meta.dirname, "../..");
const skillsRoot = join(repoRoot, "bundles/ai-video/skills");
const bindingMap = COMPOSED_SKILL_BINDINGS["ai-video"];

function frontmatter(name: string): { description: string; body: string } {
  const raw = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  expect(match, `${name} 必须有 frontmatter`).not.toBeNull();
  const description = match![1]!.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? "";
  return { description, body: match![2]!.trim() };
}

function declaredBindings(description: string): string[] {
  const clause = description.match(/绑定围栏[:：]?\s*([^。；;\n]+)/u)?.[1];
  if (!clause) return [];
  return [...new Set(clause.matchAll(/G-?[A-Z]{0,4}\d{0,3}[a-z]?|\bR\d{1,2}\b/gu).map((match) => match[0]!))].sort();
}

describe("AI 视频技能契约与运行时围栏绑定", () => {
  it.each(Object.keys(bindingMap).sort())("%s 的非空说明声明与实际安装绑定一致", (name) => {
    const { description, body } = frontmatter(name);
    expect(description.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThanOrEqual(80);
    const bound = bindingMap[name] ?? [];
    for (const declared of declaredBindings(description)) {
      expect(
        bound.some((item) => item === declared || item.startsWith(declared)),
        `${name} 声明 ${declared}，实际绑定 ${bound.join(",") || "无"}`,
      ).toBe(true);
    }
  });

  it("talkcraft-ops 不再是无 frontmatter、无描述的占位技能", () => {
    const { description, body } = frontmatter("talkcraft-ops");
    expect(description).toContain("口播解说片");
    expect(body.length).toBeGreaterThan(1000);
    expect(bindingMap["talkcraft-ops"]).toBeUndefined();
  });
});
