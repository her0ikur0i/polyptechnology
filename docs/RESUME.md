# Resume checkpoint

## Active objective

Build and finish the Polyp AI Factory Master Dashboard described in
`docs/SYSTEM-SPECIFICATION.md`.

## Owner constraints

- Codex is the persistent primary orchestrator/architect/reviewer.
- DeepSeek is the default bulk coder; other models may be used by policy.
- Work is divided into small contracts containing several milestones.
- Commit and push exactly once after a whole contract passes, never per milestone.
- Do not request approval for ordinary work. Ask only for destructive,
  irreversible, production, DNS, or secret-impacting operations.
- Do not hard-code Surachman Center or Instalova; they are future generated
  projects among an unbounded dynamic registry.
- Keep UI/UX high quality and somewhat decorative, but resource-efficient.
- Reuse mature technology, avoid overengineering, preserve security.
- Immediately after the clean foundation, deliver Telegram Approve/Deny remote
  approval with authorized chat/user IDs, expiry, single-use tokens, and audit.

## Workspace

Canonical new system: `/root/polyptechnology-next`.

The old `/opt/master-orchestrator` and `/root/master-dashboard-mockup` were
authorized for deletion before restart. Operational secrets must be preserved
outside source control without reading or printing them.

## Current contract

`CONTRACT-001 — Product truth and safe foundation`.

New work already present: strict project manifest/config tests, agent policy,
product/architecture/security docs, contract verifier, and this canonical system
specification. Complete cleanup, generate a fresh lockfile/dependency installation,
run all Contract 001 gates, commit, and push only when green.

The GitHub remote still contains legacy history. On successful CONTRACT-001,
publish the new orphan `main` as the clean canonical baseline (a destructive
history replacement explicitly requested by the owner), then continue with the
durable approval/Telegram contract.

## Resume instruction

Read this file, `AGENTS.md`, `docs/SYSTEM-SPECIFICATION.md`, and the active contract
before taking action. Inspect Git status and filesystem state because the previous
managed session may have been interrupted during cleanup. Continue the active
goal; do not restart planning or restore legacy code.

## Expected session profile

Launch Codex with:

```bash
codex --sandbox danger-full-access --ask-for-approval on-request
```

Reopen the same thread and say `resume active goal`.
