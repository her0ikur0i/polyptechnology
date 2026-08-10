# Telegram live probe — 2026-08-10

Not a milestone. Deliberately named without an `M<n>-` prefix, because
`docs/RESUME.md`'s resume protocol treats the presence of `M<n>-*.md` as the
authoritative signal that milestone `n` is complete, and M9 is not.

## What this closes

`docs/contracts/CONTRACT-010/owner-action-bundle.md` has listed a **Telegram
live probe** as an outstanding owner-authority action since CONTRACT-010, and
`docs/RESUME.md` repeated it as still needing fresh approval. Every contract
since has deliberately avoided it: deterministic tests never send live Telegram
messages, and CONTRACT-013 M9 stood up staging with no Telegram configuration at
all.

The owner authorised it directly on 2026-08-10 — "lakukan pengujian dengan
mengirim pesan report langsung ke saya" — and supplied the location of the
credentials. The probe ran and succeeded.

## What was verified, and how

Credentials were found in `/root/.config/polyp/provider-secrets.env`
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Values were never printed to the
transcript; only their presence and length were checked.

1. `getMe` → HTTP 200. The bot resolves as `@PolypTech_bot` (id `8608017874`).
   This proves the stored token is valid, which nothing had confirmed before.
2. A status report was delivered to the owner's chat **through
   `TelegramHttpTransport` from `src/telegram/gateway.ts`**, not through `curl`.
   That choice is the point of the exercise: a probe that bypasses the
   production transport proves Telegram is reachable but proves nothing about
   this system's ability to reach it.

## A real failure, and what it was not

The first attempt threw. It was **not** a credential or connectivity problem: a
subsequent minimal `sendMessage` with `parse_mode: MarkdownV2` returned HTTP 200
from the same token and chat.

The cause was MarkdownV2 escaping in the report's own content — that dialect
requires escaping a long list of characters, and text discussing file paths,
parentheses and code identifiers trips it constantly. The report was resent as
plain text and delivered.

Recorded because it is a real operational lesson for M9: **notification content
assembled from system data must not be sent as MarkdownV2 without escaping**, or
a malformed run report will silently fail to reach the owner precisely when
something has gone wrong and they most need it. M9 should either escape
rigorously or send plain text and accept the loss of formatting.

## What this does not authorise

Nothing beyond the probe itself. `polyp-control-api.service` still runs with no
Telegram configuration, so `/api/v1/telegram/webhook` remains unregistered on
staging and inbound callbacks are still impossible. Wiring Telegram into the
running instance is M9's work, under the standing advance authority, and the
inbound direction carries its own security review in M10 because it is a second
ingress for untrusted text.
