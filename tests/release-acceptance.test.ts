import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "synthetic arbitrary project completes blueprint through demo without external effects",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const factory = new PostgresProjectFactory(pool),
        blueprintId = randomUUID(),
        versionId = randomUUID(),
        projectId = randomUUID(),
        slug = `acceptance-${projectId.slice(0, 8)}`,
        at = (minute: number) =>
          `2026-08-08T01:${String(minute).padStart(2, "0")}:00.000Z`;
      await factory.publishBlueprint({
        blueprintId,
        versionId,
        version: 1,
        createdAt: at(0),
        document: {
          schemaVersion: 1,
          slug,
          displayName: "Synthetic Acceptance Product",
          stack: {
            runtime: "node-22",
            framework: "react",
            database: "postgresql",
          },
          requirements: ["synthetic acceptance"],
          qualityGates: ["deterministic verification"],
          capabilities: ["workspace:write"],
          resources: {
            cpuMillis: 250,
            memoryMiB: 256,
            diskMiB: 512,
            maxProcesses: 16,
            network: "none",
          },
          lifecyclePolicy: {
            productionApproval: true,
            destructiveApproval: true,
          },
        },
      });
      let project = await factory.createProject({
        id: projectId,
        slug,
        displayName: "Synthetic Acceptance Product",
        blueprintVersionId: versionId,
        createdAt: at(0),
      });
      for (const [index, state] of (
        ["blueprint", "provisioned", "development", "demo"] as const
      ).entries()) {
        project = (
          await factory.transition(project.id, {
            idempotencyKey: `acceptance-${state}`,
            expectedVersion: index,
            to: state,
            actorId: "acceptance-runner",
            correlationId: projectId,
            evidenceSha256: String(index + 1).repeat(64),
            occurredAt: at(index + 1),
          })
        ).project;
      }
      assert.equal(project.state, "demo");
      assert.equal(project.version, 4);
      assert.match(
        project.repositoryRef,
        new RegExp(projectId.replaceAll("-", "").slice(0, 12)),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM project_lifecycle_events WHERE project_id=$1",
            [project.id],
          )
        ).rows[0].n,
        4,
      );
    } finally {
      await pool.end();
    }
  },
);

test("service artifact starts readiness then executable supervisor under containment", async () => {
  const unit = await readFile("deploy/systemd/polyp-sequence.service", "utf8"),
    main = await readFile("src/orchestrator/sequence-main.ts", "utf8");
  assert.match(unit, /ExecStartPre=.*readiness-main/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(main, /ExecutableTaskSupervisor/);
  assert.match(main, /operation\.runOne/);
});
