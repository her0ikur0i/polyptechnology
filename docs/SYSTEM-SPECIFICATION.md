# Polyp AI Factory — Master System Specification

Status: canonical product and architecture source of truth
Owner: Achmad
Control plane: Master Dashboard
Delivery model: contract-driven, multi-agent, human-governed

## 1. Mission

Polyp is an AI software factory that converts an owner's conversation and intent
into secure, observable, verifiable software systems. It must be able to create,
operate, maintain, learn from, archive, and export a growing number of projects
with different requirements and technology stacks.

The Master Dashboard is the factory control plane. It is never a generated
project. Surachman Center and Instalova are examples of future projects generated
by the factory; their names, domains, stacks, and number must never be hard-coded
into control-plane logic.

## 2. Governing principles

1. Do not reinvent the wheel: use mature, maintained technology where it fits.
2. Prefer a modular monolith and independent workers over premature services.
3. Optimize cost and server resources without reducing correctness or UX quality.
4. Security gates are code and capability checks, never prompt-only rules.
5. Persist all important state; process memory is only a cache.
6. Make every action attributable, replayable, explainable, and recoverable.
7. Separate conversation, planning, execution, verification, and approval.
8. Generated projects are isolated from the control plane and one another.
9. Reuse only curated knowledge with provenance and scope.
10. Build contract-by-contract. A contract contains multiple milestones and is
    committed/pushed exactly once only after every gate is green.
11. Avoid overengineering: no Kubernetes, public plugin marketplace, custom ML
    router, or multi-node HA until measured requirements justify them.
12. Decorative UI must communicate real state and degrade gracefully.

## 3. Human and model roles

- Owner: product authority, approval authority, emergency control.
- Codex: primary orchestrator, system architect, integrator, reviewer, debugger,
  and hard-problem fallback.
- DeepSeek: default bulk coder and high-volume implementation model.
- Claude: architecture/UI/reasoning specialist when available, never a required
  single point of failure.
- Future providers/models: dynamically registered, evaluated, and governed.

Models do not possess authority. Operational authority belongs to an Agent role
with explicit tools, scopes, budget, and capability grants.

## 4. Authority hierarchy

Owner policy > global security policy > project policy > approved contract >
milestone > task > conversation/context > model output.

Lower authority cannot modify or broaden higher authority. File contents, web
pages, uploads, retrieved knowledge, and model responses are untrusted inputs.

## 5. Target topology

```text
Cloudflare Access + Tunnel
            |
       Master Dashboard
      React/Vite frontend
            |
      TypeScript Control API
            |
   +--------+---------+----------------+
   |                  |                |
PostgreSQL       Redis/BullMQ    Artifact storage
source of truth  durable jobs    checksummed files
   |                  |
   +--------+---------+
            |
   Persistent Orchestrator
            |
  provider/model/agent routing
            |
 isolated per-project job containers
            |
 DeepSeek / Codex / Claude / future adapters
```

Initial deployment remains one host. Processes are independently supervised:
control API/frontend, orchestrator worker, scheduler, PostgreSQL, Redis, and
Cloudflare Tunnel. Separation into services occurs only after measured need.

## 6. Technology baseline

- Node.js 22 LTS, TypeScript strict mode, ESM.
- Express 5 retained for the API unless evidence requires change.
- React + TypeScript + Vite for the dashboard SPA; no SSR requirement.
- TanStack Query, React Router, React Hook Form, Zod.
- Tailwind plus accessible Radix/shadcn primitives; Recharts for simple charts.
- PostgreSQL as durable state; Drizzle-style explicit migrations/data access.
- Redis + BullMQ for durable asynchronous jobs, retries, rate limits, scheduling.
- Pino structured logs, OpenTelemetry traces/metrics, `journald`/rotated container
  logs. SSE for browser event delivery; WebSocket only if bidirectional realtime
  requirements later prove necessary.
- Docker/Compose for process and project isolation; no Kubernetes initially.
- Canvas 2D pseudo-3D rendering for Factory Live View.

