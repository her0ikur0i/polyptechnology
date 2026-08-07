# CONTRACT-002 evidence

Date: 2026-08-08

## Milestone evidence

- M1: bounded contract, fail-closed configuration, and additive PostgreSQL
  migration with database-enforced immutable event/audit tables.
- M2: transactional PostgreSQL repository plus deterministic in-memory test
  repository; request/decision events and audit records contain no raw token.
- M3: 256-bit opaque tokens, SHA-256 persistence, bounded expiry, row locking,
  terminal state checks, and replay rejection.
- M4: Telegram HTTP/fake transports, 64-byte-safe callback payloads, strict update
  parsing, exact chat and user authorization, and application callback handler.
- M5: operational recovery guidance, provider reviews, negative tests, dependency
  audit, scope verification, and final integrated gates.

## Provider evidence

- DeepSeek V4 Flash supplied the initial module/invariant/test blueprint. Its
  first reasoning-mode call exhausted its output budget; non-thinking fallback
  succeeded. Codex rejected weak suggested invariants and integrated the design.
- Claude Sonnet implementation attempt timed out without changes. A bounded full
  staged-diff security review later completed with no critical/high findings.
  Two minor observations (database URL and database-clock expiry) were repaired.

## Verification

Final results: locked install passed; contract scope verification passed; strict
typecheck passed; 16 deterministic tests passed; dependency audit reported zero
vulnerabilities; staged diff hygiene and secret-pattern scanning passed. No live
Telegram message or production mutation occurred.
