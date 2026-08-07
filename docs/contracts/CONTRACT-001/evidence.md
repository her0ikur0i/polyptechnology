# CONTRACT-001 evidence

Date: 2026-08-08
Contract: Product truth and safe foundation

## M1 — Clean workspace and operating rules

- Canonical workspace is `/root/polyptechnology-next` on orphan `main` with no
  legacy source or runtime state included.
- `AGENTS.md`, `.gitignore`, and the explicit contract ownership manifest define
  the operating and publication boundary.

## M2 — Product and architecture source of truth

- Product vision, release criteria, domain boundaries, events, architecture, and
  the canonical system specification are present under `docs/`.
- Tests assert that generated products remain dynamic registry entries rather
  than hard-coded control-plane modules.

## M3 — Security and approval baseline

- Threat boundaries and L0–L5 approval taxonomy are documented.
- Configuration tests prove that production rejects disabled access
  authentication.

## M4 — Executable configuration and contract verification

- Strict TypeScript configuration and validated environment parsing are present.
- The contract verifier checks mandatory sections, requires an ownership
  manifest, and rejects dirty paths outside that manifest.
- Negative unit tests cover missing contract sections and an out-of-scope dirty
  path.

## M5 — Final gates

Executed from the canonical workspace:

```text
npm ci --ignore-scripts       PASS (0 vulnerabilities)
npm run contract:verify       PASS
npm run typecheck             PASS
npm test                      PASS (8 tests, 0 failures)
```

The final publication review stages only paths declared in the contract
ownership manifest. Production, DNS, secrets, and legacy systems are untouched.
