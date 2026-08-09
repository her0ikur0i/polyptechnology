# CONTRACT-014 M9 — Independent security review

Reviewer pass separate from the M1-M7 implementation work, covering the
entire conversation workspace surface: conversation/message routes,
assistant-reply generation (`ConversationReplyDriver`), file upload
(`attachment-upload.ts`, `attachments.ts`), proposal
draft/approve/reject/translate, blueprint translation
(`BlueprintTranslationDriver`), and session management
(rename/archive/search). Read every `pool.query()`/`client.query()` call
site added or touched by this contract, every filesystem path built from
client-supplied input, and the full authority-boundary chain from "owner
sends a message" to "generation pipeline consumes a real blueprint."

## Clean, with evidence

**SQL injection** — every new/changed query in
`src/orchestrator/postgres-store.ts` (`createConversation`,
`appendMessage`, `listConversations`, `renameConversation`,
`setConversationArchived`, `messages`, `putAttachment`,
`transitionAttachment`, `createProposal`, `transitionProposal`) is fully
parameterized. The one query built with string concatenation --
`listConversations`'s `ILIKE '%' || $3 || '%'` -- concatenates a bound
parameter placeholder, not the caller's string; the search text itself is
always `$3`, never interpolated into the SQL text. A caller can put `%`
or `_` wildcards into their own search string, which only widens their
own project-scoped results, not a security boundary.

