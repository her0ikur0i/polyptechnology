# CONTRACT-014 — Conversation workspace: interview, agreed brief, blueprint

Status: draft (not yet started)

## Objective

Build the "Conversation workspace" `docs/SYSTEM-SPECIFICATION.md` (Section 16) and `docs/architecture/adr-0002-conversation-authority-boundary.md`
already specify but never got a UI: a real chat interview that converges on
an agreed narrative brief, gets owner-approved through the existing
proposal lifecycle, and translates into the `BlueprintDocument` the
generation pipeline (CONTRACT-013 M5) already consumes unchanged. Replaces
`FactoryControlPage`'s bare "Generate project blueprint" form.

## Depends on

CONTRACT-006 (accepted): the `Conversation`/`Message`/`Attachment`/
`Proposal` data model, state machines, and `ConversationStore` interface
(`src/orchestrator/**`, migration `0005_orchestrator.sql`) -- real and
tested (`tests/orchestrator*.test.ts`), but never reachable from any Control
API route or UI. CONTRACT-013 (accepted): `AiGateway`/`RuntimePolicy`
routing, `NodeWorkspaceProvisioner`/`createGenerationTask` (consumed
unchanged by M6 here), the private staging instance (M9, reused for M9
here, not rebuilt), CSRF/auth patterns in `src/control-api/**`.

## Scope

- **Conversation & message routes, `idea`-state project bootstrap**: create
  a conversation (auto-creating a project in `idea` lifecycle state --
  `docs/SYSTEM-SPECIFICATION.md` Section 17 already anticipates this state
  -- if none is supplied), append/list messages, list conversations for a
  project. `ConversationStore` currently has no "list conversations for a
  project" method at all -- add it.
- **Assistant replies, auto-routed**: a message send routes through
  `AiGateway` (same DeepSeek -> Codex -> Claude policy as every other
  programming/orchestration task class, cheapest-first, owner sees status
  only -- no manual per-message model picking, confirmed decision) and
  appends the response as a `role: "assistant"` message.
- **File upload**: a real multipart route wired to the existing
  `conversation_attachments` state machine
  (`src/orchestrator/attachments.ts`: quarantined -> validated -> scanned ->
  classified -> redacted). "Scanned" means structural type/size validation
  for this contract, not a real antivirus/content-scanning integration --
  confirmed decision, matches the project's existing "one pinned image/tier
  first" pragmatism (`src/operations/verification-image-policy.ts`).
- **Chat UI**: message thread, send box, attachment upload widget,
  replacing `FactoryControlPage`'s form entirely (confirmed decision -- not
  an additional parallel path).
- **Narrative brief -> proposal -> owner approval, surfaced in the UI**:
  wires the existing, never-UI-reachable `OrchestratorService`
  (submit/requestOwnerReview/approve/handoff, `src/orchestrator/service.ts`)
  to real conversation turns -- action preview and approval happens inside
  the conversation, per spec.
- **Blueprint translation**: a new step converting an approved proposal's
  narrative `contractCandidate` into the existing `BlueprintDocument` shape
  (`src/factory/blueprint.ts`), then calling the existing, unmodified
  `createGenerationTask`/`NodeWorkspaceProvisioner` pipeline.
- **Session management**: rename, archive, search (confirmed v1 set --
  pin, branch, and export explicitly deferred). Folder/collection view
  grouped by project, including `idea`-state ones, per spec. Requires a new
  migration: `conversations` currently has no archived flag and no store
  method to rename/list/search.
- **End-to-end enforcement and negative tests**: CSRF coverage for every
  new route, axe coverage for the chat UI, upload-abuse tests (oversized,
  disallowed type, path-traversal-shaped filenames), auth-boundary tests
  matching the CONTRACT-013 M7 pattern.
- **Security review** of the new surface specifically: upload handling,
  assistant-reply injection risk (an attacker-controlled message or
  attachment content must never gain tool/execution authority --
  ADR-0002's boundary, re-verified against the real implementation, not
  just the design doc).
- **Redeploy to the existing private staging instance** (M9 from
  CONTRACT-013, reused as-is -- no new host-level setup, no new owner
  -authority action) and extend the owner acceptance checklist with real
  chat scenarios.
- **Repository-wide code quality cleanup**, placed last again per the
  owner's standing preference: formatting plus a dead-code/duplication
  audit of whatever this contract touches.
- Evidence reconciliation, exactly one commit, and push.

## Out of scope

