# Telegram approval operations

## Configuration

Runtime configuration requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
`TELEGRAM_USER_ID`. Production startup fails if any value is absent. The bot
token must never appear in logs, callback data, events, audit payloads, or model
context.

## Delivery and decisions

An approval is persisted as pending before Telegram delivery. Delivery failure
does not approve or deny it. Callback data contains only an opaque 256-bit token;
persistence contains only its SHA-256 digest. Both configured chat and user IDs
must match. Decisions use a row lock and append their event and audit record in
the same transaction.

## Recovery

Pending approvals survive API restarts until expiry. Failed delivery may be
retried while pending. Replayed terminal decisions are rejected. Telegram outage
never grants authority; a future authenticated dashboard may decide the request.

## Live activation

This contract does not configure a webhook or send a live message. A later
deployment capability must resolve the owner `TELEGRAM_USER_ID`, configure an
authenticated HTTPS webhook with secret-header validation, send one canary
approval, and confirm its immutable audit trail.
