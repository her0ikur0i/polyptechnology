# System architecture

Polyp begins as a modular monolith plus independent worker processes.

**This file is a summary. `docs/architecture/TAD.md` is the full technical
architecture** — module map, the generation pipeline end to end, the gateway's
idempotency contract, isolation, deployment, and the known structural defects.

```text
Cloudflare Access + Tunnel
           |
Dashboard UI -> Control API -> PostgreSQL
                                (source of truth,
                                 and the durable work engine)
                                      |
                              Sequence supervisor
                                      |
                    isolated per-project job containers
                                      |
                          provider/model adapters
```

Corrected 2026-08-11: this diagram showed `Redis/BullMQ` between the API and the
worker. Neither was ever built — `src/work/**` runs on PostgreSQL.

## Module boundaries

- identity: owner identity, sessions, RBAC, capability decisions.
- projects: project registry and lifecycle.
- conversations: sessions, messages, attachments, context provenance.
- contracts: contracts, milestones, tasks, gates, evidence, Git outcome.
- orchestration: leases, schedules, attempts, recovery, emergency stop.
- providers: providers, accounts, models, price versions, limits, routing.
- agents: operational roles, permissions, prompts, evaluation history.
- artifacts: file metadata, checksums, retention, knowledge promotion.
- operations: infrastructure state, deployment, incident, backup, notification.
- events: versioned domain events consumed by audit and Factory Live View.

Modules communicate through typed services and durable events. They remain in one
repository and deployment until measured scale requires separation.

## Source-of-truth hierarchy

Owner policy > global security policy > project policy > approved contract >
milestone > task > conversation context > agent output.
