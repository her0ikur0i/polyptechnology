# Managed AI Gateway operations

## Mandatory boundary

Provider-attributed work is valid only when an `ai_gateway_attempts` row precedes
dispatch and its usage, model resolution, output checksum, verification, and budget
state reconcile. Direct HTTP or CLI inference is diagnostic-only and cannot satisfy a
contract gate. Secret values remain in the `0600` provider secret file and adapters
receive only a registered `secret://` reference.

## Routing and resolution

The versioned policy in `src/gateway/model-policy.ts` maps task class to an ordered,
failure-aware route. DeepSeek is the bulk coder, Codex is orchestrator/integrator,
and Claude is specialist reviewer. Each route names a concrete model. DeepSeek and
Claude must report the same model in their response telemetry. The Codex CLI pins a
concrete `--model`; because its JSONL surface currently omits a model field, attempts
explicitly record `resolution_source=pinned_request` rather than pretending the
provider reported it. Auxiliary Claude models are separate immutable usage rows.

## State and recovery

- `reserved`: budget held; no external work yet.
- `dispatched`: external outcome not yet durable.
- `succeeded`: provider request, model, usage, cost, and output hash finalized.
- `failed`: known failure; a rejected provider response still records and charges its
  actual per-model usage.
- `outcome_unknown`: reservation remains held. Never retry automatically.

An unknown attempt without a provider request ID may be reconciled as no-charge only
with an immutable evidence checksum. An attempt with a provider request ID requires
external provider reconciliation. Usage, verification, and reconciliation rows are
append-only and protected against update, delete, and truncate.

## Worker isolation

Workers run from an orchestrator-created workspace below the configured isolation
root. The workspace must contain no `.git`. Images require an immutable digest.
Docker runs with no shell, no network by default, read-only container root, dropped
capabilities, no-new-privileges, PID/memory/CPU limits, bounded output, and no secrets.
Only the isolated workspace is writable. Artifacts are opened with `O_NOFOLLOW`,
checked through the file descriptor, size-bounded, and SHA-256 hashed.

## Required task summary

Every accepted task reports task/attempt ID, provider, requested and resolved model,
resolution source, role, input/output/reasoning/cache tokens, normalized cost, result,
artifact checksum, and verification outcome. Failed and unknown attempts appear in
the same report so wasted usage is visible rather than silently omitted.
