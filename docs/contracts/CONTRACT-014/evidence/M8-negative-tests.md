# M8 — Negative tests (CSRF, accessibility, upload abuse, auth boundary)

Status: done, 2026-08-09.

## Headline finding: a stray NUL byte, not a wrong defense

While writing the path-traversal-shaped-filename test, the original
assumption was that `validateAttachmentMetadata()`'s `/`/`\0` check
(`src/orchestrator/attachments.ts`) would reject a traversal-shaped
filename outright with 400. Live curl testing against an ad-hoc dev server
(port 4187, `ATTACHMENT_STORAGE_ROOT` pointed at a scratch directory, real
staging untouched) showed the real behavior is 201, not 400:

```
$ curl ... -F "file=@evilname.txt;filename=../../../../etc/passwd;type=text/plain"
{"id":"...","objectKey":"4d2485cd-.../b5b6aa1a-...","displayName":"passwd", ...}

$ curl ... -F "file=@evilname.txt;filename=..\\..\\windows\\system32\\config;type=text/plain"
{"id":"...","objectKey":"4d2485cd-.../f1c2c41d-...","displayName":"config", ...}
```

multer/busboy's own `Content-Disposition: filename=` parsing already
reduces a traversal-shaped name to its basename before this application
ever sees `req.file.originalname` -- a real, earlier defense layer than
the one this test originally assumed it was checking. Nothing in the
application was wrong; the test's expectation was. Rewrote the test to
assert the actual, verified, safe behavior: `displayName` is always
reduced to a bare basename, and `objectKey`
(`src/control-api/attachment-upload.ts`) is always
`<projectId>/<serverGeneratedUuid>`, never derived from the client's
filename at all -- both layers hold independently of each other.

While fixing the test body, repeated `Edit` attempts against the full
test block failed with "String to replace not found" despite the text
looking identical on read. Root cause, found by inspecting the file at
the byte level: an earlier edit had written a literal NUL byte
(`\x00`) into a string literal (`"legit-looking<NUL>.txt"`) instead of
the two characters `\` and `0` that the surrounding comment described.
That single stray byte made `file(1)` classify the whole test file as
`data` instead of text and made line-oriented tools (`grep`) treat it as
binary, which explains the exact-string-match failures. Fixed with a
precise byte-level Python replacement rather than the text `Edit` tool,
confirmed the NUL byte is gone (`file` now reports "JavaScript source,
ASCII text"), and rewrote the malicious-filename case list to only the
two real traversal shapes (dropping the unrelated `"legit-looking .txt"`
case, which was never a valid 400 case to begin with).

## What was covered

- **Accessibility**: 1 new axe test on the active conversation workspace
  screen (composer, message thread, attachment list, proposal panel all
  rendered) -- 0 violations (`color-contrast` disabled per this suite's
  existing convention, matching every other axe test in the file).
- **Auth boundary**: extended the existing
  `"cloudflare auth mode rejects every requireOwner route without the
identity header"` matrix with the 3 new conversation-surface routes
  (`POST .../conversations`, `GET .../projects/:id/conversations`,
  `GET .../proposals/:id`) -- all 401 without the identity header, same as
  every pre-existing route in that matrix.
- **CSRF**: audited every M1-M7 mutating route rather than adding
  bespoke per-route tests for all of them, since the CSRF gate is one
  shared piece of middleware (`requireOwner` + CSRF check applied at
  route registration in `src/control-api/app.ts`), not bespoke per-route
  logic. 6 independent routes across the new surface already assert a
  missing/wrong token fails closed with 403: conversation start, message
  send, attachment upload, proposal draft, proposal translate, and
  conversation rename. That is sufficient evidence the shared gate covers
  the surface -- approve/reject/archive share the identical middleware
  wiring as rename, so a 7th near-duplicate assertion would not exercise
  any different code path.
- **Upload abuse**: allowed-type accept, disallowed-type reject,
  oversized-file reject, missing-CSRF reject (M3, already covered) plus
  the path-traversal-shaped-filename behavior above (this milestone).

## Test evidence

```
TEST_DATABASE_URL=... node --import tsx --test tests/control-api.integration.test.ts
# tests 22
# pass 22
# fail 0

TEST_DATABASE_URL=... npm test
# tests 178
# pass 177
# skipped 1 (pre-existing, unrelated to this contract)
# fail 0

npm run dashboard:test
# Test Files  5 passed (5)
# Tests  20 passed (20)
```

`npm run typecheck`, `npm run format:check`, `npm run dashboard:build`,
and `scripts/verify-contract.ts CONTRACT-014` all pass.
