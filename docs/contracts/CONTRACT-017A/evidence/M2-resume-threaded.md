# M2 — Resume, from the driver to the CLI

Date: 2026-08-11. Status: **done**.

## The path

`GatewayRequest.resumeSessionId` → `AiGateway.execute()` → the adapter's
`invoke`/`invokeStreaming` → `--resume <id>` on the CLI.

Optional at every layer, deliberately. An adapter that does not support
sessions ignores the argument; a caller with no stored session omits it and
sends the full history, which is what every call did before this contract. The
degraded path is the old path, so nothing here can cost an answer.

`--resume` is placed first in the argument list so a malformed id fails the
invocation immediately rather than after the CLI has parsed a prompt, and it
travels as its own argv element — never concatenated into a string a shell
would parse.

## What the driver now sends

```
no session   →  2 system messages + the entire thread     (as before)
session      →  2 system messages + the last turn only
```

That is the whole cost saving. The provider already holds everything before the
last message; re-sending it is what made a long thread more expensive per turn
than a short one.

After a successful exchange the driver stores `result.attempt.providerRequestId`
against `(conversation, provider)`. That value has always been returned by the
CLI and always been written to the attempt row — holding it against the
conversation is the only genuinely new step.

## The failure nobody announces

Sessions expire and the provider does not warn you. When a turn that attempted
a resume fails, the driver **drops the stored session and rethrows**. The work
engine's own retry — with the real backoff from CONTRACT-017B — then finds no
session and replays the transcript from scratch.

Two decisions inside that, both deliberate:

**Not retried in-process.** A second gateway call inside one attempt would need
its own ledger identity and its own budget reservation, machinery that already
exists one layer up and is tested there. The cost of deferring is one silent
retry cycle: the owner sees the answer a moment later, not a failure, because
retries stopped being reported in CONTRACT-017B.

**Unconditional on the resume path**, rather than pattern-matching provider
error strings to decide whether the session is specifically what died. Guessing
at a provider's error text is exactly what produced "provider returned unusable
output" for failures that never reached a provider. Dropping a live session
costs one replayed turn; keeping a dead one costs every turn after it.

## Tests

`tests/conversation-resume.test.ts`, 7 passing:

- no session → the whole transcript, no resume argument
- a session → one conversational message and the resume id
- the returned session id is remembered against the conversation
- a provider that reports no session leaves nothing stored
- a driver constructed without a session store behaves exactly as before
- a failed resume drops the session
- a cold-start failure drops nothing, because there was nothing to drop
