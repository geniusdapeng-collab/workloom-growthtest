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
- `canary-n21-finalized/qualification.json`: deterministic replay of the current finalizer over n21. PipelineGuard passes 0/0; 6 prompts are <=3000 chars, no dialogue, total 30s, `providerSubmission=false`, status `eligible_pending_G8`.
- `canary-m3/`: live marketing canary uses the official Xiaomi product API through a real fetched source and a reproducible seven-query fixture. It reached 6 shots / 6 prompts; the live run itself failed final PipelineGuard on one dialogue separator and two prompts over 3000 chars.
- `canary-m3-finalized/qualification.json`: deterministic finalization over the live m3 output passes PipelineGuard 0/0 and the final-shot contract; all 6 prompts are <=3000 chars, no dialogue, 9:16, 1080x1920, 30fps, total 30s, `providerSubmission=false`, status `eligible_pending_G8`.
- `matrix/report.json`: 60/60 cases pass (20 marketing, 20 narrative, 20 abnormal); 4 semantic cases use labelled deterministic replay, the other 56 execute production routing/contract/runtime helpers. Provider submissions 0.
- `producer-gate.test.ts`, `studio.test.ts`, `pipeline-router.test.ts`, `vendor-compat.test.ts`, `configured-llm.test.ts`: 114 targeted assertions passing after current repairs.
- Current expanded targeted suites pass 123 assertions across router, final-shot contract, data mining, marketing facts and source fetch; package/server typechecks pass.
- `outputs/mine-clear/T-2026-1031-9004/ledger.json`: 7 audit cards registered (5 P1, 2 P2) with code evidence at audit commit and executable assertions.
- Current worktree is intentionally dirty and must be committed before PR/CI/merge. The task branch tree equaled GitHub main tree at audit start.

## Next actions

1. Run full relevant tests/typecheck/release gates/secret scan.
2. Commit the clean fix baseline.
3. Run MCD repair assertions, commit evidence, then assign an independent acceptance role for acceptance runs and gate.
4. Push branch, create PR, wait for CI, ordinary merge, read back main SHA/tree.
