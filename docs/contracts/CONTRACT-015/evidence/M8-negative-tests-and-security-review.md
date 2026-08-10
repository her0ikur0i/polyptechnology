# M8 — Negative tests and independent security re-review

Date: 2026-08-10. Status: **done**.

Reviewer independence was enforced, not assumed: the review was carried out by a
party that did not write M2 or M3, per `AGENTS.md`'s rule that a provider must
never review work it executed. Its brief was adversarial — attack the claims in
the M2 and M3 evidence rather than confirm them — and it was told explicitly not
to wave anything through because the evidence file sounded confident, since the
evidence file was written by the same party that wrote the code.

That was the right call. **It found a critical bug that M3 itself introduced.**

## The headline: M3's rate limiter could be skipped by holding down shift

**Severity: critical. Status: fixed and regression-tested.**

`src/control-api/app.ts` dispatched to a limiter with
`req.path.startsWith("/api/")` — a case-sensitive JavaScript string comparison.
Express's router, however, matches routes **case-insensitively** unless
`case sensitive routing` is enabled, and this application never enables it.

So the dispatch and the router disagreed about which requests exist.
`/API/v1/dashboard/snapshot` matched a real route and ran its real handler while
skipping the limiter entirely. Every `/api/` route was affected, including the
ones that reach `AiGateway` and spend real money — the exact thing M3 added the
limiter to protect — and the Telegram webhook, which lost its throttle
completely.

Confirmed before the fix, against a live server with a ceiling of 30:

```
lowercase after ceiling : 429
UPPERCASE after ceiling : 500   ← reached the real handler
MixedCase after ceiling : 500   ← reached the real handler
```

The reviewer additionally reproduced it over a raw TCP socket, ruling out any
client-library URL normalization as the cause.

After the fix, all three fold to a canonical lower-case form before comparison:

```
lowercase : 429
UPPERCASE : 429
MixedCase : 429
```

Regression test: `tests/rate-limit.test.ts`, "the case of the request path
cannot skip the limiter", which exhausts the budget on the canonical path and
then asserts 429 for four case variants.

**What this says about M3.** The milestone shipped with six passing tests that
all used the canonical lower-case path, so the suite was green and the
protection was absent. A test that only exercises the shape the author had in
mind proves the author's assumption, not the property.

## Also fixed from the review

**[HIGH] `safeRelativePath` could return an absolute path.** `isAbsolute()` ran
on the raw input only. `"\\\\etc\\passwd"` is not POSIX-absolute, but the
backslash-to-slash rewrite turns it into `"//etc/passwd"` and `posix.normalize`
collapses that to `"/etc/passwd"` — an absolute path returned by a function
whose contract promises a relative one, which `resolve(root, result)` would
honour by leaving the root. Present in all three replaced implementations too,
so not a CONTRACT-015 regression.

Not exploitable through any current call site — `src/worker/artifacts.ts` has an
independent `realpath` containment check, and the git-based callers hand raw
patch text to `git apply`, which does not treat backslashes as separators (the
reviewer verified both empirically). Fixed regardless: this is the shared
primitive `CLAUDE.md` directs future callers to, and the only thing between the
bug and a real escape is a check elsewhere that nothing documents as
load-bearing. Now re-checked **after** normalization, with a test asserting the
invariant across a corpus rather than only the one example input.

**[HIGH] Unauthenticated callers could spend Telegram's rate-limit budget.** The
webhook is the one route reachable without Cloudflare Access, because Telegram
cannot do interactive SSO. The limiter ran before the secret check, so anyone
who knew the fixed path could hold the protective budget at zero with rejected
requests and deny the owner's real approval callbacks — a credential-free denial
of service on the approval channel.

Now two tiers: a looser guard limiter (4× the ceiling) holds all webhook traffic
for CPU protection, and the configured ceiling is consumed **only after the
secret validates**. Anonymous traffic cannot reach the authenticated budget.
Regression test: "an unauthenticated caller cannot spend the webhook's real
budget".

