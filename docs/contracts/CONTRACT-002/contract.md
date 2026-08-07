# CONTRACT-002 — Durable approvals and Telegram gateway

Status: accepted — all deterministic and security gates passed

## Objective

Create the durable event, audit, and approval foundation required to pause risky
work and let the authorized owner approve or deny it from Telegram safely.

## Scope

- PostgreSQL schema and explicit forward-only migration for events, audit records,
  approval requests, and consumed Telegram callback tokens.
- Domain services with transactional state transitions and restart-safe behavior.
- Opaque, hashed, scoped, expiring, single-use approval tokens.
- Telegram Bot API adapter and webhook callback handler restricted by configured
  chat and user IDs.
- Fake adapters and deterministic tests requiring no external service.
- Configuration, operational documentation, and milestone evidence.

## Out of scope

Dashboard UI, public deployment, Cloudflare configuration, provider registry,
job orchestration, production database mutation, and live secret rotation.

## Risks

- Forged/replayed callbacks, unauthorized Telegram identities, token leakage,
  duplicate decisions, partial database writes, and Telegram outages.
- Controls: cryptographic tokens stored only as hashes, constant-time comparison,
  transactions, unique constraints, idempotency, fail-closed validation, redacted
  logging, and negative tests.

## Budget

No paid model or infrastructure call is required by verification. Provider use is
bounded to implementation/review assistance. Live Telegram verification must not
send a message until the owner identity is resolved and configuration is valid.

## Capability envelope

- L0 repository/server inspection.
- L1 reversible mutation of owned repository paths and local test artifacts.
- L2 locked dependency installation and provider/API egress for coding/review.
- No L3–L5 capability; no staging, production, DNS, secret mutation, destructive
  migration, or irreversible operation.

## Milestones

1. M1: contract, domain invariants, configuration, and migration.
2. M2: durable event/audit and approval repositories.
3. M3: secure approval service and token lifecycle.
4. M4: Telegram delivery/callback gateway with fake adapter.
5. M5: security, recovery, integration, documentation, and final gates.

## Gates

- Locked install, strict typecheck, and deterministic tests pass.
- Migration is explicit and transaction-safe.
- Tests reject forged, expired, replayed, wrong-chat, and wrong-user callbacks.
- Duplicate delivery/decision is idempotent; Telegram failure never approves.
- Tokens and secrets never appear in persisted events, audit payloads, or logs.
- Contract verifier rejects dirty paths outside ownership.
- Dependency audit and staged secret/diff checks pass.

## Acceptance

- Approval state survives service reconstruction over the same repository.
- One authorized callback makes exactly one terminal decision and audit event.
- Unauthorized, expired, malformed, and replayed callbacks cannot change state.
- Telegram outage leaves the approval pending and decidable through another
  authenticated channel later.
- Production configuration fails closed without Telegram identity restrictions.

## Evidence

Each milestone records changed paths, commands, test results, and security review
in `docs/contracts/CONTRACT-002/evidence.md`.

## Rollback

Revert the single contract commit before production adoption. The additive schema
is not applied to production by this contract; no down migration is executed.

## Completion policy

All milestones and final integrated gates must pass before exactly one scoped
commit and one push. Failure leaves an uncommitted resumable workspace.

## File ownership

- `.env.example`
- `README.md`
- `package.json`
- `package-lock.json`
- `docs/RESUME.md`
- `docs/contracts/CONTRACT-002/**`
- `docs/operations/**`
- `migrations/**`
- `src/**`
- `tests/**`

Dirty paths outside this manifest block completion.
