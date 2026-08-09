# CONTRACT-013 M8 — Independent security review

Reviewed 2026-08-09. Scope: every route/file reachable from the Control API
and the CONTRACT-013 generation/policy pipeline. Method: direct source
reading (not automated scanning) of every `pool.query()`/`client.query()`
call site, every `spawn`/`execFile` call site, and every path constructed
from owner- or AI-supplied input, cross-referenced against the routes that
carry untrusted input into them.

## Findings (ranked by severity)

### 1. HIGH — `ACCESS_AUTH_MODE=cloudflare` trusts an unauthenticated header, and nothing prevents binding it beyond loopback

`src/control-api/auth.ts:31-35`: `identifyOwner()` in cloudflare mode reads
`Cf-Access-Authenticated-User-Email` and treats its mere _presence_ as proof
of authentication -- no JWT verification against Cloudflare's `Cf-Access-Jwt-Assertion`
header, no check that the request actually transited a Cloudflare Access
edge. `src/config.ts:91` defaults `host` to `127.0.0.1`, but nothing in
`config.ts` or `server.ts` _enforces_ that `ACCESS_AUTH_MODE=cloudflare`
requires `HOST=127.0.0.1` -- setting `HOST=0.0.0.0` with cloudflare mode
still passes `loadConfig()`'s validation (only checked:
`environment === "production" && accessAuthMode === "disabled"` is
rejected, `config.ts:57-59`).

Failure scenario: the server is deployed with `ACCESS_AUTH_MODE=cloudflare`
but `HOST=0.0.0.0` (e.g. a container port published without an intervening
reverse proxy), or the tunnel/proxy in front of it fails to strip
client-supplied headers of the same name. Anyone who can reach the port
directly sends `Cf-Access-Authenticated-User-Email: attacker@example.com`
and is treated as a fully authenticated owner for every `requireOwner`
route -- draft/activate policy, grant Codex overrides, generate projects.
Already flagged pre-review; this pass adds the concrete missing enforcement
point (`config.ts` has no cross-field check tying `accessAuthMode` to
`host`).

### 2. LOW/INFORMATIONAL — `/api/v1/policy/simulate` accepts a client-supplied `occurredAt` used as "now" for override-expiry evaluation

`src/policy/owner-policy-service.ts:196-211`: `simulate()` parses
`command.occurredAt` (client body) and passes it as the `now` argument to
`simulateProgrammingRoute()`, which reaches
`execution-permission.ts:37`'s `override.expiresAt.getTime() > now.getTime()`
check. An owner-authenticated caller (simulate has no CSRF gate, by design --
see M7 evidence) could submit a past `occurredAt` to make an already-expired
override evaluate as still valid _in the simulated response only_.

This does not affect real routing: `src/operations/policy-route-resolver.ts:84`
calls `simulateProgrammingRoute()` with real `new Date()`, never
client-supplied time, so the actual execution path this simulate endpoint
previews is unaffected. Downgraded to informational because the blast radius
is "the dry-run/preview UI can be asked a misleading hypothetical," not
"real task routing can be manipulated" -- still worth a code comment at the
call site making the query/command distinction explicit, since a future
change that starts trusting `simulate()`'s output for anything beyond
display would silently inherit this.

### 3. Clean — SQL injection

Every `pool.query()`/`client.query()` call site reviewed across
`src/control-api/*.ts`, `src/policy/postgres-policy-store.ts`,
`src/factory/postgres-repository.ts`, `src/factory/generation-task.ts`, and
`src/control-api/snapshot.ts` uses positional parameters (`$1, $2, ...`)
with no string concatenation or template-literal interpolation of
request-derived values into SQL text. No exceptions found.

### 4. Clean — path traversal

