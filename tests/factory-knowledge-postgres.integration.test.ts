import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { PostgresKnowledgeRepository } from "../src/knowledge/postgres-repository.js";
import type { KnowledgeItem } from "../src/knowledge/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL reconstructs dynamic project lifecycle and scope-safe knowledge",
  { skip: databaseUrl === undefined },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const factory = new PostgresProjectFactory(pool),
        blueprintId = randomUUID(),
        blueprintVersionId = randomUUID(),
        projectId = randomUUID(),
        now = "2026-08-08T00:00:00.000Z";
      await factory.publishBlueprint({
        blueprintId,
        versionId: blueprintVersionId,
        version: 1,
        createdAt: now,
        document: {
          schemaVersion: 1,
          slug: `product-${projectId.slice(0, 8)}`,
          displayName: "Generated Product",
          stack: {
            runtime: "node-22",
            framework: "react",
            database: "postgresql",
          },
          requirements: ["dynamic"],
          qualityGates: ["test"],
          capabilities: ["workspace:write"],
          resources: {
            cpuMillis: 500,
            memoryMiB: 512,
            diskMiB: 1000,
            maxProcesses: 20,
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
        slug: `product-${projectId.slice(0, 8)}`,
        displayName: "Generated Product",
        blueprintVersionId,
        createdAt: now,
      });
      const request = {
        idempotencyKey: "blueprint-once",
        expectedVersion: 0,
        to: "blueprint" as const,
        actorId: "owner",
        correlationId: randomUUID(),
        evidenceSha256: "a".repeat(64),
        occurredAt: "2026-08-08T00:01:00.000Z",
      };
      const first = await factory.transition(project.id, request);
      assert.equal(first.project.state, "blueprint");
      assert.equal(
        (await factory.transition(project.id, request)).replay,
        true,
      );
      project = (await new PostgresProjectFactory(pool).getProject(
        project.id,
      ))!;
      assert.equal(project.version, 1);
      await assert.rejects(
        factory.transition(project.id, {
          ...request,
          idempotencyKey: "illegal",
          expectedVersion: 1,
          to: "production",
        }),
        /illegal/,
      );
      const capacityRequest = {
          id: randomUUID(),
          projectId: project.id,
          providerId: "deepseek",
          priority: 50,
          interactive: false,
          queuedAtMs: Date.parse(now),
          budgetAvailable: true,
          resources: {
            cpuMillis: 500,
            memoryMiB: 512,
            diskMiB: 1000,
            maxProcesses: 16,
            network: "none" as const,
          },
        },
        capacityLimits = {
          globalConcurrency: 1,
          providerConcurrency: 1,
          projectConcurrency: 1,
          cpuMillis: 1000,
          memoryMiB: 2048,
          diskMiB: 5000,
          maxProcesses: 128,
          minimumFreeDiskMiB: 2000,
        },
        capacityLease = await factory.reserveCapacity(
          capacityRequest,
          capacityLimits,
          3000,
          Date.parse(now),
          30_000,
        );
      assert.equal(
        (
          await new PostgresProjectFactory(pool).reserveCapacity(
            capacityRequest,
            capacityLimits,
            3000,
            Date.parse(now),
            30_000,
          )
        ).fence,
        capacityLease.fence,
      );
      await assert.rejects(
        new PostgresProjectFactory(pool).reserveCapacity(
          { ...capacityRequest, id: randomUUID() },
          capacityLimits,
          3000,
          Date.parse(now),
          30_000,
        ),
        /capacity unavailable/,
      );
      await assert.rejects(
        factory.releaseCapacity(capacityRequest.id, capacityLease.fence + 1),
        /stale/,
      );
      await new PostgresProjectFactory(pool).releaseCapacity(
        capacityRequest.id,
        capacityLease.fence,
      );

      const knowledge = new PostgresKnowledgeRepository(pool),
        item = knowledgeCandidate(project.id);
      await knowledge.add(item);
      let promoted = await knowledge.transition(
        item.id,
        1,
        "verified",
        "b".repeat(64),
        now,
      );
      promoted = await knowledge.transition(
        item.id,
        promoted.version,
        "curated",
        "b".repeat(64),
        now,
      );
      await knowledge.transition(
        item.id,
        promoted.version,
        "reusable",
        "b".repeat(64),
        now,
      );
      const reconstructed = new PostgresKnowledgeRepository(pool);
      assert.equal(
        (
          await reconstructed.retrieve("idempotent recovery", {
            organizationId: "org",
            projectIds: [project.id],
            contractIds: [],
            sessionIds: [],
            allowGlobal: false,
          })
        ).length,
        1,
      );
      assert.equal(
        (
          await reconstructed.retrieve("idempotent recovery", {
            organizationId: "org",
            projectIds: [randomUUID()],
            contractIds: [],
            sessionIds: [],
            allowGlobal: false,
          })
        ).length,
        0,
      );
      await pool.query(
        "INSERT INTO knowledge_derived_indexes(id,source_item_id,kind,object_ref,state) VALUES($1,$2,'metadata',$3,'active')",
        [randomUUID(), item.id, `index://projects/${project.id}`],
      );
      const purge = await reconstructed.preparePurge(item.id, now);
      assert.equal(purge.derivedIndexIds.length, 1);
      assert.equal(
        (
          await reconstructed.retrieve("idempotent recovery", {
            organizationId: "org",
            projectIds: [project.id],
            contractIds: [],
            sessionIds: [],
            allowGlobal: false,
          })
        ).length,
        0,
      );
      assert.equal(
        (await reconstructed.preparePurge(item.id, now)).id,
        purge.id,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM knowledge_derived_indexes WHERE source_item_id=$1",
            [item.id],
          )
        ).rows[0].state,
        "purge_pending",
      );
    } finally {
      await pool.end();
    }
  },
);

function knowledgeCandidate(projectId: string): KnowledgeItem {
  return {
    id: randomUUID(),
    version: 1,
    title: "Idempotent recovery",
    body: "Verified idempotent recovery pattern",
    status: "candidate",
    classification: "internal",
    scope: { kind: "project", scopeId: projectId },
    sourceType: "pattern",
    sourceRef: "artifact://test/recovery",
    sourceSha256: "c".repeat(64),
    license: "Apache-2.0",
    confidencePermille: 950,
    dependencies: [],
    verificationEvidence: ["d".repeat(64)],
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}
