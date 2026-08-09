# M11 — Repo-wide code quality cleanup

Status: done, 2026-08-09. Deliberately last, per the owner's standing
instruction to place formatting/cleanup as the closing act before the
single final commit.

## Formatting

`npm run format:check` was already clean repository-wide going into this
milestone -- CONTRACT-013's own M11 had already closed out the 38
pre-existing unformatted files. The only 3 files needing a pass were
CONTRACT-014's own new docs written earlier in this contract
(`docs/contracts/CONTRACT-014/acceptance-checklist.md`,
`docs/contracts/CONTRACT-014/evidence/M8-negative-tests.md`,
`docs/security/CONTRACT-014-M9-review.md`), fixed with `npm run format`.
`npm run format:check` now reports zero warnings across the entire
repository -- CONTRACT-014's own acceptance bullet 5.

## Duplication audit: deterministic UUID derivation

CONTRACT-014's own new code had introduced the exact same
`deterministicUuid()` function -- sha256 a string, force UUIDv4 version/
variant nibbles, format with dashes -- four separate times, byte-for-byte
identical logic, across
`src/orchestrator/reply-task.ts`, `src/factory/blueprint-translation-task.ts`,
`src/operations/conversation-reply-driver.ts`, and
`src/operations/owner-commands.ts` (the last one pre-dated this
milestone but was still an in-scope duplicate of the same logic). Grepped
the whole `src/` tree for the same fingerprint (`hex[12] = "5"`) to
confirm these were the only four copies before consolidating -- this is
new-to-this-contract debt, not a pattern inherited from elsewhere in the
codebase.

Consolidated into `src/deterministic-id.ts` (new, single-purpose, no
side effects -- matches the existing top-level-`src/`-module precedent
`src/config.ts` already set), and updated all four call sites to import
it instead of redefining it. `owner-commands.ts` additionally dropped a
now-redundant intermediate `digest()`-based implementation in favor of
the shared one; its separate `digest()` helper (used for
`contentSha256`/`candidateSha256`/`evidenceSha256` elsewhere in the same
file) was untouched, since that's a different concern (content hashing,
not id derivation) that happens to also use sha256.

Added the new file to `contract.md`'s file-ownership list (alongside the
existing `src/config.ts` line) so `scripts/verify-contract.ts` recognizes
it as in-scope.

## What was checked and found clean

- No leftover references to the deleted `factory-control.tsx`/
  `FactoryControlPage` anywhere in `src/` or `tests/` (M4 removed it
  cleanly).
- `parseConversationReplyTaskInput`/`parseBlueprintTranslationTaskInput`
  are exported but only called within their own defining file -- not
  dead code, just not yet unit-tested in isolation (their behavior is
  exercised indirectly through the integration tests that go through the
  full route); left as-is, matching the existing `parseBlueprint()`
  export convention elsewhere in the codebase.
- `npm audit`: zero vulnerabilities.

## Test evidence

```
TEST_DATABASE_URL=... npm test
# tests 178, pass 177, skipped 1 (pre-existing), fail 0
npm run dashboard:test
# Test Files 5 passed (5), Tests 20 passed (20)
```

`npm run typecheck`, `npm run format:check`, `npm run dashboard:build`,
`npm audit`, and `scripts/verify-contract.ts CONTRACT-014` all pass.
