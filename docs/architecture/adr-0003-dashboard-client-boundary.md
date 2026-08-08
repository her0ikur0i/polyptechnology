# ADR-0003: Operational dashboard client boundary

- Status: accepted
- Date: 2026-08-08
- Contract: CONTRACT-007

## Decision

Build a browser-only React and TypeScript SPA with Vite. The dashboard consumes
versioned typed control-plane representations; it never reads PostgreSQL, provider
credentials, service files, or host state directly. Queries and commands are
separate. Every command requires authenticated server enforcement and an explicit
approval-aware representation; disabling a button is not authorization.

Operational values carry observation time, freshness, completeness, provenance,
and error metadata. Components render state rather than manufacturing fallback
numbers. Concrete requested and resolved model identifiers are first-class fields;
aliases may be labels but never audit identity. Secret settings accept and display
references only, with values structurally absent from client types.

Use a small modular SPA and native platform capabilities. Routes share a semantic
application shell, design tokens, view-state primitives, and accessible tables/
cards. Decorative treatment communicates hierarchy and verified state without
meaningless charts. Factory Live remains a later isolated visualization module.

## Consequences

The UI can be developed and tested against deterministic fixtures while retaining
the same runtime contracts. Backend authentication remains authoritative. Explicit
partial/stale states add some component complexity but prevent false confidence.

## Rejected alternatives

- Server-side rendering: no current SEO or first-paint requirement justifies it.
- Direct database/host access: violates the control-plane and security boundary.
- One generic JSON renderer: weak semantics and inaccessible interaction.
- Global client state framework initially: current requirements fit query-local
  state and immutable typed snapshots.
- Hard-coded project/provider cards: violates dynamic registry requirements.
