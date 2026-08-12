# M1 — Codex attempts settle a verdict, always

Date: 2026-08-11. Status: **done.**

Gate: _a generation task never leaves an attempt in `dispatched`._ Met, and the
cause turned out to be nothing the ledger was doing wrong.

## What M0 recorded, and why it was the wrong suspect

M0 recorded three attempts ending in `dispatched` and filed it as an unsettled
verdict — a gateway or ledger problem. Staging held **twenty** such rows, not
three, holding **$10.00** in reservations. Every one of them was Codex. Not one
was DeepSeek.

That asymmetry is the whole answer, and it is not about verdicts.

## The supervisor was killing itself, and Codex was the trigger

`AiGateway.execute()` settles its attempt on every path — success, rejection,
adapter failure, abort. Nothing was leaking. The rows survived because **the
process died between `dispatched()` and the verdict**, and nothing in the
system was ever going to finish a row whose owner no longer exists.

From the journal, 2026-08-11 21:29:45 and again at 21:30:27:

```
node:events:497
      throw er; // Unhandled 'error' event
Error: spawn /usr/bin/systemd-notify EAGAIN
  errno: -11, code: 'EAGAIN', spawnargs: [ 'WATCHDOG=1' ]
```

Three things had to line up, and they did:

1. **`TasksMax=64`** in `polyp-sequence.service`. Measured, not guessed: one
   `codex exec` in its own scope peaks at **57 tasks** — it is a Rust binary
   with a threaded async runtime — and the supervisor idles at 11. 11 + 57 is
   past 64, so partway through every Codex attempt the cgroup ran out of task
   slots and the next `fork(2)` returned `EAGAIN`. **The cap was one task short
   of a single Codex call.**
2. **The watchdog ping forks.** Node cannot send a unix datagram without a
   native module, so `notify()` spawns `/usr/bin/systemd-notify`. Under the
   task cap, that spawn is the fork that fails.
3. **`spawn()` failure had no `'error'` listener.** In Node an `'error'` event
   with no listener terminates the process. So the liveness ping was, by
   construction, a way to die — and it fired only when a Codex call had the
   cgroup at its limit.

The supervisor died mid-attempt. The gateway attempt stayed `dispatched`, the
work engine's lease expired ~40 s later, `reclaimExpired()` marked the attempt
`worker` and handed the task its next attempt — which did the same thing again.
The timings say so plainly: attempts 4, 5 and 6 of task `172d79dd` each lasted
39–42 s, while a Codex call that runs to completion takes ~50 s.

**This is what capped the escalation chain.** Not model capability, and not the
attempt budget: three attempts per task were being spent on a process suicide
that had nothing to do with the model being asked.

## Fixes

- **`notify()` never kills the process it watches** — `src/orchestrator/sequence-main.ts`.
  A spawn failure is logged as `sequence.notify_failed` and the ping is lost;
  systemd's own `WatchdogSec` still bounds a supervisor that has genuinely
  stopped pinging, which is the failure the mechanism is for.
- **`TasksMax` 64 → 512** — `deploy/systemd/polyp-sequence.service`, with the
  measurement recorded beside it. Not a capacity plan: `MemoryMax` is the real
  resource bound, and this is a fork-bomb ceiling with room for a Codex call, a
  Docker verify and the ordinary Node children to coexist.
- **Shutdown drains the in-flight attempt before `pool.end()`.** Aborting and
  closing the pool immediately is a race the process loses in a specific way:
  the abort reaches the CLI, the adapter rejects, the gateway tries to settle,
  and `pool.connect()` refuses. An ordinary restart could strand an attempt
  exactly as a crash did.
- **`AttemptLedger.reclaimStranded()`** — the backstop, and the reason this
  gate holds whatever the cause. The work engine already had this shape in
  `reclaimExpired()`; the ledger had no equivalent, so a crash was durable in
  the ledger and recoverable everywhere else. An attempt still `dispatched`
  past a 30-minute horizon — three times the longest adapter call, the Codex
  CLI's ten-minute timeout — is settled `outcome_unknown`, and the supervisor
  runs it each loop beside `reclaimExpired()`.