`src/factory/blueprint.ts:20-21` enforces `slug` against
`^[a-z][a-z0-9-]*$` (max 63 chars) before it ever reaches a filesystem path.
`src/factory/workspace-provisioner.ts:34-35` additionally re-validates
`projectId` against a UUID pattern before joining it into
`workspacesRoot`. `src/operations/patch-scope.ts:9-26`'s `safePath()`
rejects absolute paths, `..` segments, null bytes, glob metacharacters, and
any `.git` path before an AI-produced patch's touched paths are trusted,
and `src/operations/ai-patch-driver.ts:76-91` calls it _before_ `apply()`
ever runs, not after. `src/worker/planner.ts:4-22`'s `safeWorkerPath()`
applies the same class of check independently to worker-declared owned
paths. No path in the reviewed surface is built by concatenating owner- or
AI-supplied strings without going through one of these validators first.

### 5. Clean — command/argument injection

Every process-spawning call site (`src/factory/workspace-provisioner.ts`
via `execFile`, `src/operations/git-patch-applier.ts` and
`src/worker/spawn-runner.ts` via `spawn`) passes arguments as array
elements, never through a shell (`spawn-runner.ts:16`: `shell: false`
explicit), and patch content is piped via stdin rather than interpolated
into an argument. `src/worker/planner.ts:57` additionally allowlists worker
environment variable _names_ to exactly `CI|LANG|LC_ALL|NODE_ENV|TZ`,
closing off environment-based injection into the sandboxed process.

### 6. Clean (with one design note) — Docker sandbox hardening

`src/worker/planner.ts:59-86` applies `--read-only`, `--cap-drop=ALL`,
`--security-opt no-new-privileges`, `--pids-limit 128`, `--network=none`
(unless the job explicitly declares the `network` capability),
`--tmpfs /tmp:rw,noexec,nosuid`, and requires the image reference match
`^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$` (digest-pinned, never a
mutable tag) on every call -- there is exactly one code path that builds a
`WorkerCommand` (`planWorker()`), so there is no second, less-hardened path
to bypass. Design note, not a finding: the workspace bind mount itself
(`--mount type=bind,src=...,dst=/workspace`) is not marked read-only, so the
process can write inside `/workspace` -- this is intentional (verification
commands like `npm test` need to write build artifacts) and safe only
because the bind-mounted directory is always a disposable copy
(`GitIgnoringWorkspaceCopier`), never the git-apply workspace itself or the
original repository.

### 7. Clean — blueprint content reaching shell/SQL/filesystem paths

`displayName` and `requirements` (owner-submitted, bounded to 200/300 chars
by `blueprint.ts:6-14`) are only ever written as plain-text content inside
`README.md` (`workspace-provisioner.ts:80-83`) or stored as a jsonb column
value -- never interpolated into a shell command, SQL string, or filesystem
path. `slug` is the only blueprint field that reaches a path or process
argument, and it is regex-constrained before use (finding 4).

### 8. Clean — authorization/TOCTOU

Every state-changing policy transition (`validate`, `approve`, `activate`,
`rollback`) in `postgres-policy-store.ts` uses a version-fenced
`UPDATE ... WHERE id = $1 AND version = $2 AND state = '<expected>'`
inside a transaction, checks `rowCount === 1`, and throws on mismatch
(e.g. `postgres-policy-store.ts:306-307`, `:352`, `:401-402`) -- no
check-then-act gap; the check and the act are the same atomic statement.
`activate()` and `rollback()` additionally take `pg_advisory_xact_lock`
on the policy key before touching rows, serializing concurrent
activations for the same key. `insertOverride()`'s target `task_id` is
FK-constrained to an already-existing `tasks` row, so an override can
never be pre-authorized against a task that doesn't exist yet.

## Not reviewed (out of this pass's scope, flag for M9/M10)

Rate limiting / DoS resistance on any Control API route (no rate limiter
observed anywhere in `app.ts`) and dependency vulnerability scanning
(`npm audit`) were not part of this review's brief and should be covered
separately before the private staging milestone if not already gated
elsewhere.
