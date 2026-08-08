# ADR-0002: Conversation is context, never execution authority

- Status: accepted
- Date: 2026-08-08
- Contract: CONTRACT-006

## Decision

Persist conversations as append-only, project-scoped records. Messages and eligible
attachment derivatives may inform a versioned context manifest, but only an
immutable approved contract plus capability records can authorize work. The
orchestrator produces proposals and contract candidates; it cannot enqueue tasks,
publish Git, grant capabilities, or reinterpret later chat as an amendment.

Each write uses a caller idempotency key and an expected conversation version.
Project and conversation identifiers are mandatory on reads and writes. Context
selection uses explicit classification, provenance, stable ordering, per-item and
total byte ceilings. Secret, private-ineligible, quarantined, unscanned, rejected,
or unredacted attachment material is excluded before provider routing.

Attachments are represented by opaque internal object keys and SHA-256 digests.
Original filenames are display-only untrusted metadata. Eligibility progresses
through validated, scanned, classified, and redacted states; extraction is a
separate isolated-worker request and never runs inside the API process.

Proposal approval stores the durable approval reference and freezes a candidate
digest. Handoff returns that candidate and provenance for the contract admission
layer; it deliberately has no work-engine dependency. This separation prevents a
model response, UI action, or compromised conversation component from becoming
ambient execution authority.

Sequence continuity is owned by a supervised, non-interactive controller rather
than a chat turn. PostgreSQL checkpoints and fenced leases are authoritative;
systemd only restores processes. The controller advances work solely after durable
gate evidence, applies bounded retry/backoff, aggregates owner-only blockers, and
emits compact summaries from the managed gateway ledger. Restart never implies
approval, retry of an ambiguous provider request, or permission escalation.

## Consequences

Restart and replay are deterministic, audit provenance is preserved, and context
leakage fails closed. The tradeoff is an explicit approval/admission step and less
automatic inclusion of old conversation material. Search and summarization can be
added later without weakening the same eligibility boundary.

## Rejected alternatives

- Direct chat-to-task execution: violates the authority hierarchy.
- Mutable message rows: destroys audit and replay integrity.
- Whole-thread prompts: unbounded, non-deterministic, and disclosure-prone.
- Trusting filename or MIME declarations: attacker-controlled metadata.
- Embedding raw uploads immediately: spreads unverified data into derived stores.
- Coupling handoff to the work engine: collapses proposal and authorization gates.
- Treating the Codex terminal as the supervisor: interactive turns have no durable
  liveness or auto-resume guarantee.
- Keeping sequence state only in systemd: process supervision is not workflow
  correctness and cannot replace database fencing, checkpoints, or evidence.