**Path traversal / storage integrity** —
`src/control-api/attachment-upload.ts`'s multer `diskStorage.filename`
always writes `randomUUID()`, never the client-supplied name, so the
on-disk file location never depends on client input regardless of what
that input contains. `acceptAttachmentUpload()` composes `objectKey` as
`${projectId}/${storedFilename}`, and the route
(`src/control-api/app.ts:484-491`) regex-validates `projectId` as a UUID
before that composition happens, so `objectKey` is always
server-controlled. `validateAttachmentMetadata()`
(`src/orchestrator/attachments.ts:10-16`) independently rejects any
`objectKey` containing `..`, a leading `/`, or characters outside
`[a-zA-Z0-9/_-]`, and separately rejects any `displayName` containing a
`/`, `\`, or NUL byte. CONTRACT-014 M8 additionally confirmed live that
multer/busboy's own `Content-Disposition: filename=` parsing reduces a
traversal-shaped client filename to its basename before this application
ever sees it -- an earlier, independent layer on top of the two above.
Three layers, none of which the others depend on.

**Authority boundary (ADR-0002: "conversation is context, never execution
authority")** — traced the full path from an owner's message to the real
generation pipeline:

1. `OwnerCommandService.sendMessage()` (`src/operations/owner-commands.ts:235`)
   always writes `role: "owner"` server-side; there is no client-writable
   path to `role: "assistant"` or `role: "system"` on a message row. Only
   `ConversationReplyDriver.execute()` (itself only reachable via a
   background task queued by the server, never client input) ever writes
   `role: "assistant"`.
2. `ConversationReplyDriver`'s system prompt explicitly reinforces "you
   have no execution authority... only the owner's later, explicit
   approval... can authorize anything"
   (`src/operations/conversation-reply-driver.ts:58-68`) -- a soft
   control, but backed by the hard one below.
3. `draftProposal()` only ever compiles the literal transcript
   (`**${role}**: ${content}` blocks) -- it does not ask the model to
   generate or approve anything.
4. `approveProposal()` requires an explicit owner-authenticated,
   CSRF-checked call, and is the _only_ path that moves a proposal past
   `owner_review`. There is no automatic or AI-triggered approval path.
5. `BlueprintTranslationDriver` only runs from a task queued by the
   `/proposals/:id/translate` route
   (`src/control-api/app.ts`), which is gated on
   `proposal.state === "handed_off"` -- i.e., gated on step 4 having
   already happened.
6. The translated blueprint is validated through the exact same
   `parseBlueprint()` (`src/factory/blueprint.ts`) the pre-existing,
   human-authored blueprint path already required -- AI-authored content
   gets no less scrutiny than owner-typed content.

No step in this chain can be skipped by conversation content alone;
every advance past "context" requires a fresh owner-authenticated,
CSRF-checked HTTP call.

**Blueprint content from AI translation** — `fields.slug` never reaches
storage/paths directly: `sanitizeSlugFragment()`
(`src/operations/blueprint-translation-driver.ts:65-71`) strips it to
`[a-z0-9-]`, and the final slug also gets a server-generated hex suffix,
then the whole document still has to pass `parseBlueprint()`'s slug
regex (`^[a-z][a-z0-9-]*$`, max 63 chars) besides. `requirements`,
`qualityGates`, `capabilities` are bounded arrays of length-capped
strings; `resources`/`lifecyclePolicy` are entirely server-authored
constants in the driver, never read from the model's output at all.
Matches CONTRACT-013 M8's existing finding that blueprint content never
reaches shell/SQL/paths beyond the gated slug -- this remains true for
AI-derived blueprints.

**XSS** — no `dangerouslySetInnerHTML` anywhere in
`src/dashboard/conversation-workspace.tsx`; every rendered field (message
content, attachment display names, proposal candidate text) goes through
React's default text rendering, which escapes HTML.

**CSRF / auth boundary** — see CONTRACT-014 M8 evidence
(`docs/contracts/CONTRACT-014/evidence/M8-negative-tests.md`): 6
independent mutating routes across the new surface confirmed to fail
closed (403) on a missing/wrong CSRF token, all sharing the same
`requireCsrf` middleware wired at route registration rather than bespoke
per-route logic; the cloudflare-mode `requireOwner` matrix extended with
the 3 new routes, all confirmed 401 without the identity header.

## Findings

### Finding 1 (LOW/informational) — attachment MIME type is client-declared, not content-sniffed

`createAttachmentUpload()`'s `fileFilter`
(`src/control-api/attachment-upload.ts:45-47`) checks
`file.mimetype` -- the `Content-Type` the client's multipart form part
declares -- against the allowlist, not the actual file bytes (no
magic-number sniffing). A client can label arbitrary bytes as
`text/plain` and have them accepted.

Not a new gap: this is the explicitly confirmed CONTRACT-014 scope
decision ("Type/size validation dulu" -- structural validation only for
v1, no real content scanning, matching the file's own comment at
`attachment-upload.ts:9-17`). No route exists yet that serves attachment
bytes back to a browser (checked: no `sendFile`/`createReadStream`
response path for attachments in `app.ts`), so today there is no way for
a mislabeled upload to be rendered/executed by anything -- the blast
radius is currently zero. Documented here, not fixed, since fixing it
would mean building real content scanning, which is out of this
contract's confirmed scope.

**Forward-looking note, not a current gap**: if a future milestone adds
a route that serves attachment bytes to a browser, it must not trust
the stored `mediaType` for the response `Content-Type` without also
setting `Content-Disposition: attachment` (or serving from a
content-disposition-isolated origin) -- otherwise a mislabeled upload
(e.g., HTML/SVG content stored as `text/plain`) could become a stored
XSS vector once it has somewhere to be rendered. No route to fix today;
flagging so the next milestone that adds one starts from this note
instead of rediscovering it.

### Finding 2 (LOW/informational) — no rate limiting on conversation/message creation

Confirms and extends CONTRACT-013 M8 Finding "no rate limiter exists on
any Control API route" to this new surface. Each conversation's AI spend
is capped at $5 (`queueConversationReply`'s
`ai_budget_accounts.max_cost_usd_micros`,
`src/orchestrator/reply-task.ts:44-46`), but nothing caps the number of
conversations an authenticated owner session can create, so the
per-conversation cap does not bound total spend. Same accepted
deferral as before: CONTRACT-013/014 target a private staging instance
behind Cloudflare Access, not public cutover; flagged for the M9/M10
owner acceptance pass (this milestone) and any future milestone that
changes the exposure calculus.

## Deliberately out of scope, not silently dropped

- Real attachment content scanning/antivirus (confirmed v1 scope: type/
  size validation only).
- Attachment download/serve route (does not exist yet in this contract;
  Finding 1's forward-looking note applies when one is added).
- Rate limiting (Finding 2, same accepted deferral as CONTRACT-013 M8).
