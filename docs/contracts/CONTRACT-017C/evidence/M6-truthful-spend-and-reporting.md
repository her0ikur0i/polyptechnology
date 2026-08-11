# M6 — The budget was measuring imaginary money

Date: 2026-08-11. Status: **done.** The contract's closing milestone: the deep drill ran clean twice, spend is reported truthfully, and the documents are updated.

Every finding here came from the owner reading their own Telegram transcript
and checking it against the providers' dashboards. None of it was visible from
inside the system, because the system was internally consistent and wrong.

## The discrepancy

The owner's report: DeepSeek billed **$0.03** today across **29 API requests
and 56,586 tokens**. Claude and Codex are on subscription plans, so their
dashboards show no per-call spend at all.

The ledger, queried against the same period:

| Provider | Calls | Tokens  | Ledger said | Actually billed            |
| -------- | ----- | ------- | ----------- | -------------------------- |
| claude   | 62    | 41,650  | **$2.4233** | **$0** — subscription      |
| deepseek | 24    | 50,841  | $0.0282     | $0.03 (29 req, 56,586 tok) |
| codex    | 9     | 132,777 | $0.0000     | $0 — subscription          |

**DeepSeek's accounting is essentially exact** — the difference is my own
direct probes, which bypass the ledger by design. **97% of this system's
reported spend was money nobody was ever charged.**

## Why

Claude is reached through its CLI on `CLAUDE_CODE_OAUTH_TOKEN`, a subscription.
The CLI nonetheless reports `costUSD` per call: what those tokens _would_ cost
on metered API pricing. `ClaudeCliAdapter` read that field and the gateway
banked it as spend.

Codex, on a ChatGPT plan, reports zero and was right the whole time. The
inconsistency between the two CLIs is what made this invisible: one provider
looked expensive, one looked free, and neither looked wrong.

**A budget counting imaginary dollars is worse than no budget.** The owner's
own transcript shows it doing real damage:

```
❌ Patch failed · after 6 attempts
   gateway budget unavailable or exhausted
   deepseek-v4-pro · $0.0034
   📊 ███████░░░ 75% · $0.4963 left of $2.00 · $1.50 reserved
```

A run that had spent **a third of a cent** was refused for exhausting a $2.00
budget. Meanwhile fourteen blueprint translations each reported `$0.0852`and`9% · $0.9148 left of $1.00` — a scope that would have blocked after roughly
eleven translations, all of it fictional.

## The fix

`src/gateway/provider-billing.ts` records how each provider actually charges.
`withTruthfulCost()` zeroes the notional dollar figure for subscription
providers and **keeps every token count**, because tokens are the real signal
there — they are what a plan's usage limits are spent against.

Unknown providers are assumed metered: assuming a new provider bills per token
makes the budget stricter rather than blind, which is the safe direction.

Verified live on drill-15:

```
claude    2 calls   $0.0000     (was $0.0852 per translation)
deepseek  1 call    $0.0002     (real, metered)
```

## Three reporting defects in the same transcript

### 1. A report that contradicted itself

```
❌ Patch failed
   the run failed before producing output
   patch failed to apply cleanly: error: corrupt patch at line 76
```

A patch that failed to apply **is** output. `invalid_output` is a catch-all for
every throw from every driver, including throws that happen long after a
provider answered — so the sentence claimed knowledge the catch-all does not
have.

This is the second time this exact line has been wrong. CONTRACT-017B replaced
"provider returned unusable output" because it accused the provider on runs
where none was called; the replacement made a quieter version of the same
mistake. It now says only "the run failed", and the carried error says what
happened. The test asserts both wordings are absent, so there is no third
attempt at guessing.

### 2. Fourteen reports, all named "Untitled project"

`attachBlueprintVersion` updated the blueprint pointer and never touched
`display_name`, so a project kept its placeholder name for life — even after
the factory had derived "Slugify" for it. Naming work in human terms is a
standing rule from CONTRACT-017B, and it cannot be met by a surface reading a
column nothing ever fills in.

The project now adopts the blueprint's display name. `slug` deliberately stays
as created: `repository_ref`, `workspace_ref`, `database_namespace` and
`budget_scope` were all derived from it and are identity rather than label —
renaming those would desync a workspace that already exists on disk.