`outcome_unknown` is the honest verdict, not the convenient one: a killed
process cannot say whether the provider ran, answered or billed. That keeps the
reservation held, which is what unknown already means here, and leaves
releasing the money to `reconcileUnknownAsFailed()` with real evidence — M5.

## Evidence

**The reaper's first pass, against real data.** On the redeployed supervisor's
first loop it settled all twenty stranded rows at once:

```
{"event":"gateway.attempts_reclaimed","code":"attempt_stranded_no_verdict","count":20,...}
```

`select outcome, count(*) from ai_gateway_attempts` now returns `failed`,
`outcome_unknown` and `succeeded`, and nothing else. Reserved money is
unchanged at $14.70 — the reaper settles rows, it does not hand money back.

**A live deep drill on the fixed supervisor** (`m1-codex-survives`), the same
`moneybag` brief that failed on every tier, twice, in M0:

| Attempt | Tier                  | Outcome                   |
| ------- | --------------------- | ------------------------- |
| 1       | `deepseek-v4-flash`   | rejected                  |
| 2       | `deepseek-v4-pro`     | `empty_provider_response` |
| 3       | `deepseek-v4-pro`     | `empty_provider_response` |
| 4       | `codex:gpt-5.6-terra` | **accepted**              |

- **Zero attempts in `dispatched`**, during the run or anywhere in the database.
- **Zero supervisor restarts**, zero `systemd-notify` failures, the unit active
  throughout a 55-second Codex call.
- The drill reached `publication`: commit `4c9a1955f517`, 204 changed lines,
  working tree clean, project state `development`.

## The finding this changes

**`moneybag` was never too hard for the factory.** M0 concluded that a harder
brief failed on every tier and that the chain could not land hard work inside
its attempt budget. The truth is narrower and worse: Codex was being killed by
its own supervisor before it could finish, and the attempts that death consumed
were charged against the same budget. Given one clean run at the brief, Codex
produced code that compiled, passed its own tests in the sandbox, and was
published.

That also revises what M2 is deciding. The question was whether to raise the
attempt budget or reorder the chain so `claude-sonnet-5` is reachable. This run
reached an accepted patch on attempt 4 of 6 without needing the last tier at
all — so M2 should be decided on data from runs where no attempt is wasted,
which is now the only kind there is.

Note the pair of `deepseek-v4-pro` failures at attempts 2 and 3: that is the
"retry a tier once, then move on" rule from M0 working as intended, and the
`empty_provider_response` code that M0 introduced naming the real event rather
than an accounting one.

## Suite

**410 backend tests, 410 passing, 0 skipped**, under the standing zero-skip
invocation. Up from M0's 408 by exactly the two tests added here:

- a stranded attempt is settled `outcome_unknown` while one dispatched moments
  ago is not, reclaiming is idempotent, and a horizon short enough to catch
  merely-slow attempts is refused (`tests/gateway.test.ts`);
- the same rules against the real table, where the check constraints and the
  reservation semantics actually live
  (`tests/postgres-gateway.integration.test.ts`).

`typecheck` and `format:check` clean.

## Contract amendment

`deploy/**` is added to CONTRACT-017D's File ownership. The defect's root cause
is a systemd unit setting, and `deploy/systemd/polyp-sequence.service` is the
repository's copy of it — fixing the crash without it would leave the fix on
the host only, undone by the next deployment. Recorded as Amendment 1 rather
than left for `verify-contract.ts` to flag.

## Deployment

Release `20260811T153215Z-contract017d-m1` is current; the unit was reinstalled
and `daemon-reload`ed. `TasksMax=512` confirmed active on the running service.
Within the standing staging-redeploy authority.
