# Approval levels

- L0: read-only inspection; automatic.
- L1: reversible project-workspace change; contract capability required.
- L2: dependency install or unrestricted network egress; policy/approval required.
- L3: staging deployment or shared-service mutation; explicit approval.
- L4: production, DNS, secret rotation, destructive migration; step-up approval.
- L5: irreversible deletion or emergency override; typed confirmation and recovery
  evidence when possible.

An approval records actor, action, resolved targets, preview/diff, risk, cost,
rollback, expiry, single-use status, and resulting event. Approval of one target
never authorizes another target or a broadened command.
