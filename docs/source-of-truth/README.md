# Source Of Truth

This folder is the canonical document control surface for the factory.
Operational agents should start here before changing product behavior,
architecture, security posture, model routing, deployment, or recovery logic.

The rule is simple: if a document governs what the system is, why it exists,
how it is built, how it is operated, or who may authorize changes, it belongs
under this tree or is indexed here as a canonical external document.

## Standard Structure

- `product/` - product intent, PRD, roadmap, release criteria, SRS.
- `architecture/` - technical architecture, TAD, ADR index, boundaries.
- `security/` - auth, approval levels, threat model, release hardening.
- `operations/` - runbooks, resume notes, checkpoints, disaster recovery.
- `ai/` - master prompt, agent identity, model routing, generation standards.
- `quality/` - acceptance criteria, test strategy, verification gates.
- `contracts/` - contract index and delivery evidence map.

## Change Rule

When a source-of-truth document changes, update the matching implementation,
tests, and operational evidence in the same work item. Do not let docs describe
a capability that the running service cannot prove.