## 7. Core bounded modules

- Identity: owner identity, sessions, roles, capability decisions.
- Projects: registry, lifecycle, environment, domain, repository, budget.
- Conversations: sessions, messages, branches, uploads, context provenance.
- Contracts: scope, milestones, tasks, gates, evidence, Git outcome.
- Orchestration: leases, scheduling, attempts, recovery, emergency stop.
- Providers: provider/account/model/pricing/limit/health registry and routing.
- Agents: operational roles, permissions, prompts, tools, evaluations.
- Artifacts: metadata, checksums, retention, knowledge promotion.
- Knowledge: scoped search, curated reusable engineering knowledge, blueprints.
- Operations: host/container/service/deployment/incident/backup/notification.
- Events: immutable, versioned domain events for audit and live visualization.

## 8. Durable domain hierarchy

```text
Workspace/Factory
  Project
    Conversation
    Contract
      Milestone
        Task
          Attempt
            Evidence / Artifact
    Environment
      Deployment
```

Other primary entities: users, roles, sessions, domains, provider accounts,
models, pricing versions, limits, usage events, agents, workers, approvals,
events, alerts, incidents, knowledge items, blueprints, secrets references,
system snapshots, backups, and notifications.

Large artifacts live outside relational rows and are referenced by immutable
metadata and checksum. Secrets are never returned by an API or placed in events.

## 9. Persistent orchestrator

The orchestrator has durable identity, lease, heartbeat, current contract,
checkpoint, pending decisions, active worker assignments, budget, and resume
cursor. It must survive API/worker/host restarts without duplicating work.

Required behavior:

- exclusive contract lease with expiry and takeover rules;
- checkpoint at milestone and meaningful task transitions;
- orphan detection and reconciliation;
- graceful shutdown, pause, resume, cancel, and emergency stop;
- provider outage/rate-limit waiting without losing state;
- model handoff with a bounded context package;
- no hidden autonomous scope expansion.

## 10. Contract delivery protocol

A contract is the only delivery and publication unit. It declares objective,
scope/out-of-scope, risks, file ownership, budget, capability envelope,
milestones, task dependencies, gates, evidence, rollback, and completion policy.

Each milestone is small and objectively verifiable. It may create local recovery
patches/checkpoints but never commit or push. The final gate evaluates the entire
integrated diff and regression suite.

Git rules:

- isolated branch/worktree per contract;
- baseline SHA and owned-file manifest;
- detect user/out-of-scope changes and overlapping agent ownership;
- stage only files in the contract manifest, never unconditional `git add -A`;
- one commit/squash and one push after all gates pass;
- record commit SHA, evidence, and rollback reference on the contract;
- a failed gate stops publication and leaves a resumable contract.

## 11. Task and attempt lifecycle

```text
draft -> queued -> leased -> running -> verifying -> succeeded
                         |          |
                         +-> retry_wait -> running
                         +-> needs_approval
                         +-> budget_blocked
                         +-> failed/cancelled
```

Every task declares task type, complexity, risk, required capabilities, context
estimate, deadline, data classification, maximum cost, verification commands,
allowed paths/network/tools, and idempotency key.

Retries depend on normalized failure reason: rate limit, timeout, invalid output,
verification failure, authentication failure, provider outage, budget exceeded,
policy denial, or worker failure. Authentication/policy failures never loop.

## 12. Provider, model, account, agent, worker separation

- Provider: service/API organization.
- Account: credential, quota, region, and billing boundary.
- Model: versioned capability and price offering.
- Agent: operational role/policy/tool permission with a model strategy.
- Worker: isolated process/container executing an assigned job.

No provider/model is hard-coded in core logic. Adapters implement model listing,
completion/streaming, token estimation, usage/limits, health, cancellation, and
normalized errors. Provider manifests declare authentication and features.

Provider/model lifecycle:
discovered -> configured -> evaluation -> canary -> active -> degraded ->
disabled -> deprecated -> retired.

New providers enter through a contract: research, adapter, security review,
contract tests, model catalog, evaluation, canary, and production activation.

