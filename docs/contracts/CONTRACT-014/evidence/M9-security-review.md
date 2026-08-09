# M9 — Independent security review of the conversation workspace surface

Status: done, 2026-08-09.

## Review method

An independent review pass (separate from the M1-M7 implementation work)
read every `pool.query()`/`client.query()` call site added or touched by
this contract, every filesystem path built from client-supplied input,
and traced the full authority-boundary chain from an owner's chat
message to the real generation pipeline. Full findings with file:line
citations: `docs/security/CONTRACT-014-M9-review.md`.

## Clean, with evidence

SQL injection (all new store methods fully parameterized, including the
search `ILIKE` which concatenates a bound placeholder, never the raw
string), path traversal (three independent layers: server-generated
`objectKey`/on-disk filename, `validateAttachmentMetadata()`'s
slash/NUL/`..` rejection, and multer/busboy's own basename-stripping
confirmed live in M8), the ADR-0002 authority boundary (traced
message -> proposal -> owner approve+handoff -> owner-triggered
translate -> `parseBlueprint()`-gated blueprint attach; no client-writable
path ever produces an `assistant`/`system`-role message, and no step
past "context" can be reached without a fresh owner-authenticated,
CSRF-checked call), AI-derived blueprint content (same bounded-array,
regex-gated `parseBlueprint()` every human-authored blueprint already
goes through -- no less scrutiny for AI content), XSS (no
`dangerouslySetInnerHTML` anywhere in the new chat UI; React's default
escaping applies to all rendered content), and CSRF/auth (already
evidenced in M8: 6 independent mutating routes fail closed on a
missing/wrong token, 3 new routes added to the cloudflare-mode
auth-boundary matrix, all 401 without the identity header).

## Finding 1 (LOW/informational) — attachment MIME type is client-declared, not content-sniffed

`fileFilter` checks the client's declared `Content-Type`, not the actual
file bytes. Not a new gap: this is the explicitly confirmed CONTRACT-014
scope decision (type/size validation only for v1, no real content
scanning). Currently zero blast radius: no route exists yet that serves
attachment bytes back to a browser, so a mislabeled upload has nowhere
to be rendered or executed. Documented with a forward-looking note (not
a fix, since real content scanning is out of scope): whichever future
milestone adds an attachment-download route must not trust the stored
`mediaType` for the response header without also setting
`Content-Disposition: attachment`.

## Finding 2 (LOW/informational) — no rate limiting on conversation creation

Extends CONTRACT-013 M8's existing "no rate limiter on any Control API
route" finding to the new surface: each conversation's AI spend is
capped ($5), but nothing caps how many conversations an authenticated
owner session can create, so the per-conversation cap doesn't bound
total spend. Same accepted deferral as before -- private staging
instance behind Cloudflare Access, not public cutover.

## Deliberately out of scope, not silently dropped

Real attachment content scanning, an attachment-download/serve route
(does not exist yet), and rate limiting -- all previously-accepted or
newly-extended deferrals, not overlooked gaps.

## Test evidence

No code changes this milestone (review-only, no fix required). Full
suite unchanged from M8:

```
TEST_DATABASE_URL=... npm test
# tests 178, pass 177, skipped 1, fail 0
npm run dashboard:test
# Test Files 5 passed (5), Tests 20 passed (20)
```

`npm run typecheck`, `npm run format:check`, `npm audit` (zero
vulnerabilities), and `scripts/verify-contract.ts CONTRACT-014` all
pass.
