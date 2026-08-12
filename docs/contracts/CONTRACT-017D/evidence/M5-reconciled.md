# M5 — stale reservations reconciled with real evidence

Date: 2026-08-12. Status: **done.**

Gate: this milestone had no gate of its own in the contract's Gates list; its
job was closing the scope item "The stale reservations" without inventing an
evidence SHA to do it.

## What was stale

37 attempts sat in `outcome_unknown` on `polyp-staging-pg`, holding $15.20 in
permanent reservations — the original ~$11.70 from before CONTRACT-017C's
classification fix, plus $0.50 from M1's `reclaimStranded()` sweep (twenty
Codex attempts stranded when the old `TasksMax=64` killed the supervisor),
plus $0.50 from M2's own first (corrupted) drill run.

## The evidence

`docs/contracts/CONTRACT-017D/evidence/M5-stranded-attempts-2026-08-12.md` is
a frozen record, written and formatted before any reconciliation ran: the
exact query, the full list of 36 attempts (id, provider, model, reserved
amount, task, timestamp), and the argument for why
`provider_request_id IS NULL` is sufficient evidence on its own —
`provider_request_id` is assigned only once a provider has actually accepted
a request (CONTRACT-017A), so its absence means no provider ever saw these
36 requests, structurally, not by inference. **One attempt is excluded**:
`e9436790-09ee-4dbc-bf23-a6166ba4abf4` has a `provider_request_id` set and
needs a real check against Anthropic's own usage record, which this evidence
cannot supply — `reconcileUnknownAsFailed()` already refuses to touch it for
exactly that reason. It stays `outcome_unknown`, holding its $0.20.

The evidence file's own SHA256 —
`5b67851c696b08e980159cb61b0e1decd8ad100afb5deb06c15034d556da2e5c` — is what
every one of the 36 `ai_attempt_reconciliations` rows below points at.
Anyone can re-hash the file and confirm it matches; nothing was invented to
satisfy the script's format check.

## What ran

All 36 attempts reconciled through
`PostgresAttemptLedger.reconcileUnknownAsFailed()` (the same method
`scripts/reconcile-provider-attempt.ts` calls, driven directly to cover all
36 in one pass rather than 36 separate process invocations), reason
`CONTRACT-017D-M5-stranded-before-provider-dispatch`, all pointing at the
evidence SHA above. **36 of 36 succeeded**, no partial failures.

## Result, verified against the ledger afterward

|                                   | Before | After                    |
| --------------------------------- | ------ | ------------------------ |
| total reserved (all scopes)       | $15.20 | **$0.20**                |
| `outcome_unknown` rows            | 37     | **1** (the excluded one) |
| `ai_attempt_reconciliations` rows | 0      | **36**                   |

$15.00 in permanently stuck reservations released back to their scopes'
available budget. Nothing was marked spent — these attempts never reached a
provider, so `failed_no_charge` is the literal truth, not a rounding
convenience.