This also meant an existing test was asserting the old, wrong behaviour — it
sent unauthenticated requests and expected them to be throttled. It was rewritten
to exercise authenticated traffic, which is what the ceiling now governs.

**[MEDIUM] `.git` rejection was case-sensitive.** All three replaced
implementations compared case-sensitively, so `.GIT` and `vendor/.Git/config`
walked past the "any depth" strengthening M2 was proud of. Harmless on this
deployment's case-sensitive Linux volumes, but a rule a single capital letter
defeats is not the rule as stated. Now case-folded, with tests.

**[LOW] The `.map` guard was case-sensitive.** Nothing leaked in practice,
because the static root is case-sensitive Linux and a mismatched-case request
fell through to the SPA fallback — but that was the filesystem upholding the
guard's promise, not the guard. Now case-folded.

**[LOW] The webhook secret was compared with `!==`.** A plain string comparison
leaks position through timing, and this codebase already establishes the correct
pattern in `requireCsrf` (`src/control-api/auth.ts`), which uses
`timingSafeEqual` with a comment about exactly this. The risk was elevated by
the critical finding above, which removed the throttle that made a timing attack
impractical. Now hashed to fixed length and compared in constant time.

**[LOW] `safeRelativePath("./")` was accepted** although `"."` was explicitly
rejected, because `posix.normalize("./")` returns `"./"`. Every downstream
caller happened to fail safe by a different, uncoordinated mechanism — which is
not the same as the guard holding. Now rejected.

**[LOW] Bidi and zero-width characters passed through.** Not a traversal vector,
but the same display-layer concern the existing message-injection test already
addresses: these paths are rendered into evidence files and terminals, where a
right-to-left override makes a path read as something it is not. Now rejected.

**[LOW] `TRUSTED_PROXY_HOPS` above 0 reopens `X-Forwarded-For` spoofing.** Not
today's behaviour — the reviewer verified that at the default of 0 the limiter
ignores forged headers entirely, and that setting it to 1 lets a spoofed header
mint a fresh budget. Documented at the config point rather than changed, since 0
is correct for the current deployment.

## Deliberately not acted on

**Every caller collapses to one rate-limit key.** With `trust proxy = 0` and
`cloudflared` connecting outbound to loopback, every request — the owner's,
Telegram's, and any internet client's — arrives from the same socket address, so
one bucket serves them all. The unauthenticated-webhook half of this was fixed
above; the general case requires trusting Cloudflare's `CF-Connecting-IP`, which
is a deployment-topology decision tied to the public exposure CONTRACT-020 owns.
Recorded rather than half-solved here.

**Container-escape resistance was not penetration-tested.** The reviewer
confirmed the sandbox flags are present as claimed but explicitly labelled real
escape resistance UNVERIFIED. That is honest and correct: it is a materially
larger exercise than a path-guard review.

## What the review attacked and could not break

Recorded because knowing what was actually exercised matters as much as the
findings. A 93-input differential fuzz reconstructed the three pre-contract
implementations verbatim from `git show HEAD:…` and ran every input through old
and new side by side: **0 regressions, 5 strengthenings** — the union claim in
M2's evidence holds under execution, not merely under its own prose.

Also attacked without success: traversal in every separator shape; multi-dot
lookalikes; fullwidth Unicode slash and dot homoglyphs; percent-encoding double
decode; NUL and pathspec metacharacters; Windows device names; 5-million-character
inputs (no ReDoS, linear scaling); the `src/dash/**` vs `src/dashboard/…` prefix
trap; the bare-`**` refusal mixed with real entries; HEAD/OPTIONS method
bypasses; `X-Forwarded-For` spoofing at the real default; double-slash and
dot-segment URL variants over a raw socket; and limiter state across restart.

## Gates after remediation

```
# tests 193
# pass 193
# fail 0
# skipped 0
# duration_ms 49801.5
```

193 = 187 after M7 + 6 new (4 path-guard, 2 rate-limiter). Dashboard: 5 files,
38 tests. `npm run typecheck` clean. `npm run format:check` clean
repository-wide. `npm audit` 0 vulnerabilities.