Pin and branch/export session features (deferred per confirmed decision).
Real content-scanning/antivirus integration for uploads (deferred).
Manual per-message model selection (deferred -- automatic routing only,
confirmed decision). Global (non-project-scoped) conversations -- every
conversation stays project-scoped, `idea`-state projects satisfy the
"start chatting before you know the stack" need without a schema change to
drop the `project_id` requirement. Any new host-level installation, DNS,
Cloudflare Access, or Telegram credential work -- M9 here reuses the
already-approved, already-running CONTRACT-013 staging instance verbatim.
Full JWT verification of the Cloudflare Access header (CONTRACT-013 M8's
known, documented, deliberately deferred gap -- unrelated to this
contract's scope, not reopened here).

## Milestones

1. M1: conversation/message routes, `idea`-state project bootstrap,
   list-conversations store method.
2. M2: assistant replies, auto-routed through `AiGateway`.
3. M3: file upload route wired to the existing attachment state machine
   (structural validation tier).
4. M4: chat UI, replacing `FactoryControlPage`'s form.
5. M5: narrative brief -> proposal -> owner approval, in the UI.
6. M6: blueprint translation, feeding the existing generation pipeline
   unchanged.
7. M7: session management (rename/archive/search) and the project-grouped
   folder/collection view.
8. M8: end-to-end enforcement and negative tests (CSRF, axe, upload abuse,
   auth boundary).
9. M9: independent security review of the new surface (upload handling,
   assistant-reply injection/authority boundary), remediation.
10. M10: redeploy to the existing private staging instance, extend the
    owner acceptance checklist with real chat scenarios.
11. M11: repository-wide code quality cleanup (formatting +
    dead-code/duplication audit), the deliberate closing act before
    commit.
12. M12: evidence reconciliation, exactly one commit, and push.

## Gates

- A conversation can be created, chatted through to an assistant reply, and
  produce an owner-approved brief that generates a real blueprint --
  reachable from the dashboard, not just proven at the store/service level.
- File upload rejects oversized files, disallowed types, and
  path-traversal-shaped filenames -- fails closed, not just documented as a
  risk.
- An attacker-controlled message or attachment can never gain execution
  authority: every action still requires the existing proposal
  draft -> owner_review -> approved -> handed_off gate before anything
  reaches the generation pipeline. Re-verified against the real
  implementation this contract ships, not assumed from ADR-0002's design.
- `npm run format:check` passes with zero warnings repository-wide before
  M12's commit -- M11's file ownership extends to `**` for that milestone
  only, formatting changes only, no behavioral edits smuggled into the
  same commit (same pattern as CONTRACT-013 M11).
- Fresh migrations, locked install, full backend/dashboard/integration
  tests, build, `format:check`, `npm audit`, secret-pattern, scope, diff,
  and independent-review gates pass with zero skips.
- The redeployed private staging instance is healthy and reachable the
  same way CONTRACT-013 M9 established (SSH tunnel to loopback), and the
  owner acceptance checklist's new chat scenarios are runnable end-to-end
  without editing server files.

## Acceptance

- An owner can start a conversation from the dashboard without first
  filling in a blueprint form, chat until requirements feel settled, and
  see an assistant reply generated through the real DeepSeek -> Codex ->
  Claude routing -- not a stub.
- The conversation can produce a narrative brief, which the owner reviews
  and approves inside the conversation UI (not a separate disconnected
  form), and that approval is what unlocks translation into a real
  blueprint and a real queued generation task.
- File upload works for an allowed type/size, is rejected for a
  disallowed one, and rejected content never reaches the assistant's
  context unredacted.
- The owner can rename, archive, and search past conversations, grouped by
  project, from the dashboard.
- `npm run format:check` reports zero warnings across the entire
  repository.

## Rollback

Revert the commit. Conversation, message, attachment, and proposal rows
already created remain immutable and durable per their existing state
machines (unaffected by a code-level revert). If migration additions (new
`conversations` columns for archive state, or supporting indexes) need
reverting, drop only what this contract adds -- no destructive change to
the pre-existing CONTRACT-006 schema. The redeployed staging instance can
be stopped and the previous release symlink restored, matching the
stop/start procedure CONTRACT-013 M9 already proved live.

## File ownership

- `docs/contracts/CONTRACT-014/**`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/operations/**`
- `docs/security/**`
- `src/dashboard/**`
- `src/control-api/**`
- `src/orchestrator/**`
- `src/factory/**`
- `src/gateway/**`
- `src/policy/**`
- `src/operations/**`
- `src/config.ts`
- `src/deterministic-id.ts`
- `deploy/**`
- `.github/workflows/**`
- `migrations/**`
- `tests/**`
- `package.json`
- `package-lock.json`

M11 (code quality cleanup) is the sole, explicit, temporary exception: its
file ownership extends to `**` for formatting-only changes, reverting to
the list above for every other milestone.
