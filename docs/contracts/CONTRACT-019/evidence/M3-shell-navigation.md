# CONTRACT-019 M3 Evidence — Shell and Navigation Polish

## Status

M3 is complete.

## DeepSeek Attempt

The bounded M3 implementation brief was attempted through the local managed
DeepSeek gateway:

- Script: `scripts/managed-deepseek-task.ts`
- Contract: `CONTRACT-019`
- Milestone: `M3`
- Task class: `bulk_code`
- Result: rejected before model invocation with `gateway budget unavailable or
exhausted`

Because the request did not reach DeepSeek and M3 was a narrow route/label slice,
Codex performed the smallest integration required to avoid stopping the
contract. No fallback to Claude was used.

## Implementation

Changed files:

- `src/dashboard/app.tsx`
- `tests/dashboard/app.test.tsx`

Dashboard shell changes:

- Primary rail now follows the M1 owner-facing order:
  - Overview
  - Chat
  - Projects
  - Runs
  - Approvals
  - Factory Live
  - Models
  - Telegram
  - System
  - Settings
- `/runs` now aliases the current contracts/runs registry data.
- `/telegram` now points directly to the existing Telegram settings surface.
- `/system` now aliases the infrastructure/system placeholder.
- Backward-compatible routes remain addressable:
  - `/contracts`
  - `/infrastructure`
  - `/policy`
  - `/agents`
  - `/settings`
- The dashboard test router accepts an `initialPath` so secondary routes can be
  tested without putting every addressable route in the primary rail.

M3 deliberately avoided:

- visual redesign;
- Telegram command/test implementation, which belongs to M4;
- policy/model selector changes, which belong to M5/M8;
- authenticated hostname cutover, which remains blocked until Cloudflare Access
  is verified.

## Validation

Commands run:

- `npm run dashboard:test`
  - 6 files passed
  - 50 tests passed
- `npm run typecheck`
  - passed
- `npm run format:check`
  - passed

## Notes

`/policy` remains addressable but is no longer in the primary rail. This matches
M1: policy may be progressively disclosed while Models and System stay in the
daily rail.

The Settings route intentionally still renders the existing reference-only
Telegram settings surface for backward compatibility. M4 will split Telegram
operations into a fuller direct page with test actions and report quietness
rules.

## Next Step

Proceed to M4: Telegram settings and test panel.
