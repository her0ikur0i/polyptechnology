# M8 — Independent security review, Cloudflare Access boundary hardening

Status: done, 2026-08-09.

## Review method

An independent review pass (separate from the implementation work in
M5-M7) read every `pool.query()`/`client.query()` call site, every process
-spawning call site, and every path built from owner- or AI-supplied input
across the Control API and the CONTRACT-013 generation/policy pipeline.
Full findings with file:line citations:
`docs/security/CONTRACT-013-M8-review.md`.

## Finding 1 (HIGH) — Cloudflare Access boundary, fixed

`ACCESS_AUTH_MODE=cloudflare` (`src/control-api/auth.ts`) trusts the
`Cf-Access-Authenticated-User-Email` header's mere presence -- there is no
JWT/signature verification against Cloudflare's Access assertion. This was
already flagged in CONTRACT-012 Amendment 1 as a known gap; this review
found the concrete missing enforcement: nothing in `config.ts` tied
`accessAuthMode` to `host`, so `HOST=0.0.0.0` with cloudflare mode passed
validation, making the header fully spoofable by anyone able to reach the
port directly.

Fixed in `src/config.ts`: cloudflare mode now refuses to start unless bound
to a loopback address (`127.0.0.1`/`::1`/`localhost`), converting an honor
system into an enforced network-level guarantee -- this matches the
contract's own stated remediation options ("either origin-pull verification
or a network-level guarantee (bind to localhost only, firewall direct
access)") and the actual deployed architecture, where a Cloudflare Tunnel
(`cloudflared`) makes an outbound-only connection and forwards to loopback,
so nothing else can reach this process directly. An explicit
`CLOUDFLARE_TRUST_NETWORK_BOUNDARY=true` escape hatch exists for a
deployment that fronts the app with its own verified reverse proxy instead
of a loopback-bound tunnel -- absent that variable, the server fails closed
rather than silently trusting a spoofable header on a routable interface.

Full JWT verification against Cloudflare's Access certs (the stronger
alternative named in the contract and `docs/security/threat-model.md`'s
"Cloudflare Access plus origin JWT validation" control) was not implemented
this milestone: it requires a new dependency, a network call to Cloudflare's
JWKS endpoint, and an audience-tag decision that is properly an
infrastructure/owner decision at actual Cloudflare Access setup time, not
something to bake in speculatively before that setup exists. The
network-level guarantee is the concrete fix this milestone delivers; JWT
verification remains a documented future hardening step, not silently
dropped.

Verified with `tests/config.test.ts` (5 new tests): refuses non-loopback
bind in both dev and production shapes, accepts every loopback spelling,
allows the explicit escape hatch, confirms `disabled` mode is unaffected.

## Finding 2 (LOW/informational) — `simulate()`'s client-supplied `occurredAt`

`POST /api/v1/policy/simulate` accepts a client-supplied `occurredAt` used
as "now" when evaluating override expiry in the simulated response. Does
not affect real routing -- `src/operations/policy-route-resolver.ts` always
calls `simulateProgrammingRoute()` with real server time, never
client-supplied time -- so the blast radius is a misleading preview
response, not manipulable real execution. Documented with a code comment at
the call site (`src/policy/owner-policy-service.ts`, `simulate()`) rather
than changed, since `simulate()` is deliberately a read-only "what would
happen" query (ADR-0003) and accepting a caller-specified point in time is
the correct shape for a preview endpoint -- the comment exists so a future
change does not start trusting this endpoint's output for anything beyond
display without re-examining this.

## Findings 3-8 — clean, with evidence

SQL injection (all call sites parameterized), path traversal (`slug`/
`projectId`/patch paths/worker owned-paths all regex- or safe-path-gated
before use), command/argument injection (array args, `shell: false`,
allowlisted worker environment variable names), Docker sandbox hardening
(single code path, already-hardened flags confirmed still applied),
blueprint content (never reaches shell/SQL/paths beyond the already-gated
`slug`), and authorization/TOCTOU (every policy state transition is a
single version-fenced, advisory-locked `UPDATE`, no check-then-act gap).
Full detail in `docs/security/CONTRACT-013-M8-review.md`.

## Deliberately deferred, not silently dropped

- **Rate limiting / DoS resistance**: no rate limiter exists on any Control
  API route. Out of scope for this milestone (CONTRACT-013 targets a
  private staging instance, not public cutover -- see "Out of scope" in
  `contract.md`); flagged for the M9/M10 owner acceptance pass if the
  staging instance's exposure changes that calculus.
- **`npm audit`**: already gated in CI (`.github/workflows/quality.yml`);
  confirmed `npm audit` (dev+prod) reports zero vulnerabilities as of this
  review.
- **Full Cloudflare Access JWT verification**: see Finding 1 -- the
  network-level guarantee is the fix delivered this milestone; JWT
  verification remains a documented future step tied to actual Cloudflare
  Access configuration, not fabricated ahead of that setup.

## Test evidence

5 new tests in `tests/config.test.ts`. Full suite:

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 163
# pass 163
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run typecheck`, `npm audit`, and
`scripts/verify-contract.ts CONTRACT-013` all pass.