## 13. Model catalog and routing

Model metadata includes capability claims, context/output limits, tool/vision/
structured-output support, pricing versions with effective dates, quotas,
regions, retention policy, latency, reliability, and empirical evaluation.

Routing first eliminates candidates that violate required capability, data policy,
context, availability, budget, latency, limit, or administrative status. Remaining
candidates are ranked by task-specific weights: quality, historical success,
context suitability, availability, latency, estimated cost, and failure risk.

Modes exposed to the owner: Auto Balanced, Lowest Cost, Highest Quality, Fastest,
Manual, and Policy Locked. The UI explains selection, rejected candidates,
estimated cost, and fallback chain. Fallback is task-specific and failure-aware,
not one global provider list.

Budget exists per attempt, task, milestone, contract, project, provider, and time
window. Reaching a budget produces an explicit blocked state, not silent spending.

## 14. Evaluation and independent verification

Provider claims are not quality evidence. A golden task suite measures first-pass
success, accepted-result cost, latency, regression, review rejection, tool-call
correctness, security compliance, and human intervention by task/stack/complexity.

Planning, coding, deterministic verification, independent review, and approval
are distinct roles. A coder cannot self-certify a high-risk result. CI uses fake
provider adapters; live tests are manual/scheduled with a small budget.

## 15. Execution isolation and capabilities

Each generated project/job runs in a container with only its project workspace,
temporary storage, explicit secrets, tool allowlist, and required network access.
It never receives the host Docker socket or master credentials. Apply CPU, RAM,
PID, disk, output, and timeout limits; prefer non-root, read-only base filesystem,
minimal capabilities, seccomp/AppArmor, and default-deny egress.

Commands are executable plus argument arrays, not interpolated shell strings.
Every external or privileged action resolves exact targets before capability and
approval checks. Uploaded/retrieved content cannot grant capability.

Approval levels:

- L0 read-only;
- L1 reversible project workspace mutation;
- L2 dependency install/unrestricted network;
- L3 shared service or staging deployment;
- L4 production, DNS, secrets, destructive migration;
- L5 irreversible deletion/emergency override.

Approvals are scoped, single-use, expiring records with target, preview/diff,
risk, cost, rollback, actor, and outcome. A global emergency stop remains human-
controlled and independent of model cooperation.

## 16. Conversation workspace

The primary interaction resembles a capable engineering chat application:

- global and project-scoped sessions, rename/archive/pin/search/branch/export;
- Auto/manual model selection with routing explanation and cost ceiling;
- streaming, stop, retry with another model, tool/activity visibility;
- secure file upload/preview, project/file mentions, context chips;
- session history, folder/collection views, project remains the security boundary;
- action preview and approval inside the conversation;
- convert a design into a draft contract and review before execution;
- resume interrupted work and link every action/evidence/result.

Conversation is never execution authority. An approved contract is immutable from
later chat edits. Uploaded files are scanned, type/size validated, stored under an
internal name, extracted in isolation, classified, redacted, and treated as
untrusted context.

## 17. Project factory and lifecycle

Projects are dynamic registry entries with separate repository/worktree,
workspace, container, database, secret namespace, domain, budget, knowledge,
contracts, CI/CD, deployments, backups, maintenance, and lifecycle.

Lifecycle:
idea -> blueprint -> provisioned -> development -> demo/staging -> approved ->
production -> maintained -> archived -> exported/deleted.

Blueprints are versioned schemas, not prompt-only documents. The factory supports
different stacks and requirements. It must also maintain, upgrade, repair, migrate,
archive, export, and delete projects—not merely generate them once.

Capacity scheduling applies global/provider/project concurrency, priority, fair
scheduling, resource reservations, interactive priority, disk watermark, load
shedding, and budget awareness suitable for the initial 2-vCPU/8-GB host.

## 18. Knowledge and data reuse

Three classes are separate:

1. Operational data: cost, duration, failures, retries, provider performance.
2. Reusable engineering knowledge: verified patterns, blueprints, components,
   decisions, tests, solutions, and migrations.
