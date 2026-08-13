# CONTRACT-019 Evidence — M6 Project Generation Flow Surface

## Status

Complete.

## DeepSeek Worker Use

Managed DeepSeek was used before implementation, with Codex limited to review,
integration, and verification.

- Attempt `d3a14d47-464b-4e26-8c8e-c45241005652`
  - Provider/model: `deepseek / deepseek-v4-pro`
  - Outcome: succeeded
  - Usage: 190 input, 553 output, $0.000564

DeepSeek recommended a visible stage machine for the proposal-to-generation
flow. Codex adapted that to the repository's existing single-component
dashboard pattern and existing `tests/dashboard` test layout.

## Implementation

Changed:

- `src/dashboard/conversation-workspace.tsx`
- `src/dashboard/styles.css`
- `tests/dashboard/app.test.tsx`

The Proposal panel now shows an owner-visible project generation flow:

- Conversation
- Proposal
- Owner approval
- Blueprint translation
- Code generation

Each stage shows one of the real facts already available in the UI:

- saved conversation turn count;
- proposal id;
- approval id or proposal state;
- blueprint translation task id;
- generation task id.

The existing command semantics are unchanged:

- drafting compiles the saved conversation into a proposal;
- approving hands off the frozen proposal;
- translation queues the blueprint task;
- generation queues code generation only after translation succeeds.

No backend schema changes, public deployment controls, generated-project hosting,
or model-selection bypasses were added.

## Validation

Commands run:

- `npm run typecheck`
  - passed
- `npm run format:check`
  - passed
- `npm run dashboard:test`
  - passed, 54 tests
- `npm run dashboard:build`
  - passed

Focused test added:

- `surfaces the project generation flow from proposal through queued generation`
  - starts a conversation;
  - sends a saved owner turn;
  - drafts a proposal;
  - approves it;
  - queues blueprint translation;
  - waits for translation success;
  - queues code generation;
  - verifies the visible proposal, approval, translation task, and generation
    task ids.

## Result

The owner can see where a project is in the generation path directly in the
dashboard, instead of inferring it from scattered buttons and transient output.
