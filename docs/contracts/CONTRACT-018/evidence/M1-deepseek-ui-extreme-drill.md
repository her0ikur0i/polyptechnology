# M1 — DeepSeek UI Extreme Drill

Date: 2026-08-13. Status: passed.

This evidence records the heavy UI/UX drill requested before resuming frontend
work. It uses the owner direction captured in M0: claude.ai-like product shell,
whole-application scope, multi-provider model selection, visible agent progress,
and the Polyptech/Gource-style Factory Live reference.

## Drill

Command:

`PROJECT_WORKSPACES_ROOT=/var/lib/polyp-ai-factory/project-workspaces node --import tsx scripts/generation-drill.ts deepseek-diff-ui-extreme-20260813-1040 ui-extreme`

Result:

- Reached: publication
- Project: `5b96ccb8-e282-5445-937a-344f0de5eab1`
- Conversation: `2c4c4f1e-28db-55ac-968b-afbd64d357ce`
- Translation task: `2a1147b6-1df8-4c8e-bb77-591c7ed19fa7`
- Generation: 9 phases
- DeepSeek route: phases 1-8 accepted by `deepseek-v4-flash`; phase 9 rejected
  once, then accepted by `deepseek-v4-flash`
- Verification: `isolated-worker-v1`, by `deepseek:deepseek-v4-flash`
- Changed lines: 558
- Publication commit: `689a523f5df0`
- Working tree: clean

## Review Artifact

Generated repo:

`/var/lib/polyp-ai-factory/project-workspaces/5b96ccb8-e282-5445-937a-344f0de5eab1/repo`

Review file:

`review.html`

Refero/domain-hardened review artifact in this repository:

`docs/contracts/CONTRACT-018/review/deepseek-refero-ui-domain.html`

The follow-up artifact applies the owner-provided Refero/Auros target:
near-black teal surface stack (`#011d1c`, `#012624`, `#003734`),
lavender-phosphor statistics (`#fde9ff`), instrument labels, a
CSS-only data-orb/particle-field centerpiece, and explicit AI DevOps factory
vocabulary. A domain guard removed biology/cultivation metaphors from the
artifact; `bioluminescent` remains only as a visual treatment.

Local review URL while the preview server is running:

`http://127.0.0.1:8765/deepseek-refero-ui-domain.html`

Cloudflare quick tunnel was attempted twice. Both hostnames were created, but
returned Cloudflare-side 404 before requests reached the local preview server,
so the public tunnel is recorded as a preview-infrastructure issue rather than
a generation failure.

## Follow-up

The drill runner now allows at least 60 minutes for `extreme` and `ui-extreme`
generation tasks. The old 15-minute cap was too small for heavy UI work and
could terminate a valid long-running provider attempt before it produced useful
evidence.

## Validation

- `npm run typecheck` — passed.
- `npm run format:check` — passed.
- `npm test` — passed with 400 tests, 359 pass, 41 environment-gated skips.
- Zero-skip suite with the live sequence service stopped and the documented
  digest-pinned worker image:
  `TEST_DATABASE_URL=... TEST_WORKER_IMAGE=postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 TEST_SCAFFOLD_GATES=enabled npm test`
  — passed with 433 tests, 433 pass, 0 fail, 0 skipped.

The first zero-skip attempt intentionally did not get counted as acceptance
evidence because it used the mutable tag `postgres:16-alpine` and failed the
worker planner's digest-pin gate. The passing run used the pinned image already
documented in `README.md` and `CLAUDE.md`.
