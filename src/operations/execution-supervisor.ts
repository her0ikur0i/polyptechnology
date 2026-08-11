import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import type { Lease } from "../work/types.js";
import type { RunNotifier } from "./run-notifier.js";

export interface OperationTaskSpec {
  taskId: string;
  driver:
    | "deterministic_sha256"
    | "ai_patch_executor"
    | "conversation_reply"
    | "blueprint_translation";
  input: unknown;
  // null only for a self-verifying driver (ai_patch_executor,
  // conversation_reply, blueprint_translation): its own returned
  // { verified: boolean } decides success instead of a precomputed hash
  // comparison. deterministic_sha256 always has this set (DB-enforced).
  expectedOutputSha256: string | null;
  providerId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  role: string;
}
export function isSelfVerifyingResult(
  output: unknown,
): output is { verified: boolean } {
  return (
    typeof output === "object" &&
    output !== null &&
    "verified" in output &&
    typeof (output as { verified: unknown }).verified === "boolean"
  );
}
export interface OperationDriver {
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}
export class DeterministicSha256Driver implements OperationDriver {
  async execute(input: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    return { sha256: digest(input) };
  }
}
export class ExecutableTaskSupervisor {
  constructor(
    private readonly pool: Pool,
    private readonly work: PostgresWorkRepository,
    private readonly drivers: ReadonlyMap<string, OperationDriver>,
    private readonly workerId: string,
    private readonly ttlMs = 30_000,
    // Optional: without it the supervisor behaves exactly as before. Reporting
    // is never allowed to be load-bearing for execution.
    private readonly notifier?: RunNotifier,
  ) {}
  // Moves retries that have come due back into the queue.
  //
  // Without this, `retry_wait` is terminal in practice. `engine.ts` parks a
  // failed attempt there with a `next_attempt_at`, and
  // `PostgresWorkRepository.controlTransition()` will happily promote it once
  // that time passes -- but nothing ever called it, so nothing ever did. Three
  // real tasks were found sitting in `retry_wait` on staging, due by 13 to 23
  // hours, one of them a reply the owner had asked for in Telegram and never
  // received. A transient provider failure became permanent silence.
  //
  // The SELECT only proposes candidates. `controlTransition()` re-checks both
  // the state and `next_attempt_at<=CURRENT_TIMESTAMP` in the same statement,
  // so two supervisors racing cannot both promote the same task, and a task
  // that stopped being due between the two queries is refused rather than
  // retried early. Failures are ignored for exactly that reason: losing a race
  // is the normal outcome, not an error.
  // Public because it is meaningful on its own -- an operator draining a
  // backlog after an outage wants exactly this and nothing else -- and because
  // testing it through runOne() means running a supervisor against a shared
  // database, where it leases whatever other suites have queued and fails
  // their tasks with a driver map that cannot serve them. That produced a
  // flaky suite, which is worse than a slightly wider surface.
  async promoteDueRetries(): Promise<number> {
    // Same eligibility as the lease query below, deliberately. Promoting a
    // retry whose contract or milestone is no longer active just moves it to
    // `queued`, where the next lease() flips it straight to failed: churn that
    // looks like progress. A sweep should only wake work that can actually run.
    const due = await this.pool.query<{ id: string }>(
      `SELECT t.id FROM tasks t
         JOIN operation_task_specs s ON s.task_id=t.id
         JOIN milestones m ON m.id=t.milestone_id
         JOIN factory_contracts c ON c.id=t.contract_id
        WHERE t.state='retry_wait' AND t.next_attempt_at<=CURRENT_TIMESTAMP
          AND m.status='active' AND c.status='active'
        ORDER BY t.next_attempt_at LIMIT 20`,
    );
    let promoted = 0;
    for (const row of due.rows) {
      try {
        await this.work.controlTransition(row.id, "retry_wait", "queued");
        promoted += 1;
      } catch {
        continue;
      }
    }
    return promoted;
  }

