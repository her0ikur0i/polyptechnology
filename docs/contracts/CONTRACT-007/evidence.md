# CONTRACT-007 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR-0003 records the browser/control-plane boundary, typed observed state,
  query/command separation, concrete model identity, and reference-only secrets.
- M2: React 19/Vite 8 shell, semantic landmarks, skip navigation, responsive
  off-canvas navigation, focus return, design tokens, reduced motion, and explicit
  status semantics beyond color.
- M3: overview, attention, sequence, dynamic project/contract/approval registries,
  managed model attempts, and route-complete operational navigation without fixed
  generated projects or fabricated fallback values.
- M4: provider/model token/cache/cost/outcome/verification view and Telegram
  reference/authorized-identity configuration command with same-origin credentials,
  CSRF token, local validation, readiness, and paid-probe separation.
- M5: runtime payload validation, component/command/state/mobile/accessibility tests,
  responsive CSS, production bundle, and integrated repository verification.
- M6: managed UI/accessibility review, remediation, final independent fallback
  review, dependency compatibility check, evidence, and final gates.

## Architecture and review decisions

The dashboard never manufactures operational values. Every dataset carries source,
observation time, freshness, and issues; empty, stale, partial, error, loading, and
unauthorized states remain distinguishable. Browser types structurally exclude raw
Telegram tokens. Settings accept only `secret://` references and numeric authorized
identities, while the server remains authoritative for authentication, CSRF,
approval, and persistence.

DeepSeek V4 Flash supplied the primary UI implementation analysis. Codex rejected
its unnecessary global-state recommendation and unrelated external-system
assumptions, then integrated its useful async-state, navigation, model-tracking,
and reference-only configuration patterns into the bounded modular SPA.

Claude Sonnet 5 independently found hidden mobile navigation remaining keyboard
reachable, incomplete toggle semantics, swallowed settings errors, and a misleading
pending-approval count. All findings were repaired: compact navigation becomes
inert/hidden until opened, focus and `aria-expanded`/`aria-controls` are managed,
command errors retain their cause, and only pending records are counted. A final
DeepSeek V4 Pro independent review reported no critical/high findings.

## Final verification

- Strict TypeScript typecheck: passed.
- Existing deterministic/backend suite with PostgreSQL: 54 passed; the unchanged
  digest-pinned Docker test remained environment-gated and was proven in
  CONTRACT-005.
- Dashboard suite: 9 passed across component, mobile navigation, state rendering,
  payload validation, CSRF command, secret-reference, and accessibility coverage.
- Axe semantic scan: no violations with color contrast excluded from jsdom; direct
  token contrast checks ranged from 6.84:1 to 15.17:1 for operational foregrounds.
- Production Vite build: passed; JS 252.61 kB / 81.05 kB gzip, CSS 7.14 kB /
  2.42 kB gzip, HTML 0.44 kB / 0.28 kB gzip.
- Final verification artifact SHA-256:
  `ff1e6c485bf8a4116db3360a2c114c76e8e2c6aa5fff96b4fd34d5e4b6c732fe`.
- Locked install and dependency audit: zero known vulnerabilities.
- No public deployment, DNS, secret value, Telegram live probe, or generated-project
  mutation occurred.

## Provider and model tracking

- DeepSeek `deepseek-v4-flash`, role `bulk-coder`: attempt
  `00d9c732-b2e9-4294-9001-d7692d07c08a`; 190 input, 3,778 output, 0
  reasoning/cache tokens; USD 0.001085; succeeded and passed Codex integration
  verification. Useful patterns were integrated; unrelated assumptions and excess
  dependencies were explicitly rejected.
- Claude `claude-sonnet-5`, role `specialist-reviewer`: attempt
  `2053f364-ff5f-47b3-adfa-b3e91464ab33`; primary slice 2 input, 7,563 output,
  16,275 cache-read, 22,068 cache-write tokens; auxiliary
  `claude-haiku-4-5-20251001` slice 11,057 input and 14 output tokens; USD 0.261870
  total; succeeded. Four material findings were remediated and passed
  `codex-review-triage-v1` verification.
- DeepSeek `deepseek-v4-pro` non-thinking, role `independent-review-fallback`:
  attempt `71e0061e-b029-4d73-936e-43b1ace42d71`; 6,200 input, 8 output, 0
  reasoning/cache tokens; USD 0.002704; succeeded with no critical/high findings.
- DeepSeek `deepseek-v4-pro` non-thinking, final dependency compatibility check:
  attempt `e93c10db-2cef-43e0-98bc-331c3ff4cd07`; 125 input, 8 output, 0
  reasoning/cache tokens; USD 0.000062; succeeded and passed final-gate verification
  against the final artifact digest.
- Codex orchestrated, filtered worker output, integrated repairs, and ran final
  deterministic gates. No separate Codex Gateway inference was needed, therefore
  application-ledger Codex tokens and cost are 0.

Total managed-provider cost: USD 0.265721.
