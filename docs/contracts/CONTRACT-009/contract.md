# CONTRACT-009 — Knowledge curation, blueprints, and generated-project lifecycle

Status: accepted

## Objective

Implement the durable, policy-bound project factory domain: versioned blueprints,
isolated generated-project lifecycle, capacity-aware scheduling, and scoped reusable
knowledge with deletion-aware derived-index tracking.

## Scope

- PostgreSQL schema for blueprints, blueprint versions, generated projects,
  lifecycle transitions, resource reservations, and knowledge provenance.
- Strict versioned blueprint validation covering stack, requirements, quality gates,
  capabilities, resource envelope, and lifecycle policy.
- Dynamic project registry and guarded idea-to-export/delete lifecycle with immutable
  transition evidence; no project names or stacks hard-coded in the control plane.
- Fair capacity admission for the initial host, bounded by global/provider/project
  concurrency, priority, interactive preference, disk watermark, and budget state.
- Knowledge candidate/verification/curation/reuse/deprecation lifecycle with
  classification, license, dependency, confidence, scope, provenance, and selective
  metadata/full-text retrieval.
- Project-factory and knowledge services, deterministic and PostgreSQL integration
  tests, architecture/operations documentation, and final review/evidence.

## Out of scope

Production provisioning, DNS, secret creation or rotation, deployment, destructive
project deletion, embedding generation, vector databases, fine-tuning, UI redesign,
and executing an irreversible external lifecycle action.

## Risks

Cross-project knowledge leakage, prompt-only/unversioned blueprints, generated
projects coupled into the dashboard, invalid lifecycle jumps, duplicate creation,
resource starvation, unsafe capability escalation, license loss, stale derived
indexes, and deletion without explicit approval.

## Budget

DeepSeek is the primary domain/schema worker. Codex integrates and verifies. Claude
performs bounded isolation/lifecycle specialist review. Every managed call records
the concrete requested/resolved model, tokens, cache, cost, outcome, and evidence.

## Capability envelope

L0 inspection; L1 owned source/schema/test/documentation changes and local database
fixtures; L2 bounded managed-provider analysis/review. No production, DNS, secret,
external repository, deployment, or destructive capability.

## Milestones

1. M1: domain ADR, threat model, blueprint and lifecycle invariants.
2. M2: blueprint/project schema, validation, registry, and transition service.
3. M3: capacity scheduler and isolated resource/capability admission plan.
4. M4: knowledge schema, scoped lifecycle, retrieval, supersession, and erasure plan.
5. M5: deterministic and PostgreSQL restart/idempotency/isolation tests.
6. M6: independent review, remediation, evidence, and final gates.

## Gates

- Blueprints are validated versioned data and immutable after publication.
- Project identity, repository/workspace/database/secret namespaces are dynamic and
  isolated references; generated products never become dashboard modules.
- Lifecycle transitions are legal, idempotent, fenced, audited, and approval-gated
  before production/archive/export/delete side effects.
- Scheduling cannot exceed host/provider/project/budget/disk constraints and cannot
  starve ordinary work indefinitely.
- Retrieval fails closed across scope/classification boundaries and raw private
  logs/source are never promoted or embedded by default.
- Source deletion produces a durable purge plan for every derived index.
- Locked install, migrations, typecheck, tests, audit, scope, diff, and secret scan
  pass before publication.

## Acceptance

- An arbitrary valid blueprint can create a dynamic project record and safely
  traverse non-production lifecycle states without duplicate work.
- Invalid transitions, unsafe namespace/path references, capability escalation,
  capacity exhaustion, and cross-project knowledge retrieval are rejected.
- Verified curated knowledge can be selectively retrieved with complete provenance;
  superseded/deprecated/private items are excluded by default.
- Reconstructing services from PostgreSQL preserves project, blueprint, scheduling,
  knowledge, and idempotency state.

## Evidence

Recorded in `docs/contracts/CONTRACT-009/evidence.md`.

## Rollback

Revert the single contract commit and apply the documented forward-only database
rollback procedure in a disposable environment. No production resource is created.

## Completion policy

All gates pass before exactly one commit and push, then continue to CONTRACT-010.

## File ownership

- `docs/RESUME.md`
- `docs/architecture/**`
- `docs/operations/**`
- `docs/contracts/CONTRACT-009/**`
- `migrations/0006_factory_knowledge.sql`
- `src/factory/**`
- `src/knowledge/**`
- `tests/factory.test.ts`
- `tests/knowledge.test.ts`
- `tests/factory-knowledge-postgres.integration.test.ts`
