# M5 — Runtime response validation at the dashboard API boundary

Date: 2026-08-10. Status: **done**.

## The problem

`src/dashboard/api.ts` exposed 26 exported async functions that fetch from
the Control API. Only one, `loadDashboardSnapshot()`, ran its response
through a real validator (`parseDashboardSnapshot`). Every other function
either returned `response.json()` directly (typed only by the function's
return-type annotation, never checked) or forced the shape through with an
unchecked `as` cast. A server-side response shape change would reach React
as a malformed object -- a render crash or blank screen -- instead of a
handled error surfaced through `DashboardApiError` /
`src/dashboard/use-snapshot.ts`'s existing error branching.

## Approach

Extended the existing hand-rolled idiom in `src/dashboard/validation.ts`
rather than adopting a schema library (zod/yup/io-ts/valibot) -- an
already-settled decision: this file already solves the problem in this
codebase with tests, a second paradigm alongside it would be worse than
either alone, and the dashboard bundle must not grow.

Every new shape follows `parseDashboardSnapshot`'s own pattern: a private
`value is T` predicate does the checking, and a thin exported `parseX()`
throws a specific `Error` or returns the narrowed value. Where a shape is
consumed as a single object in one place and as a list element in another
(`ConversationSummary`, `ConversationMessage`, `ConversationAttachment`),
one private predicate backs both `parseX()` and `parseXList()`, the latter
through a new small `arrayOf()` helper -- the same
`Array.isArray(x) && x.every(guard)` idiom `parseDashboardSnapshot` already
used inline for `attempts`, now named and reused. A new `optionalString()`
helper covers the "absent or string, never `null`" shape shared by
`archivedAt`, `classification`, and `approvalId` (the Postgres row mappers
in `src/orchestrator/postgres-store.ts` already collapse SQL `NULL` into
"key omitted" before any response reaches this file, confirmed by reading
`conversation()`/`attachment()`/`proposal()` row mappers).

**Enums are enforced only where the corresponding `api.ts`/`types.ts` type
is itself a union** (e.g. `ConversationMessage["role"]`). Where a field is
typed as plain `string` (`ConversationProposal["state"]`,
`PolicyStateResult["state"]`, `ConversationAttachment["state"]`), the
validator leaves it open too -- deliberately, so this file never enforces a
stricter contract than the one the type already promises. Inventing a
tighter check than the type declares would risk rejecting a legitimately
server-sent value the client type already permits.

`commandRequest()` (the shared private POST helper backing 17 of the 26
functions) gained a fourth, mandatory parameter: `parse: (value: unknown) =>
T`. Making it mandatory rather than optional means a future call site
cannot compile without wiring a validator -- structurally closing off the
exact gap this milestone found (a call site nobody remembered to check).
`T` is now inferred from `parse`'s return type, so call sites dropped their
explicit `commandRequest<{...}>` type arguments in favor of passing the
validator function itself; the inline anonymous types that used to live at
each call site now live once, in `validation.ts`.

No function's public signature or return type changed. Every parser's
returned shape was written to structurally match the exact inline type (or
named interface) the function already declared or relied on inference for,
so every existing caller in `conversation-workspace.tsx`, `policy-control.tsx`,
and `app.tsx` still type-checks unmodified.

## What now validates

All 26 exported functions in `src/dashboard/api.ts` run their parsed
response through a real validator; none are left on an unchecked cast:

- `loadDashboardSnapshot` -- unchanged, already used `parseDashboardSnapshot`.
- `saveTelegramSettings` -- `parseTelegramSettings` (reuses the existing
  private `telegram` predicate `parseDashboardSnapshot` already used for the
  embedded snapshot field, so a saved-settings response and a snapshot's
  embedded Telegram data are held to the identical contract).
- `createFactoryProject` -- `parseFactoryProjectResult`.
- `generateProject` -- `parseGenerationTaskResult`.
- `createConversationProposal` -- `parseProposalCreationResult`.
- `draftProposal` -- `parseProposalDraftResult`.
- `approveProposal` -- `parseProposalApprovalResult`.
- `rejectProposal`, `getProposal` -- `parseConversationProposal`.
- `translateProposal` -- `parseTranslationTaskResult`.
- `startConversation` -- `parseConversationStartResult`.
- `sendConversationMessage` -- `parseSendMessageResult` (validates the
  nested `ConversationMessage` too, not just the envelope).
- `listConversationMessages` -- `parseConversationMessageList`.
- `renameConversation`, `setConversationArchived` -- `parseConversationSummary`.
- `listProjectConversations` -- `parseConversationSummaryList`.
- `getReplyTaskStatus` -- `parseReplyTaskStatus`.
- `uploadConversationAttachment` -- `parseConversationAttachment`.
- `listConversationAttachments` -- `parseConversationAttachmentList`.
- `createPolicyDraft`, `validatePolicyDraft`, `approvePolicyDraft`,
  `activatePolicyDraft`, `rollbackPolicy` -- `parsePolicyStateResult` (one
  validator, five call sites: every step of the lifecycle in
  `src/policy/owner-policy-service.ts` returns the same `{id, version,
state}` projection).
- `createCodexOverride` -- `parseCodexOverrideResult`.
- `loadActivePolicy` -- `parseActivePolicy`.

Nothing was deliberately left unvalidated. `uploadConversationAttachment`'s
existing _error_-body parsing (extracting `{error: string}` from a non-2xx
response) was left as its pre-existing hand-rolled inline check -- it is
error-path plumbing already doing its own type narrowing, not a case of an
unchecked success-path cast, and touching it was outside this milestone's
"responses reach React as unchecked casts" defect.

## Response-shape audit against `src/dashboard/types.ts` / `api.ts`

