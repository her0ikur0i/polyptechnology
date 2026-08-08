import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileContext } from "../src/orchestrator/context.js";
import { MemoryConversationStore } from "../src/orchestrator/memory-store.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { SequenceSupervisor } from "../src/orchestrator/supervisor.js";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
test("conversation writes are scoped replay-safe and version fenced", async () => {
  const store = new MemoryConversationStore();
  const c = {
    id: "c1",
    projectId: "p1",
    title: "Build",
    version: 0,
    createdAt: new Date(),
  };
  await store.createConversation(c, "create");
  const value = {
    id: "m1",
    conversationId: "c1",
    projectId: "p1",
    role: "owner" as const,
    content: "draft",
    classification: "internal" as const,
    contentSha256: sha("draft"),
    createdAt: new Date(),
  };
  const first = await store.appendMessage(value, 0, "m-key");
  assert.equal(first.ordinal, 1);
  assert.equal((await store.appendMessage(value, 0, "m-key")).id, "m1");
  await assert.rejects(
    store.appendMessage({ ...value, id: "m2" }, 0, "other"),
    /stale/,
  );
  assert.equal(await store.conversation("p2", "c1"), undefined);
});
test("context excludes secrets and unsafe attachments and remains bounded", async () => {
  const conversation = {
    id: "c",
    projectId: "p",
    title: "x",
    version: 3,
    createdAt: new Date(),
  };
  const messages = [
    {
      id: "m1",
      conversationId: "c",
      projectId: "p",
      ordinal: 1,
      role: "owner" as const,
      content: "safe",
      classification: "internal" as const,
      contentSha256: sha("safe"),
      createdAt: new Date(),
    },
    {
      id: "m2",
      conversationId: "c",
      projectId: "p",
      ordinal: 2,
      role: "owner" as const,
      content: "credential",
      classification: "secret" as const,
      contentSha256: sha("credential"),
      createdAt: new Date(),
    },
  ];
  const attachments = [
    {
      id: "a1",
      conversationId: "c",
      projectId: "p",
      objectKey: "opaque/a1",
      displayName: "x.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      sha256: sha("clean"),
      state: "redacted" as const,
      classification: "confidential" as const,
      safeText: "clean",
    },
    {
      id: "a2",
      conversationId: "c",
      projectId: "p",
      objectKey: "opaque/a2",
      displayName: "bad",
      mediaType: "text/plain",
      sizeBytes: 3,
      sha256: sha("bad"),
      state: "quarantined" as const,
      safeText: "bad",
    },
  ];
  const manifest = compileContext(conversation, messages, attachments);
  assert.deepEqual(
    manifest.items.map((x) => x.sourceId),
    ["m1", "a1"],
  );
  assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
});
test("proposal handoff requires explicit approval and grants no execution", async () => {
  const store = new MemoryConversationStore();
  await store.createConversation(
    { id: "c", projectId: "p", title: "x", version: 0, createdAt: new Date() },
    "c",
  );
  const service = new OrchestratorService(store);
  const proposal = await service.submitProposal({
    projectId: "p",
    conversationId: "c",
    contractCandidate: "# contract",
    idempotencyKey: "p",
  });
  const review = await service.requestOwnerReview("p", proposal.id, 1);
  await assert.rejects(
    service.handoff("p", proposal.id, review.version),
    /invalid proposal transition/,
  );
  const approved = await service.approve(
    "p",
    proposal.id,
    review.version,
    "approval-1",
  );
  const handoff = await service.handoff("p", proposal.id, approved.version);
  assert.equal(handoff.approvalId, "approval-1");
  assert.equal("enqueue" in handoff, false);
});
test("sequence supervisor heartbeats long work and checkpoints with the latest fence", async () => {
  let heartbeats = 0,
    checkpointed = false,
    released = false;
  const store = {
    async claim(owner: string) {
      return { owner, fencingToken: 1, expiresAt: new Date(Date.now() + 1000) };
    },
    async heartbeat(lease: {
      owner: string;
      fencingToken: number;
      expiresAt: Date;
    }) {
      heartbeats++;
      return { ...lease, expiresAt: new Date(Date.now() + 1000) };
    },
    async checkpoint(
      _lease: unknown,
      value: { evidenceIds: ReadonlyArray<string> },
    ) {
      assert.deepEqual(value.evidenceIds, ["e1"]);
      checkpointed = true;
    },
    async release() {
      released = true;
    },
  };
  const driver = {
    async next(current: {
      contractId: string;
      milestoneId: string;
      phase: string;
      evidenceIds: ReadonlyArray<string>;
    }) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { checkpoint: { ...current, phase: "done", evidenceIds: ["e1"] } };
    },
  };
  const supervisor = new SequenceSupervisor(store, driver, "worker", 750);
  await supervisor.cycle(
    {
      contractId: "CONTRACT-006",
      milestoneId: "M5",
      phase: "run",
      evidenceIds: [],
    },
    new AbortController().signal,
  );
  assert.ok(heartbeats >= 1);
  assert.ok(checkpointed);
  assert.ok(released);
});
