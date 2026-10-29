# WorkLoom text model routing

## Canonical contract

All text generation and review resolve through the symbolic key `text.primary`:

- provider: DeepSeek
- model: `deepseek-flash`
- context: 1,048,576 tokens
- maximum output: 393,216 tokens
- protocol: OpenAI-compatible chat completions

The official service still accepts `deepseek-v4-flash` as a stale alias, but
WorkLoom rejects it rather than normalizing it: every configuration, request
trace and response identity must name `deepseek-flash` exactly. Legacy
chat/reasoner aliases and Kimi, GLM, Qwen, MiniMax, OpenAI, Anthropic or Gemini
text models are also rejected. Media generation models remain in a separate
registry.

Official facts checked 2026-10-30:

- <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/>
- <https://api-docs.deepseek.com/zh-cn/guides/json_mode/>
- <https://api-docs.deepseek.com/zh-cn/guides/vision/>
- <https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/>

## Single dispatch surface

The following active paths delegate to the same canonical provider:

- `apps/server/src/service/llm.ts`
- `packages/base/workdata/recall.ts`
- `packages/video-studio/src/llm-adapter.ts`
- `packages/video-studio/src/producer-gate.ts`
- `packages/video-studio/src/plausibility-review.ts`
- `apps/server/src/industry/geo-growth/jev/client.ts`
- CLI entry points under `scripts/tools/`

The vendor `LLMEngine` is a compatibility facade. Production installs the host
bridge over its methods before use; direct use fails with
`HOST_MODEL_DISPATCH_REQUIRED`. The legacy PandaCineForge extension is disabled
by default and can only reach text through an explicitly configured host
bridge.

`packages/base/model-router/model-routing-contract.test.ts` scans runtime source
to reject new direct text endpoints and foreign text-model IDs outside the
registry and controlled test harnesses.

## Scene policy

Thinking and format are decisions of the semantic scene, not the caller or
subscription tier. The initial policy is:

| Scene family | Thinking |
|---|---|
| intent routing, extraction, normalization, schema repair, rigid format | disabled |
| PRD, script, scene plan, narrative, prompt and copy generation | enabled `high` |
| producer, continuity, plausibility and independent content review | enabled `high` |
| final high-stakes review | enabled `max` after evidence supports it |

Billing tiers (`L1/L2/L3`, plans and off-peak windows) remain analytics and
billing labels. They no longer select different models. Generation and review
always resolve to the same `deepseek-flash` model.

## Full-window budget

The exact serialized request—messages, tools and response format—is tokenized
with the pinned official DeepSeek tokenizer:

- asset SHA-256:
  `89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614`
- source archive SHA-256:
  `e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495`

For every task:

```text
inputTokens = official text tokens
            + chat framing
            + image count × 1,024-token image ceiling

max_tokens = min(393,216, 1,048,576 - inputTokens)
```

The complete input is sent once. Character counts, 4K/8K/16K/32K vendor
guesses and hidden `reasoning_content` extraction are not used as budget or
fallback mechanisms. Images follow the documented limits of 600 images, 48 MiB
request body, 32 MiB inline image and 64 MiB total non-file-id image data.

If the hard context or request-body limit is exceeded, dispatch fails closed
and requires an explicit lossless partition with complete final synthesis.

## Failure and retry

Calls fail closed when any of the following occurs:

- returned model identity differs from `deepseek-flash`
- `finish_reason` is not `stop`
- final content is empty
- expected JSON is malformed, truncated or schema-invalid
- usage is missing or inconsistent
- non-thinking mode returns reasoning content or reasoning tokens
- context, image count or request body exceeds the documented limit

Only a 429 response may retry, with the same model, mode, prompt and policy.
HTTP 5xx and network timeouts have an unknown execution result and are not
automatically duplicated.

## Receipts

Every successful call returns or records:

- configured and returned model
- scene, thinking mode and effort
- input/output/total/reasoning tokens
- output ceiling and tokenizer estimate
- `finish_reason`
- request/response hashes
- response ID
- policy and registry versions
- bounded retry attempts

Provider bodies and credentials are not stored. Final business content remains
separate from reasoning metadata.

## Validation

Repository validation covers:

- official tokenizer loading and context/output boundaries
- disabled and enabled thinking modes
- JSON success, malformed JSON, empty content and truncation
- wrong model, missing usage and reasoning leakage
- timeout, cancellation, 429 retry and unknown 5xx
- local-window scheduling
- same-model generation/review resolution
- a source-wide direct-transport and foreign-model contract scan
- a real DeepSeek disabled JSON and enabled-high smoke

Local HTTP tests prove request bytes and failure behavior. A successful HTTP
call alone is not a production video-quality receipt.

## Isolated repository receipt

This repository independently verified the canonical routing contract, media
adapter paths, workbench capabilities, changed-file secret scan and real
DeepSeek disabled/enabled-high JSON calls. It remains `none-in-none-out`; none
of its experimental behavior is distributed to or asserted as evidence for the
base fleet.
