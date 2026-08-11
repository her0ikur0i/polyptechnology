# M0 — Owner confirmation

Date: 2026-08-11. Status: **done — answered in advance, not asked again.**

This contract's M0 questions were put to the owner **before CONTRACT-017B
started**, in the batch that covered 017B, 017A and 018 together. The standing
rule is that confirmations go at the front, and that a chain of contracts asks
the whole chain's questions in one round rather than one round per contract.
So there was no owner checkpoint at the start of this contract, by design.

The answers live in
`docs/contracts/CONTRACT-017B/evidence/M0-owner-confirmation.md`. This file
exists so that record is discoverable from the contract it governs, and so the
generated resume checkpoint stops reporting M0 as the next action on a contract
whose work is finished.

## What was decided

1. **Session storage: a side table** `conversation_provider_sessions`, keyed by
   `(conversation_id, provider_id)` — not a column on `conversations`. A
   conversation can hold a live Claude session and a dead DeepSeek one at the
   same time, and the `deepseek → codex → claude` escalation chain means the
   "one provider per conversation" assumption behind a single column would not
   survive its first escalation.
2. **Retry identity: each attempt is its own ledger entry**, keyed per
   `(task, attempt)`. Rewriting the first attempt's request hash was
   considered and declined: it overwrites the record the ledger exists to keep.
   A retry is a new reservation and a new audit row, which is what actually
   happened.

## Standing authority applied

From the same batch, unchanged: the staging redeploy, the single contract
commit and the push proceed without a further pause once gates are green;
`/security-review` runs before the push and its findings are fixed first;
`README.md` is updated at close; commits are authored `heroikuroi`; and a
successful push rolls straight into CONTRACT-018 rather than stopping to ask
what is next.

It does **not** extend to public DNS or Cloudflare cutover, public hostname
exposure, production promotion, `polyptech-dashboard.service`, or anything
secret-impacting or irreversible. Nothing in this contract needed any of them.
