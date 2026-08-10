# M4 — Wire the policy canary into validation

Date: 2026-08-09. Status: **done**.

## The problem

`scripts/policy-canary.ts` exercises every `(provider, requestedModelId)` pair
in the current routing table against real providers and checks each one returns
the expected literal. It is the only check that catches an adapter or
envelope-parsing bug — the CONTRACT-011 Claude CLI envelope incident is exactly
what it exists for.

It had **zero references from `src/`**. The only thing making anyone run it was
a sentence in `docs/RESUME.md` telling the operator to remember. A safety check
that depends on operator memory is not a safety check.

## Why the canary is not called from `validate()`

The literal reading of the milestone would have `PostgresPolicyStore.validate()`
invoke the canary. That is the wrong layering, and would have been worse than
the gap: a repository method would perform network I/O, call third-party
providers, and spend real money as a side effect of a database transaction. It
would also make validation impossible in any environment without live provider
credentials, including CI.

Instead the two halves are separated:

- **The canary records durable evidence.** `recordCanaryEvidence()` writes a
  `canary_passed` event to `policy_events` — already immutable, already
  foreign-keyed to `(policy_key, policy_version)`, already carrying a `jsonb`
  payload. **No migration and no schema change**, so this contract's stated
  rollback position holds unchanged.
- **`validate()` demands that evidence.** It queries for a passing record and
  refuses the transition without one.

The result is the same gate the milestone wanted — an unproven
`MODEL_POLICY_VERSION` cannot be activated — without a database method that
bills a credit card.

## Fail-closed in four independent ways

1. **No evidence, no validation.** `validate()` refuses with "Policy validation
   requires a passing canary for this policy content", and the draft stays a
   draft.
2. **An empty canary proves nothing** and is refused at record time rather than
   stored as a vacuous pass.
3. **A partial pass cannot be laundered.** If any route failed, the whole batch
   is refused; there is no way to record "most of it worked".
4. **Evidence is bound to `policy_sha256`, not to `(key, version)`.** A draft
   can be edited in place, so proof gathered against earlier content does not
   carry over to content that has since changed.

A fifth guard sits in the script: a provider-filtered run (`argv[2]`, e.g. only
`deepseek`) **refuses to record**, because validation requires that every
registered route passed, and a filtered run cannot show that.

## What the operator does now

```
POLICY_ID=<draft id> POLICY_VERSION=<n> \
TEST_DATABASE_URL=… node --import tsx scripts/policy-canary.ts
```

then validate through the dashboard or `POST /api/v1/policy/validate`. Running
the script with no `POLICY_ID` still works as a bare connectivity check and
says so, rather than silently recording nothing.

`docs/RESUME.md`'s known-issue entry — "not yet wired into
`PostgresPolicyStore.validate()`. Run it by hand" — was corrected in place; it
had become false the moment this landed.

## Verification

`tests/policy-postgres.integration.test.ts` grew from 2 tests to 4:

- **validation fails closed without passing canary evidence** — a structurally
  valid draft is refused (proving it is the canary gate and not the structural
  validator), an empty result set is refused, a 1-of-2 partial pass is refused,
  the draft is still refused after both failed attempts (neither wrote
  anything), and validation succeeds once real evidence exists.
- **canary evidence does not carry across policy contents** — evidence recorded
  for one policy does not admit a different one.

The two pre-existing lifecycle tests now record evidence before validating,
which is the honest change: the lifecycle genuinely has one more mandatory step
than it did.

`tests/control-api.integration.test.ts`'s full HTTP lifecycle records evidence
directly rather than calling real providers — the test covers the HTTP
lifecycle and must not spend money.

Full backend suite, standing zero-skip invocation:

```
# tests 187
# pass 187
# fail 0
# skipped 0
# duration_ms 45564.8
```

187 = 185 after M3 + 2 new. `npm run typecheck` clean.

One real behavioural regression was caught by the suite during this milestone
and fixed rather than worked around: the Control API's full policy lifecycle
test began failing the moment the gate landed, which is exactly what should
happen when a mandatory step is added to a lifecycle.