  async runOne(signal: AbortSignal) {
    await this.promoteDueRetries();
    const candidate = await this.pool.query<{ task_id: string }>(
      "SELECT s.task_id FROM operation_task_specs s JOIN tasks t ON t.id=s.task_id JOIN milestones m ON m.id=t.milestone_id JOIN factory_contracts c ON c.id=t.contract_id CROSS JOIN factory_controls f WHERE t.state='queued' AND m.status='active' AND c.status='active' AND NOT f.emergency_stopped ORDER BY t.id LIMIT 20",
    );
    for (const row of candidate.rows) {
      let lease: Lease;
      try {
        lease = await this.work.lease(row.task_id, this.workerId, this.ttlMs);
      } catch {
        continue;
      }
      const outcome = await this.executeLease(lease, signal);
      // One hook, at the single point every lease resolves through, rather than
      // scattered across the success and failure paths -- which is how a
      // notifier ends up reporting three of the four ways work can end.
      // taskFinished() never throws by contract; awaiting it here only means
      // the report is sent before the next task is picked up.
      await this.notifier?.taskFinished({
        taskId: outcome.summary.taskId,
        attemptOrdinal: outcome.summary.attemptOrdinal,
        outcome: outcome.task.state,
        // The success and failure summaries are different shapes; only the
        // failure one carries a reason.
        ...("reason" in outcome.summary
          ? { reason: outcome.summary.reason }
          : {}),
      });
      return outcome;
    }
    return undefined;
  }
  private async executeLease(lease: Lease, parentSignal: AbortSignal) {
    const spec = await this.loadSpec(lease.taskId),
      driver = this.drivers.get(spec.driver);
    if (!driver) {
      await this.work.transition(
        lease.taskId,
        lease.fencingToken,
        "leased",
        "running",
      );
      return this.fail(lease, "policy");
    }
    const controller = new AbortController(),
      forward = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", forward, { once: true });
    let current = lease,
      heartbeatFailure: unknown;
    const heartbeat = setInterval(
      () => {
        void this.work
          .heartbeat(current.taskId, current.fencingToken, this.ttlMs)
          .then((next) => {
            current = next;
          })
          .catch((error: unknown) => {
            heartbeatFailure = error;
            controller.abort(error);
          });
      },
      Math.max(250, Math.floor(this.ttlMs / 3)),
    );
    heartbeat.unref();
    try {
      await this.work.transition(
        current.taskId,
        current.fencingToken,
        "leased",
        "running",
      );
      await this.evidence(current, 1, "driver_started", {
        driver: spec.driver,
      });
      const output = await driver.execute(spec.input, controller.signal);
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      const outputSha256 = digest(output);
      await this.evidence(current, 2, "driver_output", { outputSha256 });
      await this.work.transition(
        current.taskId,
        current.fencingToken,
        "running",
        "verifying",
      );
      const passed =
        spec.expectedOutputSha256 === null
          ? isSelfVerifyingResult(output) && output.verified
          : outputSha256 === spec.expectedOutputSha256;
      if (!passed) return this.fail(current, "verification");
      await this.evidence(current, 3, "verification", {
        passed: true,
        outputSha256,
      });
      const task = await this.work.transition(
        current.taskId,
        current.fencingToken,
        "verifying",
        "succeeded",
      );
      return {
        task,
        summary: compactSummary(
          spec,
          lease.attemptOrdinal,
          "succeeded",
          outputSha256,
        ),
      };
    } catch (error) {
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      // `invalid_output` is a catch-all: every throw from every driver lands
      // here and the error itself was discarded, so the durable record said
      // only that something went wrong. Diagnosing three failed tasks then
      // meant reading five database tables to *infer* a cause that the process
      // had known exactly and thrown away. Log it; the record stays as it was.
      console.error(
        JSON.stringify({
          event: "supervisor.attempt.failed",
          taskId: current.taskId,
          attemptOrdinal: current.attemptOrdinal,
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
      return this.fail(
        current,
        error instanceof Error && error.name === "AbortError"
          ? "worker"
          : "invalid_output",
      );
    } finally {
      clearInterval(heartbeat);
      parentSignal.removeEventListener("abort", forward);
    }
  }
  private async fail(
    lease: Lease,
    reason: "policy" | "verification" | "worker" | "invalid_output",
  ) {
    const task = await this.work.fail(
      lease.taskId,
      lease.fencingToken,
      reason,
      1_000,
    );
    return {
      task,
      summary: {
        taskId: lease.taskId,
        attemptOrdinal: lease.attemptOrdinal,
        outcome: task.state,
        reason,
      },
    };
  }
  private async loadSpec(taskId: string): Promise<OperationTaskSpec> {
    const result = await this.pool.query<SpecRow>(
      "SELECT * FROM operation_task_specs WHERE task_id=$1",
      [taskId],
    );
    if (result.rowCount !== 1) throw new Error("operation task spec missing");
    const row = result.rows[0]!;
    return {
      taskId: row.task_id,
      driver: row.driver,
      input: row.input,
      expectedOutputSha256: row.expected_output_sha256,
      ...(row.provider_id
        ? {
            providerId: row.provider_id,
            requestedModelId: row.requested_model_id!,
            resolvedModelId: row.resolved_model_id!,
          }
        : {}),
      role: row.role,
    };
  }
  private async evidence(
    lease: Lease,
    ordinal: number,
    kind: "driver_started" | "driver_output" | "verification",
    payload: unknown,
  ) {
    const payloadSha256 = digest(payload);
    const result = await this.pool.query(
      "INSERT INTO operation_task_evidence(task_id,attempt_ordinal,ordinal,kind,payload_sha256,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id,attempt_ordinal,ordinal) DO NOTHING",
      [
        lease.taskId,
        lease.attemptOrdinal,
        ordinal,
        kind,
        payloadSha256,
        payload,
      ],
    );
    if (result.rowCount === 0) {
      const prior = await this.pool.query<{ payload_sha256: string }>(
        "SELECT payload_sha256 FROM operation_task_evidence WHERE task_id=$1 AND attempt_ordinal=$2 AND ordinal=$3",
        [lease.taskId, lease.attemptOrdinal, ordinal],
      );
      if (prior.rows[0]?.payload_sha256 !== payloadSha256)
        throw new Error("operation evidence idempotency mismatch");
    }
  }
}
type SpecRow = {
  task_id: string;
  driver: "deterministic_sha256" | "ai_patch_executor";
  input: unknown;
  expected_output_sha256: string | null;
  provider_id: string | null;
  requested_model_id: string | null;
  resolved_model_id: string | null;
  role: string;
};
export const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
function compactSummary(
  spec: OperationTaskSpec,
  attemptOrdinal: number,
  outcome: string,
  evidenceSha256: string,
) {
  return {
    taskId: spec.taskId,
    attemptOrdinal,
    provider: spec.providerId ?? "local",
    requestedModelId: spec.requestedModelId ?? "none",
    resolvedModelId: spec.resolvedModelId ?? "none",
    role: spec.role,
    outcome,
    evidenceSha256,
  };
}
