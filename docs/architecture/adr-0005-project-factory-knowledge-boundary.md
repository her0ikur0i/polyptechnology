# ADR-0005: Generated projects and reusable knowledge remain isolated domains

- Status: accepted
- Date: 2026-08-08
- Contract: CONTRACT-009

## Decision

A blueprint is immutable, versioned, runtime-validated data. It declares stack and
quality requirements plus a least-privilege capability/resource envelope; prompt
text can explain a blueprint but cannot replace or authorize it. A generated
project is a dynamic registry record whose repository, workspace, database, secret
namespace, budgets, and deployment targets are references owned by that project.
It never adds routes, imports, tables, or special cases to the Master Dashboard.

Lifecycle changes use an explicit transition graph and idempotency key. Transitions
record actor, correlation, evidence, prior/new state, and fencing version. Moving
into production, archive, export, or deletion may prepare a plan but requires a
separate scoped approval before any external or destructive effect. This contract
does not exercise those capabilities.

Capacity admission is deterministic and fail-closed. Global, provider, and project
concurrency, CPU/memory/disk reservations, disk watermark, budget state, priority,
and bounded aging decide eligibility. Interactive work receives a bounded boost,
not an unlimited bypass. Reservations expire and are fenced against stale release.

Knowledge is not raw execution history. Items carry provenance, license,
classification, confidence, verification evidence, dependencies, version, and
scope. Promotion follows candidate -> verified -> curated -> reusable; deprecated
or superseded items are excluded by default. Project/private data never enters a
global result. Initial retrieval uses metadata and bounded full-text matching only.
Derived indexes record their source, so erasure creates an auditable purge plan.

## Consequences

The same control plane can generate unrelated products without coupling them to
itself. Reuse remains explainable and revocable. Explicit lifecycle and scheduling
state adds schema and tests, but avoids hidden prompt authority, cross-tenant leaks,
and host overload.

## Rejected alternatives

- Prompt-only blueprints: not versionable, auditable, or safely validated.
- Generated-project dashboard modules: violates product isolation and cannot scale.
- Global vectorization of logs/source: leaks scope and complicates erasure.
- FIFO without aging or resource checks: permits starvation and host exhaustion.
- Lifecycle side effects inside state updates: makes retries and approval unsafe.
