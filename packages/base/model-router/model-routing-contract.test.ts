import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const roots = ["apps", "packages", "scripts", "vendor"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".py"]);

function walk(path: string, output: string[] = []): string[] {
  for (const entry of readdirSync(path)) {
    if (["node_modules", "outputs", "assets", "dist", "build", ".git"].includes(entry)) continue;
    const full = join(path, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, output);
    else if (sourceExtensions.has(extname(entry))) output.push(full);
  }
  return output;
}

function isTestLike(path: string): boolean {
  const rel = relative(repoRoot, path);
  return /(?:^|\/)(?:test|tests|fixtures?|__tests__)\//u.test(rel)
    || /\.(?:test|spec)\./u.test(rel)
    || /stub|mock/iu.test(rel);
}

function codeLines(path: string): Array<{ line: number; text: string }> {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return trimmed
        && !trimmed.startsWith("//")
        && !trimmed.startsWith("*")
        && !trimmed.startsWith("#")
        && !trimmed.startsWith("<!--");
    });
}

describe("repository-wide text-model routing contract", () => {
  it("has no direct text-provider transport outside the canonical adapter and controlled test harnesses", () => {
    const allowed = new Set([
      "packages/base/model-router/providers.ts",
      "scripts/suite.ts",
      "vendor/supermickey/hyperreality-system/skills/panda-cineforge/panda_cineforge.py",
    ]);
    const violations: string[] = [];
    for (const path of roots.flatMap((root) => walk(join(repoRoot, root)))) {
      const rel = relative(repoRoot, path);
      if (isTestLike(path) || rel.startsWith("scripts/acceptance/")) continue;
      for (const { line, text } of codeLines(path)) {
        if (/chat\/completions|\/responses|responses\.create|chat\.completions\.create/iu.test(text)
          && !allowed.has(rel)) {
          violations.push(`${rel}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps foreign text-model IDs out of runtime call sites", () => {
    const allow = new Set([
      "packages/base/model-router/token-budget.ts",
      "scripts/ui-governance-rules.mjs",
    ]);
    const violations: string[] = [];
    for (const path of roots.flatMap((root) => walk(join(repoRoot, root)))) {
      const rel = relative(repoRoot, path);
      if (isTestLike(path) || allow.has(rel)) continue;
      for (const { line, text } of codeLines(path)) {
        if (/\b(?:kimi-k[0-9a-z.]*|glm-[0-9][a-z0-9.]*|qwen-[0-9][a-z0-9.]*|gpt-4o-mini|moonshot-v1)\b/i.test(text)) {
          violations.push(`${rel}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the vendor compatibility facade cannot make a direct model request", () => {
    const source = readFileSync(
      join(repoRoot, "vendor/supermickey/systems/llm-reasoning-engine.js"),
      "utf8",
    );
    expect(source).toContain("HOST_MODEL_DISPATCH_REQUIRED");
    expect(source).not.toMatch(/agent-gw\.kimi\.com|KIMI_API_KEY|MOONSHOT_API_KEY/);
  });
});
