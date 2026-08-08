# CONTRACT-007 — React operational dashboard and design system

Status: accepted

## Objective

Deliver the authenticated, accessible, responsive Master Dashboard shell and its
operational views over real typed API contracts, including owner-visible provider,
model, cost, sequence, approval, and Telegram configuration state.

## Scope

- React, TypeScript, and Vite SPA with a reusable token-based design system.
- Authenticated application shell, navigation, overview, contracts/runs, projects,
  agents, providers/models, approvals, infrastructure, and settings routes.
- Real typed API client and explicit loading, empty, partial, stale, error, and
  unauthorized states; no hard-coded generated projects or fabricated telemetry.
- Provider/model tracking summaries with requested/resolved IDs, role, token/cache,
  cost, outcome, verification, and artifact/gate provenance.
- Telegram settings UI for secret reference, authorized chat/user identities,
  readiness, live-probe separation, and approval-channel status without exposing
  secret values.
- Accessible responsive desktop-first interaction, reduced motion, keyboard
  navigation, component tests, production build, and architecture evidence.

## Out of scope

Factory Live canvas, project generation, public deployment, DNS, secret values,
production configuration mutation, and generated-project-specific modules.

## Risks

Decorative but misleading telemetry, anonymous mutation, secret disclosure,
inaccessible navigation, stale state presented as current, bundle bloat, and UI
coupling to fixed projects or provider aliases.

## Budget

DeepSeek is the primary UI implementation worker. Claude performs bounded visual/
accessibility review when available. All calls use the managed gateway and final
summary tracking.

## Capability envelope

L0 inspection; L1 owned source/dependency/test changes and local build; L2 bounded
provider implementation/review. No production, DNS, or secret mutation.

## Milestones

1. M1: dashboard ADR, information architecture, typed API/view-state contracts.
2. M2: design tokens, accessible shell, navigation, responsive foundations.
3. M3: overview and operational registry/run/provider/approval views.
4. M4: settings including Telegram and concrete model-routing visibility.
5. M5: component/accessibility/responsive tests and production build.
6. M6: independent review, remediation, evidence, final gates.

## Gates

- No secret value, fake operational metric, anonymous mutation, or hard-coded
  generated project appears in the client bundle or source.
- Every operational panel renders loading, empty, stale/partial, error, and ready
  semantics appropriate to its data.
- Status meaning is not color-only; keyboard focus, labels, landmarks, contrast,
  reduced motion, and responsive navigation are verified.
- Locked install, typecheck, component tests, production build, dependency audit,
  scope, diff, and secret scan pass.

## Acceptance

- Owner can navigate all primary control-plane areas from a coherent dashboard.
- Overview exposes attention, approvals, sequence health, verified costs, and stale
  data without inventing values.
- Providers/models show concrete requested/resolved model tracking and outcomes.
- Telegram configuration is visible and editable only as references/authorized
  identities through approval-aware typed commands; readiness and paid probe are
  explicitly distinct.
- The application remains useful on narrow screens and with reduced motion.

## Evidence

Recorded in `docs/contracts/CONTRACT-007/evidence.md`.

## Rollback

Revert the single contract commit; no production deployment is performed.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-008.

## File ownership

- `README.md`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `index.html`
- `tsconfig.json`
- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/contracts/CONTRACT-007/**`
- `src/dashboard/**`
- `tests/dashboard/**`
- `vite.config.ts`