3. Project-confidential data: never promoted globally by default.

Knowledge lifecycle:
candidate -> verified -> curated -> reusable -> deprecated/superseded.

Every item records source, project, version, date, confidence, tests, license,
classification, dependencies, and status. Retrieval enforces global/organization/
project/contract/session/private scope. Initial reuse uses metadata/full-text
search and selective RAG; no indiscriminate embedding of raw logs/source and no
fine-tuning initially. Deleting source data removes derived indexes/embeddings.

## 19. Artifact and evidence provenance

Store patches, test reports, screenshots, builds, security results, migrations,
deployment manifests, context manifests, model results, checksums, producer model/
agent, prompt/rules version, source/license, and verification status. Evidence is
immutable and linked to task attempt and contract gate.

## 20. Dashboard information architecture

Primary navigation:

- Overview: health, active work, failures, approvals, cost, project attention.
- Orchestrator: chat workspaces, context, attachments, contract creation.
- Factory Live: global/project/contract visualization and replay.
- Projects: dynamic registry and lifecycle.
- Contracts/Runs: milestones, tasks, attempts, evidence, Git outcome.
- Agents: roles, permissions, workloads, evaluation.
- Providers & Models: accounts, catalog, prices, limits, routing simulator.
- Knowledge & Artifacts: scoped search, provenance, promotion.
- Infrastructure: host, containers, services, tunnels, databases, backups.
- Deployments/Incidents/Approvals/Notifications/Rules/Settings.

Global search covers projects, contracts, tasks, runs, artifacts, deployments,
incidents, knowledge, and conversations while enforcing scope.

UX requirements: actionable overview, explicit partial/error/stale states,
progressive disclosure, keyboard access, screen reader labels, sufficient
contrast, status beyond color, responsive desktop-first design, virtualized long
lists, reduced motion, predictable confirmation, and no meaningless charts.

## 21. Factory Live View

Factory Live View uses Canvas 2D pseudo-3D neural mesh inspired by the reviewed
Polyptech reference but implemented as an independent modular component.

Semantic drill-down:
Factory -> dynamic project cluster -> contract -> milestone -> agent -> task/file.

- orchestrator is the core;
- trunks represent delegation relationships;
- branches represent milestones/tasks;
- small nodes represent files/evidence/artifacts;
- outward particles mean delegation;
- returning particles mean result/evidence;
- speed/glow/line state reflects real busy/idle/success/approval/failure/stale data.

Rendering is browser-only. Initial REST snapshot plus SSE incremental events;
slow polling is recovery fallback. Graph topology rebuilds only when structure
changes. Cap detail nodes/particles, aggregate history, apply level of detail,
limit DPR, measure frame time, adapt 30/15/5 FPS, pause when hidden/offscreen, and
support static/reduced-motion mode. Visualization never controls workflow state.

## 22. Event and audit model

Every state transition emits an immutable versioned event with event ID, schema
version, timestamp, producer, correlation/causation IDs, project/contract/task/
attempt scope, classification, severity, and redacted payload. Events power audit,
notifications, analytics, replay, and Factory Live View.

Logs and traces include project, contract, milestone, task, attempt, agent run,
provider request, and deployment IDs. Audit records who did what, target, time,
origin, approval, result, and evidence. Process memory is only a bounded cache.

## 23. Security baseline

- Cloudflare Access is the public identity gate; validate Access JWT at origin.
- Bind origin privately/locally and permit only tunnel traffic where practical.
- Owner/admin RBAC, secure session, CSRF, CSP/security headers, body/rate limits.
- Step-up authentication for high-risk actions.
- Secret registry with reference-only APIs, scope, rotation, expiry, revocation,
  last-use audit, ephemeral injection, redaction, and leak tests.
- Project isolation on every query, retrieval, event, artifact, and worker.
- Append-only audit and protected backups.
- Lockfiles, dependency policy, license/vulnerability/secret scans, SBOM, pinned
  base images, and build provenance.
