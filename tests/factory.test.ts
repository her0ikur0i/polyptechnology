import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  blueprintDigest,
  isolatedProjectReferences,
  parseBlueprint,
} from "../src/factory/blueprint.js";
import { CapacityReservations, rankEligible } from "../src/factory/capacity.js";
import { ProjectLifecycle } from "../src/factory/lifecycle.js";
import type {
  CapacityLimits,
  CapacityRequest,
  GeneratedProject,
} from "../src/factory/types.js";

const document = {
  schemaVersion: 1,
  slug: "arbitrary-product",
  displayName: "Arbitrary Product",
  stack: { runtime: "node-22", framework: "react", database: "postgresql" },
  requirements: ["owner-defined"],
  qualityGates: ["typecheck", "test"],
  capabilities: ["workspace:write"],
  resources: {
    cpuMillis: 500,
    memoryMiB: 512,
    diskMiB: 2048,
    maxProcesses: 32,
    network: "none",
  },
  lifecyclePolicy: { productionApproval: true, destructiveApproval: true },
} as const;
const project = (): GeneratedProject => {
  const id = randomUUID();
  return {
    id,
    slug: "arbitrary-product",
    displayName: "Arbitrary Product",
    blueprintVersionId: randomUUID(),
    state: "idea",
    version: 0,
    ...isolatedProjectReferences("arbitrary-product", id),
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
};
const transition = (
  expectedVersion: number,
  to: GeneratedProject["state"],
  key = `to-${to}`,
) => ({
  idempotencyKey: key,
  expectedVersion,
  to,
  actorId: "owner",
  correlationId: "corr-1",
  evidenceSha256: "a".repeat(64),
  occurredAt: "2026-08-08T00:01:00.000Z",
});

test("blueprints are strict, stable, bounded, and create isolated dynamic references", () => {
  const parsed = parseBlueprint(document);
  assert.equal(
    blueprintDigest(parsed),
    blueprintDigest(structuredClone(parsed)),
  );
  assert.match(
    isolatedProjectReferences("another-project", randomUUID()).secretNamespace,
    /^secret:\/\/polyp\/projects\//,
  );
  assert.throws(
    () => parseBlueprint({ ...document, capabilities: ["x", "x"] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseBlueprint({
        ...document,
        resources: { ...document.resources, cpuMillis: 9000 },
      }),
    /unsafe/,
  );
  assert.throws(
    () => isolatedProjectReferences("../escape", randomUUID()),
    /unsafe/,
  );
});

test("project lifecycle is fenced, legal, replay-safe, and approval gated", () => {
  const lifecycle = new ProjectLifecycle();
  let current = project();
  const first = lifecycle.transition(current, transition(0, "blueprint"));
  current = first.project;
  assert.equal(
    lifecycle.transition(current, transition(1, "blueprint")).replay,
    true,
  );
  assert.throws(
    () => lifecycle.transition(current, transition(0, "provisioned", "stale")),
    /stale/,
  );
  current = lifecycle.transition(current, transition(1, "provisioned")).project;
  current = lifecycle.transition(current, transition(2, "development")).project;
  current = lifecycle.transition(current, transition(3, "demo")).project;
  current = lifecycle.transition(current, transition(4, "approved")).project;
  assert.throws(
    () => lifecycle.transition(current, transition(5, "production")),
    /approval/,
  );
  assert.equal(
    lifecycle.transition(current, {
      ...transition(5, "production"),
      approvalRef: "approval:scoped",
    }).project.state,
    "production",
  );
});

test("capacity admission enforces every resource boundary and bounded aging prevents starvation", () => {
  const limits: CapacityLimits = {
    globalConcurrency: 2,
    providerConcurrency: 2,
    projectConcurrency: 1,
    cpuMillis: 2000,
    memoryMiB: 4096,
    diskMiB: 10_000,
    maxProcesses: 128,
    minimumFreeDiskMiB: 2_000,
  };
  const request = (
    id: string,
    projectId: string,
    priority: number,
    queuedAtMs: number,
    interactive = false,
  ): CapacityRequest => ({
    id,
    projectId,
    providerId: "deepseek",
    priority,
    interactive,
    queuedAtMs,
    budgetAvailable: true,
    resources: {
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 100,
      maxProcesses: 10,
      network: "none",
    },
  });
  const old = request("old", "p-old", 1, 0),
    interactive = request("interactive", "p-new", 10, 1_500_000, true);
  assert.equal(
    rankEligible(
      [interactive, old],
      { freeDiskMiB: 3000, active: [] },
      limits,
      1_800_000,
    )[0]?.id,
    "old",
  );
  assert.deepEqual(
    rankEligible([old], { freeDiskMiB: 1000, active: [] }, limits, 1_800_000),
    [],
  );
  assert.deepEqual(
    rankEligible(
      [request("same", "p-active", 99, 0)],
      { freeDiskMiB: 3000, active: [request("active", "p-active", 1, 0)] },
      limits,
      1_800_000,
    ),
    [],
  );
  const reservations = new CapacityReservations(),
    lease = reservations.claim(old, 10, 100);
  assert.throws(() => reservations.claim(old, 20, 100), /already/);
  assert.throws(() => reservations.release(old.id, lease.fence + 1), /stale/);
  reservations.release(old.id, lease.fence);
});
