# M3 — File upload, wired to the existing attachment state machine

Status: done, 2026-08-09.

## What was built

- Added `multer@2.2.0` (+ `@types/multer`) -- the only new runtime
  dependency this contract needed; Node has no built-in multipart parser
  and hand-rolling one is not a reasonable substitute for a well
  -maintained library on a security-sensitive parsing path.
- `src/config.ts`: new `attachmentStorageRoot` (env `ATTACHMENT_STORAGE_ROOT`,
  default `/var/lib/polyp/attachments`), same pattern as
  `projectWorkspacesRoot`.
- `src/control-api/attachment-upload.ts`: `createAttachmentUpload()`
  (multer instance -- disk storage, opaque `randomUUID()` filenames, never
  the client-supplied original name, matching ADR-0002: "Original filenames
  are display-only untrusted metadata"; 25 MB limit matching the DB's own
  `size_bytes` check constraint exactly; `fileFilter` allowlisting six
  media types) and `acceptAttachmentUpload()` (hashes the stored file,
  calls the previously-never-invoked `validateAttachmentMetadata()`
  (`src/orchestrator/attachments.ts`, built in CONTRACT-006, only ever unit
  -tested until now), inserts as `quarantined`, then advances through
  `validated` -> `scanned`).
- **`POST /api/v1/orchestrator/conversations/:id/attachments`** and
  **`GET /api/v1/orchestrator/conversations/:id/attachments`**
  (`src/control-api/app.ts`).

## Deliberately stops at "scanned," not "classified"/"redacted"

Per the confirmed decision, "scanned" means structural type/size validation
for this contract, not real antivirus/content scanning. Advancing further
to `classified`/`redacted` needs real content-sensitivity judgment, which
is out of scope here -- and `src/orchestrator/context.ts` (ADR-0002) already
excludes anything short of `redacted` from the assistant's context, so an
uploaded-but-unclassified attachment is honestly inert (visible and
listable, but not yet fed to the assistant) rather than silently
half-trusted. Closing that gap is left for whichever future milestone
implements real classification.

## A real bug found live, not by tests alone

Chaining `attachmentUpload.single("file")` into the route's normal
Express middleware array meant multer's own errors (oversized file,
disallowed type via `fileFilter`) were reported through Express's default
HTML error page (`500`), not this API's `{ error }` JSON contract every
other route uses -- found by actually uploading a 26 MB file with `curl`
against a live dev server, not by reasoning about the code. Fixed by
invoking multer directly with its callback form inside the route handler
instead of as a chained middleware, so every failure mode (bad request
body, multer rejection, downstream validation) reaches the same JSON
error shape. Verified live again after the fix (`{"error":"File too
large"}`, `400`) before writing the regression test.

## Verified live, not just by tests

Booted the real dev server and exercised the full matrix with `curl`
before writing any formal test: a valid `text/plain` upload reaching
`state: "scanned"`; a disallowed `application/x-executable` type rejected
(`400`); a missing CSRF token rejected (`403`); the oversized-file bug
found and the fix re-verified; the listing route returning the accepted
attachment.

## Test evidence

1 new test in `tests/control-api.integration.test.ts` (real multipart
`fetch`/`FormData`, not mocked) covering all four cases in one flow: accept
an allowed type, reject a disallowed type, reject an oversized file with a
clean JSON error, reject a missing CSRF token, then list and confirm the
one accepted attachment is present at `state: "scanned"`.
`withServer()`'s shared test config now also provisions an isolated
`ATTACHMENT_STORAGE_ROOT` per test run, matching the existing
`PROJECT_WORKSPACES_ROOT` pattern.

```
TEST_DATABASE_URL=... TEST_WORKER_IMAGE=... npm test
# tests 170
# pass 170
# fail 0
# skipped 0
```

`npm run dashboard:test` (19/19), `npm run dashboard:build`,
`npm run typecheck`, `npm run format:check`, and
`scripts/verify-contract.ts CONTRACT-014` all pass.