Verified: the newest project reads `Slugify`, where every earlier one reads
`Untitled project`.

### 3. Escalation is invisible

Not yet fixed, and worth naming. A failure reports one model:

```
❌ Patch failed · after 6 attempts
   🤖 deepseek-v4-pro · deepseek
```

while the run actually walked `deepseek-v4-flash → deepseek-v4-pro →
codex:gpt-5.6-terra → codex:gpt-5.6-sol`. The owner cannot see the escalation
chain working, which is the single most interesting thing the run did. The
data exists in `provider_artifacts`; only the report is thin.

## What the transcript proves that the drills could not

The last four entries are the pipeline working, unattended, on the owner's
phone:

```
✅ Patch succeeded · after 4 attempts · deepseek-v4-pro
✅ Patch succeeded · deepseek-v4-flash · $0.0002
✅ Patch succeeded · deepseek-v4-flash · $0.0002
```

Two of those accepted on the first, cheapest tier; one needed four attempts and
escalated to the reasoning model. That is the execution policy behaving as
written, observed from outside the system rather than asserted by it.

## Gates

**406 backend tests, 406 passing, 0 skipped.** Two existing tests asserted the
behaviour this milestone corrected — one expected the contradictory failure
text, one asserted `costUsdMicros > 0` on a Claude call and so was passing on
money nobody was charged. Both now assert the truthful behaviour, with the
reasoning recorded in place.

## The owner's phone confirms both fixes

```
✅ Blueprint translation succeeded
Slugify
🤖 claude-sonnet-5 · claude
💰 $0.00
📊 ░░░░░░░░░░ 0% · $1.00 left of $1.00
```

The project has its real name and the subscription provider costs nothing.
Confirmed where it matters — on the surface the owner actually reads, not in a
query I wrote.

## The final deep drill

Two complete runs, back to back, on the deployed release.

|               | final-a             | final-b             |
| ------------- | ------------------- | ------------------- |
| Stages passed | 9 of 9              | 9 of 9              |
| Accepted by   | `deepseek-v4-flash` | `deepseek-v4-flash` |
| Changed lines | 26                  | 36                  |
| Commit        | `0d646b531db2`      | `3310fe3f85f1`      |
| Working tree  | clean               | clean               |
| Project state | `development`       | `development`       |

Both accepted on the **first and cheapest tier**, with no escalation needed —
which is what the execution policy is for. Neither run was a repeat of the
other: different implementations, different test counts, both correct.

### Verified independently, and the harness was wrong before the code was

Each project was checked outside the pipeline: `typecheck`, `format:check` and
`npm test` run directly, git history inspected, and ten behaviour cases the
models never saw.

The first pass reported a mismatch in **both** projects:

```
MISMATCH "ABC123!@#def" got "abc123-def" want "abc123def"
```

**My expectation was wrong.** The requirement says runs of non-alphanumeric
characters become _a single hyphen_; `!@#` is such a run, so `abc123-def` is
correct and `abc123def` was my error. Recorded because the reflex on seeing two
independent models "fail" the same case should be to doubt the case — and
because a verification harness that is wrong in the generous direction would
have passed bad code just as confidently.

With the expectation corrected: **10 of 10 cases pass in both projects.**

| Check                                 | final-a   | final-b   |
| ------------------------------------- | --------- | --------- |
| `typecheck` / `format:check` / `test` | OK        | OK        |
| Tests shipped by the factory          | 6 passing | 5 passing |
| Independent behaviour cases           | 10/10     | 10/10     |

## Spend, truthfully

The whole deep drill — two full end-to-end generations — cost **$0.0007**.

| Provider | Calls | Tokens | Cost                 |
| -------- | ----- | ------ | -------------------- |
| deepseek | 3     | 3,406  | $0.0007              |
| claude   | 6     | 2,797  | $0.00 (subscription) |

The all-time ledger still shows `claude $2.4233`. That is historical and is
**not** being rewritten: the audit tables are immutable by trigger, and
retroactively editing a ledger to make a past number look better is the
opposite of what a ledger is for. Every call recorded from this release
forward is truthful; the old rows stay as evidence of the defect.
