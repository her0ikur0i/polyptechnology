# CONTRACT-010 evidence

Date: 2026-08-08

## Milestone evidence

- M1: ADR 0006 defines supervision, recovery, immutable evidence, and the
  production activation boundary. The acceptance matrix maps every release
  requirement to direct evidence.
- M2: the executable supervisor claims only active eligible work, uses fenced
  leases and heartbeats, executes an allowlisted driver, verifies its digest,
  records immutable evidence, and persists a compact provider/model-aware
  checkpoint. Unit and PostgreSQL restart/emergency-stop tests pass.
- M3: CI inputs and the PostgreSQL image are immutable-pinned. The systemd unit
  uses an unprivileged identity, readiness preflight, watchdog, restart backoff,
  filesystem/kernel restrictions, and resource limits. Offline
  `systemd-analyze security` exposure is 3.9 (OK).
- M4: a custom-format PostgreSQL dump (135,407 bytes) with SHA-256
  `2792dcc37dcdaa0b8c9ae30c7f6da86cd627287576fb9947df1b8194293213be`
  restored into a clean database. Source and restore contained 48 public tables
  and restored application tests passed 3/3. The immutable drill evidence digest
  is `2812b42591c64684458792ef55c631e6cc77edfc010bd11aacf3d32ca0349160`.
- M5: a disposable arbitrary blueprint completed persisted legal transitions
  through provisioned, development, and demo. Owner command integration proves
  authentication, timing-safe CSRF validation, and idempotent project/proposal
  creation; dashboard command tests pass.
- M6: full clean-database verification, security/audit/scope gates, independent
  managed-provider review, and publication evidence are recorded below.

## Independent review and model tracking

| Role                             | Provider  | Requested/resolved model                                            | Attempt                                | Usage                                                         |      Cost | Outcome                              |
| -------------------------------- | --------- | ------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- | --------: | ------------------------------------ |
| Primary operations design worker | DeepSeek  | `deepseek-v4-pro` / `deepseek-v4-pro` (thinking)                    | `eb29a7ab-b2e9-40f4-a687-d9c91d7c1f43` | 207 input, 3,862 output, 1,323 reasoning                      | $0.003450 | succeeded                            |
| Security/DR specialist review    | Anthropic | `claude-sonnet-5` / `claude-sonnet-5` with `claude-haiku` auxiliary | `b7899620-af02-4095-80cd-ba9c04831066` | 909 input, 6,357 output, 16,275 cache read, 9,658 cache write | $0.158919 | succeeded                            |
| Independent re-review            | DeepSeek  | `deepseek-v4-pro` / `deepseek-v4-pro`                               | `875475e0-2cb0-4011-a8ca-c6712d6e3a23` | 241 input, 8 output                                           | $0.000112 | succeeded; no critical/high findings |
| Final post-integration review    | DeepSeek  | `deepseek-v4-pro` / `deepseek-v4-pro`                               | `8f222ef7-6ee6-43f0-b0f3-649f9bea1b2d` | 142 input, 8 output                                           | $0.000069 | succeeded; no critical/high findings |

Total attributable CONTRACT-010 managed-provider cost: **$0.162550**.
Codex performed orchestration, source-level triage, integration, and deterministic
verification; it did not create a separately metered API-gateway attempt in this
contract, so no fabricated Codex token count is reported.

The specialist review raised two possible high findings. Source-level triage
rejected both: operation evidence stores verified digests rather than being used
as a publication artifact or lease-suppression signal; and emergency stop is
rechecked on every heartbeat, aborting the signal-aware driver and fencing the
lease. Direct regressions cover both paths.

## Final gates

- Fresh migrations 0001-0007: pass.
- Locked install, TypeScript, backend unit/integration, dashboard tests/build:
  pass on a fresh disposable database (exact counts captured by the final gate).
- Dependency audit, contract ownership, diff check, and bounded secret scan: pass.
- Provider attempt verification and artifact digest: recorded before publication.
- Production service activation, public access, Telegram live probe, and external
  backup target remain explicit owner-authority actions; capability acceptance
  does not claim those external states are active.