Traced every one of the 26 functions to its Control API route
(`src/control-api/app.ts`) and from there to the service/store method that
actually builds the response body (`src/operations/owner-commands.ts`,
`src/orchestrator/service.ts`, `src/policy/owner-policy-service.ts`,
`src/factory/generation-task.ts`, `src/factory/blueprint-translation-task.ts`,
`src/control-api/attachment-upload.ts`, `src/orchestrator/postgres-store.ts`).
**No genuine shape mismatch was found** -- every field the client type
declares is actually sent by the server, with the correct primitive type,
on every path checked. Two things worth recording rather than silently
smoothing over:

1. **`GET /api/v1/policy/:policyKey/active` sends more than the client type
   declares.** The route does `res.json(active)` on the full `StoredPolicy`
   row (`policyKey`, `policySha256`, `emergencyCostCeilingUsdMicros`,
   `creatorId`, `validatorId`, `approverId`, `activatorId`, `createdAt`,
   `validatedAt`, `approvedAt`, `activatedAt`, `supersededAt`), while
   `loadActivePolicy()`'s declared return type -- and `parseActivePolicy` --
   only require `{id, version, state, policy}`. This is harmless (extra
   fields are simply ignored) and pre-dates this milestone; not a defect,
   but flagged since it's the kind of shape gap this milestone is about.
2. **A stale test fixture, not a server/type mismatch.** The pre-existing
   `tests/dashboard/api.test.ts` mocked `PUT /api/v1/settings/telegram`'s
   response without a `webhookRegistered` field. The real route
   (`src/control-api/app.ts`) always includes it -- `TelegramSettings`
   correctly declares it required and the live server always sends it; only
   the test's mock fixture had drifted. Adding validation to
   `saveTelegramSettings()` surfaced this immediately (the previously-unchecked
   `as` cast had been silently masking it). Fixed by adding the field to the
   fixture, matching the real route -- not by loosening the validator.

## Tests

`tests/dashboard/validation.test.ts` grew from 2 tests to 20, each new
parser covered by at least one accepted realistic payload and one rejected
payload per distinct failure mode it guards (missing field, wrong
primitive type, unexpected enum value, non-array where an array is
required, an optional field present but mistyped, a non-finite number
where `finite()` -- not just `typeof`-- is what actually guards it, and,
for list parsers, one bad element among otherwise-valid ones to prove
`.every()` runs over the whole array and not just the first element).
`tests/dashboard/api.test.ts`'s one affected fixture was corrected (see
above); its assertions are unchanged.

## Verification

All run from `/root/polyptechnology-next`.

```
$ npm run typecheck
> tsc --noEmit
(clean, zero errors)
```

```
$ npm run dashboard:test
> vitest run
 Test Files  5 passed (5)
      Tests  38 passed (38)
```

38 = 20 baseline (CONTRACT-014) + 18 new, all in `validation.test.ts`
(2 -> 20 tests in that file; the other 4 files are unchanged in count).

```
$ npx prettier --check src/dashboard/ tests/dashboard/
Checking formatting...
All matched files use Prettier code style!
```

(One file, `src/dashboard/validation.ts`, needed `prettier --write` after
editing -- a single generic-parameter trailing-comma normalization,
`<T,>` -> `<T>`, safe in a `.ts` file with no JSX ambiguity. Re-ran
typecheck and the dashboard suite after; both still clean.)

```
$ TEST_DATABASE_URL=postgresql://postgres:contract011test@127.0.0.1:55433/polyp_test \
  node --import tsx --test tests/dashboard/validation.test.ts
TypeError: Cannot read properties of undefined (reading 'config')
  at initSuite (.../@vitest/runner/dist/chunk-artifact.js:1848:23)
# tests 1, pass 0, fail 1
```

Does not apply, as anticipated: this suite uses vitest's `describe`/`it`/
`expect`, which need vitest's own runner context (`runner.config`) that a
bare `node --test` process never initializes -- it isn't a regression in
the code under test, it's the wrong harness for a vitest file. `npm run
dashboard:test` (above) is the authoritative run for this suite.

Backend regression check, since none of `src/control-api/**` or any other
server directory was touched (confirmed nothing under `src/` outside
`src/dashboard/**` imports `dashboard/api.js` or `dashboard/validation.js`):

Re-run at review time with the **standing zero-skip invocation** from
`CLAUDE.md`, because the first run of this check omitted `TEST_WORKER_IMAGE`
and therefore silently skipped the Docker-gated suite:

```
# tests 187
# pass 187
# fail 0
# skipped 0
```

This matches the CONTRACT-015 M4 baseline exactly, as expected for a
client-boundary-only milestone.

The original run recorded here reported `187 tests, 186 pass, 1 skipped` and
described that as matching the M4 baseline. It did not: M4's baseline was
`0 skipped`. The difference was entirely the missing `TEST_WORKER_IMAGE`, not
a regression — but a skipped Docker suite reported as an exact match is the
precise failure mode `CLAUDE.md` now warns about, so the correction is recorded
rather than quietly overwritten.

## Files touched

- `src/dashboard/validation.ts` -- 16 new exported parsers (plus their
  private predicates and the `optionalString`/`arrayOf` helpers), the
  original `parseDashboardSnapshot` and its helpers untouched.
- `src/dashboard/api.ts` -- every direct-fetch function now parses its
  response; `commandRequest()` takes a mandatory `parse` argument; all 17
  call sites updated. No signature or return type changed anywhere.
- `tests/dashboard/validation.test.ts` -- 18 new tests across 6 new
  `describe` blocks.
- `tests/dashboard/api.test.ts` -- one stale fixture corrected (see above).
