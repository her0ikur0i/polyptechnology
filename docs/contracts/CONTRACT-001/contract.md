# CONTRACT-001 — Product truth and safe foundation

## Objective

Create the clean, deterministic foundation that future human and model workers
use without interpreting product or security boundaries differently.

## Scope

- Product vision and release criteria.
- Architecture/domain/event boundaries.
- Threat model and approval taxonomy.
- Agent and contract operating policy.
- Strict TypeScript project and configuration validation.
- Deterministic contract verifier and tests.

## Out of scope

Authentication implementation, database, queue, UI, provider calls, deployment,
and production cutover.

## Milestones

1. M1: clean workspace and operating rules.
2. M2: product and architecture source of truth.
3. M3: security and approval baseline.
4. M4: executable configuration and contract verification.
5. M5: final typecheck/tests/scope review.

## Acceptance

- Strict typecheck passes.
- Tests pass without external services.
- Production configuration fails closed when auth is disabled.
- Contract verifier rejects missing contract sections and dirty out-of-scope files.
- No secret, runtime data, legacy mockup, or production mutation is included.

## Rollback

Remove the new local workspace. The active `/opt/master-orchestrator` remains
untouched throughout this contract.

## File ownership

CONTRACT-001 owns only the following repository paths:

- `.env.example`
- `.gitignore`
- `AGENTS.md`
- `README.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `docs/**`
- `scripts/**`
- `src/**`
- `tests/**`

Dirty paths outside this manifest block contract completion.
