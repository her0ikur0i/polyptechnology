# M10 — Redeploy to staging, owner acceptance checklist

Status: done, 2026-08-09. Redeployed the conversation workspace to the
existing CONTRACT-013 M9 private staging instance
(`polyp-control-api.service`, `127.0.0.1:4180`, reachable only via
`ssh -L 4180:127.0.0.1:4180 <host>`) -- no new host-level setup, same
loopback-only trust boundary as before.

## A real gap found before starting the service, not after

Before restarting the service, checked the new upload code
(`src/control-api/attachment-upload.ts`) against the systemd unit's
hardening profile (`deploy/systemd/polyp-control-api.service`). Its
`ReadWritePaths` allowlist is `/var/lib/polyp-ai-factory` and
`/var/log/polyp-ai-factory` only, under `ProtectSystem=strict`.
`config.ts`'s default `ATTACHMENT_STORAGE_ROOT`
(`/var/lib/polyp/attachments`) falls outside that allowlist -- uploads
would have failed closed with a mkdir error the first time anyone tried
one on staging. Fixed by adding
`ATTACHMENT_STORAGE_ROOT=/var/lib/polyp-ai-factory/attachments` to
`/etc/polyp-ai-factory/control-api.env` before starting the new release,
and confirmed live afterward: a real upload landed at
`/var/lib/polyp-ai-factory/attachments/<uuid>`, owned by `polyp-factory`,
inside the allowed tree.

## What was deployed

- New immutable release:
  `/opt/polyp-ai-factory/releases/20260809T135047Z-contract014-wip`
  (built from the current CONTRACT-014 working tree: `tsc` + `vite
build`, `npm ci --omit=dev`, root-owned/world-readable, matching the
  CONTRACT-013 M9 release's ownership convention exactly).
  `/opt/polyp-ai-factory/current` repointed to it.
- Migrations `0011_conversation_reply.sql`,
  `0012_blueprint_translation.sql`,
  `0013_conversation_session_management.sql` applied to the persistent
  `polyp-staging-pg` database (it already had the base `conversations`/
  `conversation_messages`/etc. tables from an earlier CONTRACT-006
  migration baseline, but not these three) -- confirmed after:
  `operation_task_specs_driver_check` now allows `conversation_reply`/
  `blueprint_translation`, `conversations.archived_at` exists.
- The background task-execution supervisor (`polyp-sequence.service`)
  remains not running on this host -- same CONTRACT-013 M9 decision 4,
  unchanged: standing up the conversation workspace does not by itself
  authorize real, costed provider calls.

## Live verification (real, against the running staging instance)

```
$ curl .../conversations -X POST ...            -> 201, real conversationId/projectId
$ curl .../conversations/:id/attachments -F ...  -> 201, file lands under
                                                     /var/lib/polyp-ai-factory/attachments/
$ curl .../conversations/:id/rename ...          -> 200, title changed, version incremented
$ curl .../conversations/:id/archive ...         -> 200, archivedAt set
$ curl .../projects/:id/conversations            -> [] (archived excluded from default list)
$ curl .../projects/:id/conversations?includeArchived=true -> [1 row]
$ curl .../conversations/:id/archive (unarchive) -> 200, archivedAt cleared
$ curl .../conversations/:id/messages -X POST    -> 201, message appended, replyTaskId returned
$ curl .../reply-tasks/:taskId                   -> {"state":"queued"} (supervisor not running,
                                                     confirms the route queues, never executes inline)
$ curl http://127.0.0.1:4180/                    -> 200, real SPA HTML
```

The queued reply task from this drill was cancelled afterward
(`UPDATE tasks SET state='cancelled' ...`) to leave staging clean, same
housekeeping this contract's own tests do for every queued task they
create.

## Test evidence

No code changes this milestone beyond the env file (deployment-only).
Full suite unchanged from M9 (178 tests, 177 pass, 1 pre-existing skip);
`npm run dashboard:test` (20/20); `npm run typecheck`; `npm run
dashboard:build`; `scripts/verify-contract.ts CONTRACT-014` all pass.

## Deliverable

`docs/contracts/CONTRACT-014/acceptance-checklist.md` -- maps
`contract.md`'s five acceptance bullets to status and evidence, plus
testable scenarios for the owner to run by hand on staging.
