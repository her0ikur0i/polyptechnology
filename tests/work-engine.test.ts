import assert from "node:assert/strict";
import test from "node:test";
import { WorkEngine, WorkStore } from "../src/work/engine.js";
import { publicationPlan } from "../src/work/git-publication.js";
import { publishContract } from "../src/work/publication-executor.js";

const engine = () => new WorkEngine(new WorkStore(1_000, 0));
const submit = (e: WorkEngine, key = "key", maxAttempts = 3) =>
  e.submit({
    contractId: "c",
    milestoneId: "m",
    idempotencyKey: key,
    maxCostUsdMicros: 100,
    maxAttempts,
  });

test("submission survives engine reconstruction and scopes idempotency", () => {
  const store = new WorkStore(1_000, 0),
    first = new WorkEngine(store),
    a = submit(first),
    second = new WorkEngine(store),
    b = submit(second);
  assert.equal(a.id, b.id);
  const other = second.submit({
    contractId: "other",
    milestoneId: "m2",
    idempotencyKey: "key",
    maxCostUsdMicros: 100,
    maxAttempts: 3,
  });
  assert.notEqual(a.id, other.id);
  assert.throws(() => second.transition(a.id, "running"), /invalid transition/);
  assert.equal(second.transition(a.id, "queued").state, "queued");
});
test("every worker state mutation is fenced across recovery", () => {
  const store = new WorkStore(1_000, 0),
    e = new WorkEngine(store),
    t = submit(e);
  e.transition(t.id, "queued");
  const first = e.lease(t.id, "w1", 100, new Date(1000));
  e.transition(t.id, "running", first.fencingToken);
  assert.deepEqual(e.reclaimExpired(new Date(1100)), [t.id]);
  const reconstructed = new WorkEngine(store),
    second = reconstructed.lease(t.id, "w2", 100, new Date(1100));
  assert.ok(second.fencingToken > first.fencingToken);
  for (const operation of [
    () => reconstructed.transition(t.id, "running", first.fencingToken),
    () => reconstructed.fail(t.id, first.fencingToken, "timeout"),
  ])
    assert.throws(operation, /stale/);
});
test("fencing seed and attempt ordinal come from durable state", () => {
  const e = new WorkEngine(new WorkStore(1_000, 500)),
    t = submit(e);
  e.transition(t.id, "queued");
  const lease = e.lease(t.id, "w", 1000);
  assert.equal(lease.fencingToken, 501);
  assert.equal(lease.attemptOrdinal, 1);
});
test("expired verifying work and heartbeat TTL recover safely", () => {
  const e = engine(),
    t = submit(e);
  e.transition(t.id, "queued");
  const lease = e.lease(t.id, "w", 100, new Date(1000));
  e.transition(t.id, "running", lease.fencingToken);
  e.transition(t.id, "verifying", lease.fencingToken);
  assert.throws(
    () => e.heartbeat(t.id, lease.fencingToken, Number.NaN, new Date(1050)),
    /TTL/,
  );
  assert.deepEqual(e.reclaimExpired(new Date(1100)), [t.id]);
  assert.equal(e.get(t.id)?.state, "queued");
});
test("emergency stop requeues active work and records late idempotent cost", () => {
  const store = new WorkStore(100, 0),
    e = new WorkEngine(store),
    t = submit(e);
  e.transition(t.id, "queued");
  const lease = e.lease(t.id, "w", 1000);
  e.transition(t.id, "running", lease.fencingToken);
  e.emergencyStop();
  assert.equal(e.get(t.id)?.state, "queued");
  const result = e.recordCost(t.id, "provider-cost-1", 101);
  assert.equal(result.spentUsdMicros, 101);
  assert.equal(result.state, "budget_blocked");
  assert.equal(e.recordCost(t.id, "provider-cost-1", 101).spentUsdMicros, 101);
});
test("failure retry policy releases leases and respects attempt caps", () => {
  for (const reason of ["authentication", "policy", "budget"] as const) {
    const e = engine(),
      t = submit(e, reason);
    e.transition(t.id, "queued");
    const l = e.lease(t.id, "w", 1000);
    e.transition(t.id, "running", l.fencingToken);
    assert.notEqual(e.fail(t.id, l.fencingToken, reason).state, "retry_wait");
  }
  const e = engine(),
    t = submit(e, "retry", 2);
  e.transition(t.id, "queued");
  const first = e.lease(t.id, "w1", 10_000);
  e.transition(t.id, "running", first.fencingToken);
  assert.equal(e.fail(t.id, first.fencingToken, "timeout").state, "retry_wait");
  e.transition(t.id, "queued");
  assert.ok(e.lease(t.id, "w2", 10_000).fencingToken > first.fencingToken);
});
test("contract budget cascades to siblings but not other contracts", () => {
  const store = new WorkStore(10, 0),
    e = new WorkEngine(store),
    first = submit(e, "first"),
    sibling = submit(e, "sibling"),
    other = e.submit({
      contractId: "other",
      milestoneId: "m2",
      idempotencyKey: "task",
      maxCostUsdMicros: 10,
      maxAttempts: 1,
    });
  for (const item of [first, sibling, other]) e.transition(item.id, "queued");
  e.recordCost(first.id, "cost-c", 10);
  assert.equal(e.get(sibling.id)?.state, "budget_blocked");
  assert.equal(e.lease(other.id, "w", 1000).taskId, other.id);
});