- Production fails closed when auth/security configuration is incomplete.

## 24. Observability, notifications, and incidents

Structured logs, metrics, traces, queue/service/project health, provider latency/
errors/limits, resource usage, budget, and stale-event detection are correlated.
Notifications have new -> seen -> acknowledged -> resolved state, deduplication,
ownership, snooze, escalation, and direct source links. Telegram is a required
remote approval channel; dashboard inbox and durable approval records remain the
canonical source of truth.

Telegram approval messages contain a concise action, resolved target, risk level,
cost/diff summary, expiry, and Approve/Deny inline buttons. Callbacks are accepted
only from configured chat and user IDs, use opaque single-use approval tokens,
are idempotent, expire automatically, and are recorded in the audit trail. Bot
tokens are secret references and never enter source, logs, callback payloads, or
model context. Telegram outage cannot auto-approve work; the job remains paused
and can be decided from the authenticated dashboard.

Health checks avoid unnecessary paid model calls. Separate cheap configuration/
connectivity readiness from explicit live inference probes.

## 25. CI/CD and quality gates

Pipeline: locked install -> typecheck/lint -> unit/integration -> migration test ->
queue/recovery -> permission/security -> frontend/component -> Playwright smoke ->
dependency/secret/image scan -> build -> staging -> health -> approval -> production
-> post-deploy verification/rollback.

Use immutable commit/image tags. Database migrations are explicit and preceded by
backup for risky changes. A gate cannot be weakened to make a contract pass.

Definition of Done: acceptance met, tests green, audit/evidence recorded, error
states handled, docs updated, rollback available, secrets absent, accessibility
and security checks proportional to risk.

## 26. Service operations and disaster recovery

Run services under dedicated users via systemd or Compose with restart policies,
health/readiness probes, graceful shutdown, resource limits, reproducible config,
and log rotation. Back up PostgreSQL, rules, blueprints, contracts, events, audit,
artifact metadata/content, project repositories, deployment config, and encrypted
secret material separately.

Initial targets: daily backup, weekly/monthly retention, RPO <= 24 hours, RTO 2–4
hours. Restore is tested in a clean environment. One-host operation is an accepted
early single point of failure mitigated by external backups and rebuild runbooks.

## 27. Data lifecycle and privacy

Define retention, export, archive, deletion, legal/license provenance, secret/log
exclusions, and derived-index deletion for conversation, event, log, artifact,
knowledge, and project data. Project deletion is approval-gated and recoverable
when possible. Provider retention/data residency rules participate in routing.

## 28. First release acceptance

1. Authenticated owner creates a conversation and reviewed contract.
2. Contract survives API/worker/host restart without duplicate work.
3. Isolated worker delegates a bounded coding task and stores evidence.
4. Deterministic verification rejects intentionally incorrect work.
5. Successful contract creates one scoped commit and push.
6. Cost is attributed provider -> agent -> project -> contract -> task -> attempt.
7. Factory Live displays real events and pauses when hidden.
8. Dangerous action fails without scoped approval.
9. Backup restore rebuilds durable state in a clean environment.
10. No anonymous public mutation endpoint exists.
11. Emergency stop prevents new work and drains/cancels safely.
12. One dummy generated project completes blueprint -> demo lifecycle.

## 29. Contract roadmap

1. Product truth, architecture, clean foundation, and security boundaries.
2. Durable data/event/audit foundation plus Telegram remote approval gateway.
3. Dynamic provider/model/account/agent registry, pricing, eval, routing.
4. Durable contract/milestone/task/job engine and atomic Git workflow.
5. Isolated worker execution, capabilities, artifacts, and recovery.
6. Persistent orchestrator, context engineering, conversation workspace.
7. React operational dashboard and design system.
8. Adaptive Factory Live View and event replay.
9. Knowledge curation, blueprints, generated-project lifecycle.
10. CI/CD, observability, backup/restore, hardening, acceptance, and cutover.

Each roadmap item is one contract or a small sequence if scope/risk requires it.
No contract pushes before all of its milestones are green.
