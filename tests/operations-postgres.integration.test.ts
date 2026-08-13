import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresWorkRepository } from "../src/work/postgres-repository.js";
import {
  PostgresBackupCatalog,
  createBackupManifest,
} from "../src/operations/backup.js";
import {
  DeterministicSha256Driver,
  ExecutableTaskSupervisor,
  digest,
  type OperationDriver,
} from "../src/operations/execution-supervisor.js";
import { PostgresIncidentService } from "../src/operations/incidents.js";
import { databaseReadiness } from "../src/operations/readiness.js";
import { PostgresSequenceStore } from "../src/orchestrator/postgres-sequence-store.js";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { OwnerCommandService } from "../src/operations/owner-commands.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function runUntilTask(
  supervisor: ExecutableTaskSupervisor,
  taskId: string,
  maxRuns = 40,
) {
  let result = await supervisor.runOne(new AbortController().signal);
  for (let i = 0; i < maxRuns && result?.summary.taskId !== taskId; i += 1)
    result = await supervisor.runOne(new AbortController().signal);
  return result;
}

test(
  "background supervisor executes queued work and operations survive reconstruction",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const contractId = randomUUID(),
        milestoneId = randomUUID(),
        work = new PostgresWorkRepository(pool);
      await pool.query(
        "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',100000)",
        [contractId, "a".repeat(40)],
      );
      await pool.query(
        "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
        [milestoneId, contractId],
      );
      const task = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "background-once",
        maxCostUsdMicros: 1000,
        maxAttempts: 2,
      });
      await work.controlTransition(task.id, "draft", "queued");
      const input = { operation: "synthetic-build", projectId: randomUUID() },
        expectedOutputSha256 = digest({ sha256: digest(input) });
      await pool.query(
        "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'deterministic_sha256',$2,$3,'deterministic-verifier')",
        [task.id, input, expectedOutputSha256],
      );
      const supervisor = new ExecutableTaskSupervisor(
        pool,
        work,
        new Map([["deterministic_sha256", new DeterministicSha256Driver()]]),
        "integration-worker",
        5_000,
      );
      // runOne() takes the first eligible task across the whole shared test
      // database, so it can pick up work another suite left queued -- and
      // since the supervisor now sweeps due retries back into the queue, it
      // can surface stale ones too. Drive it until it reaches this test's own
      // task instead of assuming the first call does.
      let result = await runUntilTask(supervisor, task.id);

      assert.equal(result?.summary.taskId, task.id, "never reached this task");
      assert.equal(result?.task.state, "succeeded");
      assert.deepEqual(result?.summary, {
        taskId: task.id,
        attemptOrdinal: 1,
        provider: "local",
        requestedModelId: "none",
        resolvedModelId: "none",
        role: "deterministic-verifier",
        outcome: "succeeded",
        evidenceSha256: expectedOutputSha256,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM operation_task_evidence WHERE task_id=$1",
            [task.id],
          )
        ).rows[0].n,
        3,
      );
      const sequence = new PostgresSequenceStore(pool),
        sequenceLease = await sequence.claim("operations-test", 5_000),
        summaryId = randomUUID();
      await pool.query(
        "INSERT INTO sequence_summaries(id,contract_id,milestone_id,summary,summary_sha256) VALUES($1,$2,$3,$4,$5)",
        [
          summaryId,
          contractId,
          milestoneId,
          result!.summary,
          digest(result!.summary),
        ],
      );
      await sequence.operationCheckpoint(sequenceLease, {
        taskId: task.id,
        attemptOrdinal: 1,
        state: "succeeded",
        summaryId,
      });
      await sequence.release(sequenceLease);
      const checkpoint = await pool.query<{
        active_contract: string;
        checkpoint: { lastOperation: { taskId: string } };
      }>("SELECT active_contract,checkpoint FROM sequence_supervisor");
      assert.equal(checkpoint.rows[0]!.active_contract, "CONTRACT-006");
      assert.equal(
        checkpoint.rows[0]!.checkpoint.lastOperation.taskId,
        task.id,
      );
      // A supervisor rebuilt from scratch must not pick this task up a second
      // time. Asserting `undefined` here asserted that the *entire* database
      // had no eligible work left, which was only ever true because no other
      // suite happened to be mid-flight -- and stopped being true once due
      // retries started being swept back into the queue. The property under
      // test is that a completed task is not re-run, so test that.
      const reconstructed = await new ExecutableTaskSupervisor(
        pool,
        new PostgresWorkRepository(pool),
        new Map([["deterministic_sha256", new DeterministicSha256Driver()]]),
        "reconstructed",
        5_000,
      ).runOne(new AbortController().signal);
      assert.notEqual(reconstructed?.summary.taskId, task.id);
      const incorrect = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "reject-incorrect",
        maxCostUsdMicros: 1000,
        maxAttempts: 1,
      });
      await work.controlTransition(incorrect.id, "draft", "queued");
      await pool.query(
        "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'deterministic_sha256',$2,$3,'deterministic-verifier')",
        [incorrect.id, { incorrect: true }, "f".repeat(64)],
      );
      const incorrectResult = await runUntilTask(
        new ExecutableTaskSupervisor(
          pool,
          work,
          new Map([["deterministic_sha256", new DeterministicSha256Driver()]]),
          "verification-worker",
          5_000,
        ),
        incorrect.id,
      );
      assert.equal(
        incorrectResult?.summary.taskId,
        incorrect.id,
        "never reached incorrect task",
      );
      assert.equal(incorrectResult?.task.state, "failed");
      const stopped = await work.submit({
        contractId,
        milestoneId,
        idempotencyKey: "stop-in-flight",
        maxCostUsdMicros: 1000,
        maxAttempts: 2,
      });
      await work.controlTransition(stopped.id, "draft", "queued");
      const stoppedInput = { slow: true };
      await pool.query(
        "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'deterministic_sha256',$2,$3,'stop-test')",
        [stopped.id, stoppedInput, digest({ sha256: digest(stoppedInput) })],
      );
      const slowDriver: OperationDriver = {
          execute: (_input, signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve({ tooLate: true }), 2_000);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error("aborted"),
                  );
                },
                { once: true },
              );
            }),
        },
        inFlight = new ExecutableTaskSupervisor(
          pool,
          work,
          new Map([["deterministic_sha256", slowDriver]]),
          "stop-worker",
          300,
        ).runOne(new AbortController().signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await work.setEmergencyStop(true);
      await assert.rejects(inFlight, /stale lease|emergency stop/);
      assert.equal(
        (await pool.query("SELECT state FROM tasks WHERE id=$1", [stopped.id]))
          .rows[0].state,
        "queued",
      );
      await work.setEmergencyStop(false);
      await work.controlTransition(stopped.id, "queued", "cancelled");

      const incidents = new PostgresIncidentService(pool),
        first = await incidents.report(
          "worker.failed",
          task.id,
          `/tasks/${task.id}`,
          { code: "verification" },
          "2026-08-08T00:00:00.000Z",
        ),
        repeated = await incidents.report(
          "worker.failed",
          task.id,
          `/tasks/${task.id}`,
          { code: "verification" },
          "2026-08-08T00:01:00.000Z",
        );
      assert.equal(first.fingerprint, repeated.fingerprint);
      assert.equal(Number(repeated.occurrence_count), 2);
      await incidents.transition(
        first.fingerprint,
        "new",
        "acknowledged",
        "owner",
        "2026-08-08T00:02:00.000Z",
      );
      await incidents.transition(
        first.fingerprint,
        "acknowledged",
        "resolved",
        "owner",
        "2026-08-08T00:03:00.000Z",
      );
      assert.equal(
        (
          await incidents.report(
            "worker.failed",
            task.id,
            `/tasks/${task.id}`,
            {},
            "2026-08-08T00:04:00.000Z",
          )
        ).state,
        "new",
      );
      assert.deepEqual(await databaseReadiness(pool), { state: "ready" });

      const csrf = "x".repeat(32),
        conversationStore = new PostgresConversationStore(pool),
        ownerCommands = new OwnerCommandService(
          new PostgresProjectFactory(pool),
          conversationStore,
          csrf,
          new OrchestratorService(conversationStore),
        ),
        owner = {
          authenticated: true,
          actorId: "owner@example.test",
          csrfToken: csrf,
        },
        projectCommand = {
          idempotencyKey: randomUUID(),
          occurredAt: "2026-08-08T00:04:30.000Z",
          slug: `owner-${randomUUID().slice(0, 8)}`,
          displayName: "Owner Generated",
          runtime: "node-22",
          framework: "react",
          database: "postgresql",
          requirements: ["reviewed workflow"],
        },
        generated = await ownerCommands.createProject(owner, projectCommand);
      assert.equal(generated.state, "blueprint");
      assert.equal(
        (await ownerCommands.createProject(owner, projectCommand)).projectId,
        generated.projectId,
      );
      const proposalCommand = {
          idempotencyKey: randomUUID(),
          occurredAt: "2026-08-08T00:04:40.000Z",
          projectId: generated.projectId,
          title: "Owner conversation",
          objective:
            "Build the bounded generated product with verified evidence.",
        },
        proposal = await ownerCommands.createProposal(owner, proposalCommand);
      assert.equal(proposal.state, "owner_review");
      assert.equal(
        (await ownerCommands.createProposal(owner, proposalCommand)).proposalId,
        proposal.proposalId,
      );
      await assert.rejects(
        ownerCommands.createProject(
          { ...owner, csrfToken: "y".repeat(32) },
          { ...projectCommand, idempotencyKey: randomUUID() },
        ),
        /authorization/,
      );

      const artifact = new TextEncoder().encode("postgres custom dump fixture"),
        manifest = createBackupManifest(
          {
            sourceDatabase: "polyp_ci",
            migrationHead: "0007_operations",
            artifactRef: `backup://tests/${task.id}`,
            encryptionState: "provider_encrypted",
            keyRef: "keyref://tests/postgres",
            coveredDomains: ["factory", "knowledge", "operations"],
            createdAt: "2026-08-08T00:05:00.000Z",
          },
          artifact,
        );
      await new PostgresBackupCatalog(pool).record(manifest);
      await assert.rejects(
        pool.query("UPDATE backup_manifests SET size_bytes=1 WHERE id=$1", [
          manifest.id,
        ]),
        /immutable/,
      );
    } finally {
      await pool.end();
    }
  },
);
