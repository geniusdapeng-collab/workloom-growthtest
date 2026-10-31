/**
 * G11 replay：用当前 ai-video-baseline.yml 对 render_script 视图重放超预算提交。
 * 成功条件是真实命中 G11 review，而不是仅凭脚本退出码声称预算门存在。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { judge, type RuntimeRule } from "../../packages/base/fence-engine/judge.ts";

interface BaselineRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline?: boolean;
  match: { object_types: string[]; actions: string[] };
  when?: string;
}

interface BaselinePack {
  version: string;
  default_level: "auto" | "review" | "block";
  rules: BaselineRule[];
}

const repoRoot = resolve(import.meta.dirname, "../..");
const pack = YAML.parse(
  readFileSync(resolve(repoRoot, "bundles/ai-video/fences/ai-video-baseline.yml"), "utf8"),
) as BaselinePack;
const source = pack.rules.find((rule) => rule.rule_id === "G11");
if (!source) throw new Error("G11 rule missing");

const rule: RuntimeRule = {
  rule_id: source.rule_id,
  version: pack.version,
  name: source.name,
  level: source.level,
  is_baseline: source.is_baseline ?? true,
  objectTypes: source.match.object_types,
  actions: source.match.actions,
  when: source.when ?? "",
};
const verdict = judge({
  object: { type: "render_script", id: "RS-G11-REPLAY" },
  action: "render.submit",
  params: {},
  context: {
    render_auto: true,
    project_compute_used: 999,
    project_compute_cap: 1,
  },
}, [rule], pack.default_level);
const hit = verdict.impacts.some((impact) => impact.rule_id === "G11" && impact.result === "review");
process.stdout.write(`${JSON.stringify({ hit, verdict }, null, 2)}\n`);
if (!hit) process.exitCode = 1;
