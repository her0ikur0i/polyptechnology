# Model Routing

Canonical source: `docs/operations/model-routing.md`.

Current static policy source: `src/gateway/model-policy.ts`.

Blueprint translation fallback order:

1. DeepSeek V4 Flash
2. DeepSeek V4 Pro
3. GPT 5.5
4. GPT 5.6
5. Claude Sonnet 5
6. Claude Opus 5

Activation gate:

- `scripts/orchestration-chain-canary.ts` must pass every blueprint translation
  route before a release is activated or a heavy drill is started.
- `gpt-5.6` is the policy name. The Codex CLI currently accepts the concrete
  model id `gpt-5.6-sol`, so the adapter maps the policy name to that CLI id at
  invocation time and keeps `gpt-5.6` in gateway attribution.
- Claude Sonnet 5 and Claude Opus 5 must be exposed by the local Claude CLI
  account before they can be treated as healthy fallback tiers.

Coding fallback order:

1. DeepSeek V4 Flash
2. DeepSeek V4 Pro
3. GPT 5.5
4. Claude Sonnet 4.6

DeepSeek coding behavior:

- Programming routes must keep DeepSeek in non-thinking patch-emitter mode.
  Thinking-mode streaming is reserved for routes that can consume reasoning
  traffic without requiring a patch as the first model-visible output.
- DeepSeek patch prompts must end with the strict diff-only contract. The first
  non-whitespace bytes of the provider response must be `diff --git `.
- If DeepSeek is rejected for no diff, malformed diff, scope, typecheck, or test
  failure, the next attempt must receive the concrete verifier/rejection reason
  before fallback advances to the next model.
- Fallback exists for unrepaired evidence, not for impatience. Timeouts are not
  verifier evidence that a model cannot solve the task.
