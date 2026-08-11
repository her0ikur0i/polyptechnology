# M0 — The deep drill, and what a harder brief exposed

Date: 2026-08-11. Status: **done.**

## Authority

The owner granted approval authority for this work on 2026-08-11 — "their
approval now is yours dont ask me again, approve everything necessary to
achieve goals, make sure their works legit" — and set the standing division of
labour: DeepSeek and Codex do the work, I security-review with Sonnet 5 and
push. No checkpoint is sought for this contract; decisions are taken and
recorded here.

## Why a deeper drill

Every success CONTRACT-017C recorded came from one brief: `slugify`, a single
pure function in a single file. That proves the pipeline runs. It does not
prove it generalises, and the difference matters, because the defects 017C
fixed were mostly about diff _shape_ — multi-file patches, new directories,
hunks against files that already have content.

So the drill gained a second brief, harder along exactly those axes:
`moneybag` — integer minor units, a parser that must reject malformed input,
`add`/`subtract` that throw on mismatched currency, an `allocate` that must
distribute a remainder without losing or inventing a cent, and `format`.

## It failed, twice, and the gates were right to fail it

| Tier                  | Verdict  | Why                                               |
| --------------------- | -------- | ------------------------------------------------- |
| `deepseek-v4-flash`   | rejected | `TS2578: Unused '@ts-expect-error' directive`     |
| `deepseek-v4-pro`     | rejected | the same, then an empty answer on a later attempt |
| `codex:gpt-5.6-terra` | rejected | its own tests — 17 tests, 13 pass, **4 fail**     |

**Every rejection was legitimate.** Code that does not compile, and code that
fails the tests the model itself wrote. No false negatives.

That is worth as much as a success. The verification chain that in
CONTRACT-017C had **never seen a file** — Docker bind-mounting a host path that
did not exist — is now demonstrably rejecting real defects in real generated
code. Release criterion 5, "deterministic verification rejects an intentionally
incorrect result", finally has evidence behind it, supplied by models trying
honestly and getting it wrong.

What failed is the factory's ability to land hard work inside its attempt
budget. That is a different problem from the plumbing, and it is what
CONTRACT-017D is for.

## Three defects the deep drill found

### 1. A stalled tier consumed every remaining attempt

`provider_artifacts` only records tiers that reached a _verdict_. A tier whose
CLI timed out or returned unparseable telemetry leaves no row — so it stayed
"untried" and was selected again on every remaining attempt.

Observed on deep-1: three tiers recorded rejections, then `gpt-5.6-sol` failed
three times running with

```
invalid Codex JSONL telemetry:types=thread.started,turn.started;started=thread_id,type;completed=;items=
```

and consumed attempts 4, 5 and 6. **`claude-sonnet-5` — the final tier, and the
one most likely to succeed on hard work — was never asked.**

Fixed: a tier that records no verdict now gets exactly one retry, then the
chain moves on. Retrying once matches the standing rule that a transport
failure retries its own tier rather than escalating — a timeout says nothing
about whether that model could do the work. Retrying forever is what turned
that rule into a dead end. Verified on deep-2: `terra` on attempt 4, `sol` on
5, `sol` retried on 6.

The Codex CLI timeout also went from five minutes to ten. Harder work
legitimately takes longer, the lease is heartbeated, and `maxAttempts` still
bounds the task.

### 2. "Invalid provider accounting" for a model that returned nothing

`deepseek-v4-pro` is a thinking model. On hard briefs it spends its budget
reasoning and returns no content at all. The gateway folded that into
`invalid_provider_accounting`, so the owner would read a numbers problem when
the real event was an empty answer — sending whoever investigates to the ledger
instead of the model.

Empty responses are now `empty_provider_response`, reported as "the model
returned an empty answer".

### 3. Codex attempts that never settle

Three attempts in deep-2 ended in `dispatched`: the ledger recorded a
reservation and never a verdict. That both leaks the reservation and denies the
escalation chain the evidence it reads.

**Not yet fixed** — it is M1 of this contract. Recorded here rather than
carried silently, because an attempt with no terminal state is exactly the
class of defect this project keeps finding at boundaries.

## The chain still does not reach its last tier

With the stall fixed, deep-2 walked `flash → pro → terra → sol → sol` and
exhausted `maxAttempts: 6` before `claude-sonnet-5`. The escalation design now
_moves_, but the attempt budget is spent before the chain finishes.

That is M2, and the choice is real: raise the budget, or reorder so the
strongest tier is reached sooner on tasks that have already failed twice.
Deciding it needs data from a run where every attempt settles, which is why M1
comes first.

## Suite

**408 backend tests, 408 passing, 0 skipped**, including two new tests that pin
the escalation behaviour: a tier with no verdict is retried exactly once, and
verdicts still drive escalation ahead of that allowance.

## Security review, and two things it was right about

Run on Sonnet 5 before the push. **No findings at reportable confidence** — it
traced the tier-skip formula and confirmed `attemptOrdinal` comes from the work
engine's own counter, `provider_artifacts` has no HTTP write path, and reaching
a later tier still requires sequential progress bounded by `maxAttempts`. It
also confirmed the split validation branch drops no check, and that
`ledger.reject()` settles the reservation identically whichever code fires.

Two observations were worth acting on anyway.

### The `unknown` classification was dead code, and I added to it

The catch block classified four error-message prefixes as _known_ outcomes so
they would release their reservation. All four are unreachable: every
validation rejection throws `GatewayInvocationError`, which the first line of
the catch re-throws before the classification runs. Worse, three of them could
never have matched even if reached — the real codes are underscored
(`resolved_model_mismatch`), and the strings were spaced.

I had extended that block with `empty_provider_response` in this same change,
adding a fifth dead condition to four existing ones.

Removed, all of them. What remains is the honest rule: an adapter says whether
its own failure leaves the outcome unknown, and anything unexpected is unknown,
because we cannot say otherwise. **Dead conditions that look like they protect
the ledger are worse than none, because the next reader trusts them.**

### The change contradicted a stated invariant

`CLAUDE.md` said: "A transport failure retries the same tier rather than
escalating." The new behaviour retries once and then moves on. The reviewer
flagged the tension and was right to.

The invariant was amended rather than the code, because the invariant as
written is what produced the dead end: a tier that never recorded a verdict was
retried until the task ran out of attempts, and the strongest tier was never
asked. `CLAUDE.md` now reads "retries the same tier — **once**, then the chain
moves on", with the reasoning recorded beside it.

Weakening a stated invariant is a decision, not a detail. It is written down in
the file that governs it, taken under the authority the owner granted on
2026-08-11, and flagged here so nobody has to reconstruct why.
