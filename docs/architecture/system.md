# System architecture

Polyp begins as a modular monolith plus independent worker processes.

```text
Cloudflare Access + Tunnel
           |
Dashboard UI -> Control API -> PostgreSQL
                         |       (source of truth)
                         +-----> Redis/BullMQ
                                      |
                              Orchestrator worker
                                      |
                    isolated per-project job containers
                                      |
                          provider/model adapters
```

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
