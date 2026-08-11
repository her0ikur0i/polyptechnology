# CONTRACT-017B — Truthful reporting and a real backoff

## Objective

Make the Telegram control surface tell the owner the truth, briefly.

CONTRACT-017 delivered the surface and the owner used it for a day. Reading
their own transcript found four defects that no test and no database query had
surfaced, because each one is only visible as _a message a person reads on a
phone_:

- three doomed tasks produced six messages in ten seconds, most lines carrying
  no information;
- every failure was attributed to "provider returned unusable output" when no
  provider had been called at all;
- the same budget scope read 6% in a run report and 18% in `/budget`;
- tasks are identified by uuid, which is unreadable and unmemorable.

Underneath the noise, one of those messages exposed a real behavioural defect:
all three retries burned in **two seconds**, because the retry delay is a
hardcoded flat 1,000 ms. CONTRACT-017's retry sweep made retries happen for the
first time, which is what made the useless backoff visible.

## M0 — Owner confirmation (2026-08-11)

Every question this contract needed was put to the owner before any work
started, together with the questions for CONTRACT-017A and CONTRACT-018, so the
three run unattended. Decisions:

1. **Task naming: type plus what it is about, no uuid.** "Chat reply" and the
   owner's own question, not `47a0ed46`. The id appears only where it is needed
   to act on something.
2. **Terminal outcomes only.** Report success and final failure. An
   intermediate retry is not a decision and cannot be acted on, so it is
   silent. Drop any line whose value is zero or unchanged.
3. **Chained delivery.** On a successful push, continue to CONTRACT-017A and
   then CONTRACT-018 without pausing.

Standing rules confirmed the same day, applying from here on:

- `/security-review` runs **before** the push, not after; anything it finds is
  fixed first.
- `README.md` is updated as part of closing every contract.
- Commits are authored `heroikuroi <heroikuroi@gmail.com>`, Claude
  `Co-Authored-By`. Already-pushed history is not rewritten.
- The standing authority from CONTRACT-015 M0 still covers staging redeploys,
  live drills that spend real money, and the commit and push. It still excludes
  DNS, public exposure, secrets, production promotion, and
  `polyptech-dashboard.service`.

## Scope

- **A real retry delay.** Exponential by attempt ordinal, capped, replacing the
  flat 1,000 ms — so a transient provider failure is still retryable a minute
  later instead of having spent every attempt inside two seconds.
- **Failure reports that name what actually failed.** The supervisor knows the
  error; it currently throws it away and substitutes a guess about the
  provider. A report must not claim a provider call that never happened.
- **One budget calculation.** Spent plus reserved, everywhere, computed in one
  function used by both the run report and `/budget`.
- **Human-readable task labels**, derived from the work itself, in run reports
  and in `/runs`.
- **Terminal-outcome-only reporting.**
- **Surrogate-safe message splitting.** The 4,000-character fallback cut slices
  a UTF-16 index and can split an emoji in half.

## Out of scope

- Session-based continuity and the `idempotency intent mismatch` defect —
  CONTRACT-017A owns both.
- Releasing the $0.60 held by three `outcome_unknown` ledger rows: it needs a
  real evidence SHA, and inventing one would corrupt the audit record.
- Any dashboard work. CONTRACT-018 owns the chat window.
- A daily digest. Considered and declined at M0 in favour of silence.

## Milestones

0. M0: owner confirmation, recorded above.
1. M1: exponential retry backoff, replacing the flat delay.
2. M2: truthful failure reporting — the real error, and no invented provider
   involvement.
3. M3: one budget calculation shared by every surface that shows spend.
4. M4: human-readable task labels, terminal outcomes only, surrogate-safe
   splitting.
5. M5: live drill on the owner's own chat, README, security review, close.

## Gates

- A task that fails repeatedly spreads its attempts over minutes, not seconds,
  and the delay is proven by the recorded `next_attempt_at`, not by reading the
  code.
- A failure with no provider attempt says so, and names the real error.
- The same budget scope reads identically in a run report and in `/budget`,
  proven by comparing the two rendered strings in a test.
- A report about a task never contains a bare uuid as its headline.
- Three tasks failing in a row produce three messages, not six.
- A string containing astral-plane characters survives splitting with no
  replacement characters, at every boundary.
- Full suite, dashboard suite, `typecheck`, `format:check`, `npm audit`,
  `verify-contract.ts`, and `resume-checkpoint.ts --check` pass with zero skips.
- `/security-review` runs clean, or its findings are fixed before the push.

## Acceptance

- The owner reads a failure report and knows what actually failed and whether
  it cost anything, without asking.
- A day of ordinary operation produces messages the owner wants to have
  received.
- No message contradicts another message about the same fact.

## Rollback

Revert the commit. Every change is to formatting, wording, or a delay constant;
nothing changes the schema, and nothing changes what work is executed or in
what order.

## File ownership

- `docs/contracts/CONTRACT-017B/**`
- `docs/product/**`
- `docs/RESUME.md`
- `README.md`
- `CLAUDE.md`
- `src/telegram/**`
- `src/operations/**`
- `scripts/**`
- `tests/**`
