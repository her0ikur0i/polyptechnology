# CONTRACT-003 evidence

Date: 2026-08-08

## Milestones

- M1: provider/account/model/evaluation/usage types, lifecycle, explicit additive
  PostgreSQL migration, effective-dated non-overlapping pricing.
- M2: provider-neutral adapter contract, normalized errors, deterministic fake,
  and secret-reference-only registry.
- M3: all six routing modes, fail-closed eligibility, micro-dollar estimates,
  empirical ranking, explanations, bounded fallback, and budget blocking.
- M4: immutable evaluations/usage and complete provider/account/model/agent/
  project/contract/task/attempt attribution.
- M5: operations policy, regression tests, independent review, and final gates.

## Provider reviews

DeepSeek V4 Flash supplied the bounded domain/invariant blueprint. Claude Sonnet
exhausted two bounded review turn budgets without output. Per routing policy the
review escalated to Claude Opus, which found five high-severity issues: provider
kill-switch omission, policy-locked fail-open behavior, unsafe evaluation
fallback, overlapping price versions, and weak attribution integrity. Codex
repaired all five; Opus re-review confirmed them fixed. Two lower-severity
defense-in-depth observations were also repaired.

## Final verification

Locked install, strict typecheck, deterministic tests, contract scope, dependency
audit, staged diff hygiene, and staged secret scan must all pass immediately
before the single contract commit. No paid runtime inference, secret mutation,
live provider activation, or production mutation occurs.
