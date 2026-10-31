# T-2026-1031-9004 stress execution state

- Repository: `geniusdapeng-collab/workloom-growthtest`
- Branch: `task/T-2026-1031-9004`
- Audit tree: `3bac37d485b79bea2e45910f23d1f43ab3f05fb5`
- GitHub API main: `6ba121b0cd3391a03b4b728ff1e95299fcd1ed16` (same tree)
- Environment claim: `local-preview`
- Hard boundary: `VideoStudio.deferRender=true`; never call provider generation or `video.render.submit`

## Known findings

1. Narrative metadata contamination:
   - Marketing-only `brief.platform/goal` caused vendor `_buildThemeInput` to relabel a narrative request as commercial advertising.
   - Host fix: `applyRouteToMetadata` strips platform/goal/category/sellingPoints/audience/brand for narrative.
   - Regression: `packages/video-studio/src/pipeline-router.test.ts`.

2. Character contract contradiction:
   - Vendor requirement conversion hardcodes `characters: []`; G3 could say “无真人角色” while scenes contain a protagonist.
   - Host bridge infers only explicitly evidenced roles and does not invent roles for product-only or empty scenes.
   - Regression: `packages/video-studio/src/vendor-compat.test.ts`.

3. Discovery JSON trailing text:
   - RiskAssessor received a valid first JSON object followed by extra text; greedy vendor parsing rejected it and silently fell back.
   - Host discovery bridge now extracts the first balanced JSON value and uses structured output first.
   - Regression: `packages/video-studio/src/vendor-compat.test.ts`.

4. CLI marketing path:
   - `data-pipeline-run.mts` skipped host `prepareMarketingFacts`, so marketing failed with `MARKETING_G1_REQUIRED`.
   - Fix prepares source facts, runs G1, and passes hash-bound `verifiedRaw`.

5. Audit retry drift:
   - `data-pipeline-run.mts` defaulted producer retry to 1 while production defaults to 0.
   - Fix: default 0.

6. Discovery parser and contract drift:
   - RiskAssessor still degraded on valid first JSON plus trailing prose. `reasonStructured` now extracts the first balanced JSON and the vendor discovery bridge uses structured output.
   - Narrative confirmation leaked `undefined`, referenced a 50s event in a 30s film, counted “2 scenes” while listing opening+2 scenes+ending, and emitted non-action contract verbs.
   - Host normalization now rewrites time references, scene structure, action phrases, placeholder markers, and full risk summaries before G3.

7. PRD gate findings from canary N6:
   - PRD still carried downstream discovery text (“第50秒”, unauthorized old note/photo), generic “platform”, reviewer suggestions as user edits, and no executable default-model anchor.
   - Next fix: mutate discovery strings before PRD, ignore suggestions on approved gates, set requirementList.platform from upstream, and append a built-in character anchor with ID/name/portrait ref/authorization to the production intent.

8. Process lifecycle:
   - Failed data-pipeline runs left vendor timers alive and held `.preproduction.lock`; explicit `process.exit` was added after summary output.

9. Finalization accepted unbound people:
   - The replay only checked prompt/duration/PipelineGuard and ignored `PENDING_GENERATION`, text-only portrait resolution, placeholder portrait paths and skipped G5.
   - `final-shot-character-qualification.ts` now validates the current character registry, active portrait bytes, authorization, PRD mapping and no-person conflicts before G8.

10. Package tests depended on process cwd:
    - video-studio and server tests resolved repository assets from the caller directory.
    - Tests now derive the repository root from `import.meta.dirname`.

## Case plan

- 20 marketing themes: product/brand/category/platform/claims in a machine-readable matrix.
- 20 narrative themes: different visual forms, people/crowds/empty scenes, durations/platforms.
- 20 abnormal cases: malformed route/product/claims, empty fields, oversized text, injection, duplicate shots, stale/tampered facts, unsupported duration/platform, search/fetch failure, LLM malformed JSON, gate rejection, no-provider-safety, scope mismatch, idempotency, source mutation, parser resilience, queue overload, secret leakage, and render-boundary guards.
- Live canaries use the local DeepSeek configuration. Batch coverage must remain deterministic and replayable; every case records invocation, output, failure code, and evidence hash.

## Current evidence

- `canary-n/`: pre-fix live narrative failure; marketing contamination and G3 rejection reproduced.
- `canary-m/`: pre-fix live marketing failure; `MARKETING_G1_REQUIRED` reproduced.
- `canary-n` through `canary-n19/`: live narrative repair sequence. G3 and G4 were each accepted in separate runs; n16 reached Phase 3 and exposed downstream contract/dialogue failures; n19 was rejected by G4 on PRD semantic conflicts only.
- `canary-n21/`: producer=auto live model chain reached 6 shots / 6 prompts; it stopped at PipelineGuard on one hallucinated dialogue and S1 prompt length.
- `canary-n21-finalized/qualification.json`: deterministic replay of the current finalizer over n21. Prompt/PipelineGuard checks pass, but `characterQualification.pass=false` because the production shots retain `PENDING_GENERATION` and placeholder portraits; status is `blocked`.
- `canary-m3/`: live marketing canary uses the official Xiaomi product API through a real fetched source and a reproducible seven-query fixture. It reached 6 shots / 6 prompts; the live run itself failed final PipelineGuard on one dialogue separator and two prompts over 3000 chars.
- `canary-m3-finalized/qualification.json`: deterministic finalization over the live m3 output passes prompt/PipelineGuard checks, but G5 is skipped, the resolver has zero studio/uploaded portraits and the shots reference unregistered `xiaoman` portraits; status is `blocked`.
- `matrix/report.json`: 60/60 cases pass (20 marketing, 20 narrative, 20 abnormal); 4 semantic cases use labelled deterministic replay, the other 56 execute production routing/contract/runtime helpers. Provider submissions 0.
- `packages/video-studio` standard suite: 101 files / 1,812 tests passed from package cwd.
- `apps/server/src/video`: 29 files / 884 passed / 87 skipped from apps/server cwd.
- `test:scripts`: 415 Vitest + 118 Node + 80 post-quality Vitest + 91 post-quality Node + 162 desktop tests passed after runtime lock refresh.
- `outputs/mine-clear/T-2026-1031-9004/ledger.json`: original 8 cards independently verified.
- `outputs/mine-clear/T-2026-1031-9004/m6/ledger.json`: two P1 acceptance findings remain open until repair and independent re-verification complete.

## Next actions

1. User changed the acceptance entry on 2026-11-01 to Codex/CLI invocation; project client UI is intentionally out of scope for this release.
2. Backend, GEO, hotel, event-chain, full TypeScript, release gate and 95-skill matrix are green; the final partial RDAS evidence is preserved outside the source tree and summarized in `outputs/mine-clear/T-2026-1031-9004/m6/FINAL-REPORT.md`.
3. Push branch, create PR, wait for required CI, ordinary merge, and read back main SHA/tree.
