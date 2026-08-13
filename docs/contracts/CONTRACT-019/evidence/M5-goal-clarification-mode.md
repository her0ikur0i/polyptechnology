# CONTRACT-019 Evidence — M5 Goal-Clarification Mode

## Status

Complete.

## DeepSeek Worker Use

Managed DeepSeek was used before implementation, with Codex limited to review,
integration, and verification.

- Attempt `c19b6b2c-aac4-4f31-8d5a-bdd5c87bddde`
  - Provider/model: `deepseek / deepseek-v4-pro`
  - Outcome: succeeded, but output was an unusable tool-call stub
  - Usage: 254 input, 172 output, $0.000261
- Attempt `c11446bb-9fb3-4f96-a7d4-00e86fea7cc5`
  - Provider/model: `deepseek / deepseek-v4-pro`
  - Outcome: succeeded
  - Usage: 201 input, 757 output, $0.000747

## Implementation

Changed:

- `src/dashboard/conversation-workspace.tsx`
- `src/dashboard/styles.css`
- `tests/dashboard/app.test.tsx`

The conversation composer now exposes two policy-safe modes:

- `Auto`
- `Clarify goals`

When `Clarify goals` is selected:

- the composer placeholder asks for outcome, users, constraints, and unknowns;
- the route rationale is shown in the composer:
  `orchestration` starts with DeepSeek Pro and fallback remains policy-gated;
- the owner message is prefixed with a bounded clarification instruction asking
  the assistant to clarify objective, users, scope, constraints, success
  criteria, and unknowns before proposal or implementation;
- resend/regenerate is idempotent and does not stack duplicate clarification
  prefixes.

No raw model selector, `model`, or `mode` command field was added. The existing
reply path already uses `modelRoutes("orchestration")`, whose first route is
`deepseek-v4-pro`. Keeping M5 client-visible avoids inventing a second routing
contract before the later model-policy UI milestone.

## Validation

Commands run:

- `npm run dashboard:test`
  - passed, 53 tests
- `npm run typecheck`
  - passed
- `npm run dashboard:build`
  - passed
- `npm run format:check`
  - passed

Focused test added:

- `offers clarify-goals mode without exposing a raw model override`
  - verifies the mode selector and DeepSeek Pro route rationale are visible;
  - verifies the sent content includes the clarification instruction;
  - verifies no `model` or `mode` field is sent to the backend.

## Result

The owner can explicitly frame a chat turn as goal clarification while the
system remains policy-governed: DeepSeek Pro remains first for orchestration,
fallback is still controlled by policy, and arbitrary model bypass is not
exposed in the dashboard.
