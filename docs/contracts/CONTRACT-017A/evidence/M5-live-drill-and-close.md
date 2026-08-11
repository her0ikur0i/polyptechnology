# M5 — The drill, and the defect it found

Date: 2026-08-11. Status: **done**.

## The result

|                         | fresh input tokens per turn |
| ----------------------- | --------------------------- |
| cold start (no session) | 2,458 – 2,567               |
| resumed turn            | **2**                       |

Measured from `ai_usage_events`, not asserted. `last_used_at > created_at` on
the session row, so the same session was genuinely reused rather than replaced,
and the stored id stayed constant across turns where it had previously changed
on every one.

That is the contract's objective met: a long conversation now costs
approximately what a short one costs per turn.

## What the first drill actually proved

It failed, and finding out why is the most valuable thing in this contract.

The numbers came back **wrong in a way that looked like nothing had happened**:
turn two sent _more_ input tokens than turn one, the stored session id changed
on every turn, and `created_at` was always fresh. Every unit test passed.

The supervisor log — added in CONTRACT-017B, for exactly this reason — held the
answer in one line:

```
duplicate key value violates unique constraint
  "ai_usage_events_provider_request_id_resolved_model_id_key"
```

**`provider_request_id` stops being a unique call identifier the moment
sessions are resumed.** The Claude CLI returns one `session_id` per
_conversation_, and this system stores it as `provider_request_id`. That was
harmless while every turn started a fresh session: one call, one id. Two schema
constraints — a unique on `ai_usage_events (provider_request_id,
resolved_model_id)` and a unique on `ai_gateway_attempts (provider_request_id)`
— encoded that assumption.

So the first genuinely resumed turn was rejected by the ledger. The driver
caught the failure, treated it as an expired session, dropped the row, and the
retry cold-started successfully. **The system silently degraded to exactly its
old behaviour** while reporting success to the owner: a correct answer, a fresh
session, and no continuity whatsoever.

Worth naming, because it is the shape of the worst kind of bug: every layer
behaved reasonably, the owner saw a correct answer, and the feature did not
work at all.

## Migration 0017

Both constraints dropped. Per-call identity is `ai_gateway_attempts.id`, and
usage is already keyed primarily on `(attempt_id, resolved_model_id)` — the
real uniqueness, untouched. Indexes are kept, because "what did this session
cost in total" is a real question and the constraints were also serving as its
index.

The one honest cost: the dropped constraints were a guard against recording the
same provider response twice under two attempts. The primary key still prevents
it per attempt; across attempts it is now possible in principle. That is the
correct trade — a resumed session legitimately produces many usage rows with
one session id, so the constraint was forbidding valid data.

## My own fallback made the bug invisible

The resume-failure path drops the session unconditionally rather than
pattern-matching provider error strings. That decision is defended in M2's
evidence and I still think it is right — but here it converted a hard,
diagnosable schema error into a silent, self-healing degradation.

Both properties are worth keeping and they pull against each other. The
resolution is not to make the fallback cleverer, which is how error-string
guessing gets reintroduced; it is that the supervisor now **logs the real
error**, which is the only reason this was found in one log line rather than a
database archaeology session.

## Gates

| Gate                                 | Result                                |
| ------------------------------------ | ------------------------------------- |
| Backend suite, zero-skip invocation  | **371 tests, 371 passing, 0 skipped** |
| Second turn sends fewer input tokens | 2,567 → 2, from the ledger            |
| Session survives across turns        | `last_used_at > created_at`           |
| Migrations 0016 and 0017 on staging  | applied and verified                  |

Spend for the drills: roughly $0.30 across five real turns.