const publication = {
  contractId: "c",
  baselineSha: "a".repeat(40),
  ownedPaths: ["src/**", "package.json"],
  gates: [{ id: "tests", passed: true, evidenceIds: ["e"] }],
};
const context = {
  repositoryPath: "/workspace/repo",
  headSha: "a".repeat(40),
  dirtyPaths: ["src/a.ts", "package.json"],
  commitMessage: "feat: safe",
  remote: "origin",
  branch: "main",
};
test("publication is scoped and commits only owned literal paths", () => {
  const plan = publicationPlan(publication, context);
  assert.deepEqual(
    plan.map((c) => c.args[0]),
    ["add", "commit"],
  );
  assert.ok(plan.every((c) => c.cwd === "/workspace/repo"));
  assert.deepEqual(plan[1]?.args, [
    "commit",
    "--only",
    "-m",
    "feat: safe",
    "-m",
    "Contract-ID: c",
    "--",
    "src/a.ts",
    "package.json",
  ]);
});
test("publication checkpoints and resumes a prepared SHA-pinned push", async () => {
  const calls: ReadonlyArray<string>[] = [],
    records: string[] = [];
  const sha = "b".repeat(40);
  const git = {
    execute: async (command: { args: ReadonlyArray<string> }) => {
      calls.push(command.args);
    },
    head: async () => sha,
    parents: async () => ["a".repeat(40)],
    changedPaths: async () => ["src/a.ts"],
    contractId: async () => "c",
  };
  const recorder = {
    assertGates: async () => {},
    preparing: async () => {
      records.push("preparing");
    },
    prepared: async (_id: string, value: string) => {
      records.push(`prepared:${value}`);
    },
    published: async (_id: string, value: string) => {
      records.push(`published:${value}`);
    },
  };
  assert.equal(await publishContract(publication, context, git, recorder), sha);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["add", "commit", "push"],
  );
  assert.equal(calls[2]?.[2], `${sha}:refs/heads/main`);
  assert.deepEqual(records, [
    "preparing",
    `prepared:${sha}`,
    `published:${sha}`,
  ]);
  calls.length = 0;
  records.length = 0;
  assert.equal(
    await publishContract(
      { ...publication, preparedSha: sha },
      { ...context, headSha: sha },
      git,
      recorder,
    ),
    sha,
  );
  assert.equal(calls[0]?.[2], `${sha}:refs/heads/main`);
});
test("publication reconciles a crash after commit before prepared checkpoint", async () => {
  const calls: string[] = [],
    records: string[] = [],
    sha = "b".repeat(40);
  const git = {
    execute: async (command: { args: ReadonlyArray<string> }) => {
      calls.push(command.args[0]!);
    },
    head: async () => sha,
    parents: async () => ["a".repeat(40)],
    changedPaths: async () => ["src/a.ts"],
    contractId: async () => "c",
  };
  const recorder = {
    assertGates: async () => {},
    preparing: async () => {},
    prepared: async (_id: string, value: string) => {
      records.push(`prepared:${value}`);
    },
    published: async (_id: string, value: string) => {
      records.push(`published:${value}`);
    },
  };
  assert.equal(
    await publishContract(
      { ...publication, preparing: true },
      { ...context, headSha: sha },
      git,
      recorder,
    ),
    sha,
  );
  assert.deepEqual(calls, ["push"]);
  assert.deepEqual(records, [`prepared:${sha}`, `published:${sha}`]);
});
test("publication rejects gates drift traversal pathspecs and unsafe remotes", () => {
  assert.throws(
    () => publicationPlan({ ...publication, gates: [] }, context),
    /gates/,
  );
  assert.throws(
    () => publicationPlan(publication, { ...context, dirtyPaths: ["outside"] }),
    /out-of-scope/,
  );
  assert.throws(
    () => publicationPlan(publication, { ...context, headSha: "b".repeat(40) }),
    /baseline/,
  );
  assert.throws(
    () =>
      publicationPlan(
        { ...publication, publishedSha: "c".repeat(40) },
        context,
      ),
    /already/,
  );
  for (const path of ["src/../.github/x", "src/*", ".git/config"])
    assert.throws(() =>
      publicationPlan(publication, { ...context, dirtyPaths: [path] }),
    );
  for (const remote of ["ext::sh evil", "--force", "--delete"])
    assert.throws(
      () => publicationPlan(publication, { ...context, remote }),
      /unsafe Git/,
    );
});
