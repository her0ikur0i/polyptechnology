# M0 — Owner confirmation gate

Date: 2026-08-10. Status: **done**.

## Authority

Already granted, in advance, for every contract in the roadmap
(`docs/contracts/CONTRACT-015/evidence/M0-owner-confirmation.md` §2): staging
redeploy, the single contract commit, and the push proceed without a further
pause once gates are green. The owner then instructed "jalankan sequence sampai
semua contract selesai" — run the sequence until every contract is finished —
which confirms the roadmap's scope rather than reopening it.

**Still outside that authority, unchanged:** public DNS or Cloudflare cutover,
public hostname exposure, production promotion,
`polyptech-dashboard.service`, and anything secret-impacting or irreversible.
Two of those bind later contracts and are flagged now so nobody is surprised at
the time: CONTRACT-020's public cutover, and its closing full-factory drill,
which needs live provider credentials.

**One boundary this contract inherits and does not cross:**
`polyp-sequence.service` stays off. Starting it authorizes real, costed
provider calls, which CONTRACT-013 M9 decision 4 deliberately withheld and no
grant since has extended. Streaming is therefore verified against the real
adapter code path with a controlled process, not by spending money on staging.

## The architecture decision, and the two alternatives refused

Recorded here because it shapes every milestone and because the cheap options
are the tempting ones.

Three facts were established by reading the code before drafting, not assumed:

1. Chat replies route to **Claude through the CLI adapter**
   (`src/gateway/model-policy.ts`, task class `orchestration`), which invokes
   `execFile` with `--output-format json` — the entire completion is buffered
   before anything returns.
2. The reply is produced by `ConversationReplyDriver` inside
   **`polyp-sequence.service`**, a different process from the Control API that
   will hold the SSE connection. Tokens must cross a process boundary.
3. `conversation_messages` has **no notion of a partial message**; a row exists
   only once the reply is complete.

So token streaming cannot be a client-side change. It needs the adapter to
stream, the chunks to be durable enough to cross processes and survive a
restart, and only then an SSE route to tail them. That is the chosen path.

**Refused — inline replies in the Control API.** This would make streaming
trivial. CONTRACT-014 M2 deliberately made replies a background task and never
inline; going inline loses durability, loses the work engine's leasing and
budget accounting, and ties a costed provider call to the lifetime of a browser
connection. A progress indicator is not worth breaking the execution model.

**Refused — streaming state transitions only.** Pushing `queued → running →
succeeded` over SSE without token text would be a real improvement over the
1.5-second poll for a fraction of the effort. It is still not what goal 2 asks
for, and the owner's standing instruction on this class of work is explicit:
_"tentu saja nyata, we're doing real work here, not dummy."_

## Scope confirmations carried from CONTRACT-015 M0

- **Telegram becomes a full conversational entry point**, the deeper of the two
  options the owner chose. It opens a second ingress for untrusted text, so M10
  carries a dedicated security review of the authority boundary in
  `docs/architecture/adr-0002-conversation-authority-boundary.md`.
- **The current visual language stays.** The design system is CONTRACT-018's
  work; delivering behaviour and appearance in one contract would make a
  behaviour regression and a restyling indistinguishable.

## Baseline locked before any change

```
# tests 193
# pass 193
# fail 0
# skipped 0
```

Measured with the standing zero-skip invocation from `CLAUDE.md`.
`scripts/verify-contract.ts CONTRACT-016`: structure and scope OK.
