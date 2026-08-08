import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { PostgresSequenceStore } from "../src/orchestrator/postgres-sequence-store.js";
import { compileContext } from "../src/orchestrator/context.js";
const url = process.env.TEST_DATABASE_URL;
const integration = url === undefined ? test.skip : test;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
integration(
  "PostgreSQL conversations and supervisor survive reconstruction and fence stale writers",
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      const store = new PostgresConversationStore(pool),
        projectId = randomUUID(),
        conversationId = randomUUID();
      const conversation = {
        id: conversationId,
        projectId,
        title: "Durable",
        version: 0,
        createdAt: new Date(),
      };
      await store.createConversation(conversation, "create");
      const input = {
        id: randomUUID(),
        conversationId,
        projectId,
        role: "owner" as const,
        content: "bounded context",
        classification: "internal" as const,
        contentSha256: sha("bounded context"),
        createdAt: new Date(),
      };
      const written = await store.appendMessage(input, 0, "message");
      assert.equal(written.ordinal, 1);
      assert.equal(
        (
          await new PostgresConversationStore(pool).messages(
            projectId,
            conversationId,
          )
        )[0]!.content,
        "bounded context",
      );
      const attachmentId = randomUUID();
      await store.putAttachment(
        {
          id: attachmentId,
          conversationId,
          projectId,
          objectKey: `quarantine/${attachmentId}`,
          displayName: "input.txt",
          mediaType: "text/plain",
          sizeBytes: 4,
          sha256: sha("safe"),
          state: "quarantined",
        },
        "attachment",
      );
      await store.transitionAttachment(
        projectId,
        attachmentId,
        "quarantined",
        "validated",
        "b".repeat(64),
      );
      await store.transitionAttachment(
        projectId,
        attachmentId,
        "validated",
        "scanned",
        "c".repeat(64),
      );
      await store.transitionAttachment(
        projectId,
        attachmentId,
        "scanned",
        "classified",
        "d".repeat(64),
        "internal",
      );
      await store.transitionAttachment(
        projectId,
        attachmentId,
        "classified",
        "redacted",
        "e".repeat(64),
        undefined,
        "safe",
      );
      const currentConversation = await store.conversation(
        projectId,
        conversationId,
      );
      const manifest = compileContext(
        currentConversation!,
        await store.messages(projectId, conversationId),
        await store.attachments(projectId, conversationId),
      );
      await store.saveContextManifest(manifest);
      await new PostgresConversationStore(pool).saveContextManifest(manifest);
      assert.equal(
        (
          await new PostgresConversationStore(pool).contextManifest(
            projectId,
            manifest.manifestSha256,
          )
        )?.items.length,
        2,
      );
      await assert.rejects(
        store.appendMessage({ ...input, id: randomUUID() }, 0, "stale"),
        /stale/,
      );
      const sequence = new PostgresSequenceStore(pool),
        lease = await sequence.claim("integration-worker", 5000);
      await sequence.checkpoint(lease, {
        contractId: "CONTRACT-006",
        milestoneId: "M2",
        phase: "verified",
        evidenceIds: [randomUUID()],
      });
      await assert.rejects(
        sequence.checkpoint(
          { ...lease, fencingToken: lease.fencingToken + 1 },
          {
            contractId: "CONTRACT-006",
            milestoneId: "M3",
            phase: "bad",
            evidenceIds: [randomUUID()],
          },
        ),
        /stale/,
      );
      await sequence.release(lease);
      const reclaimed = await new PostgresSequenceStore(pool).claim(
        "restarted-worker",
        5000,
      );
      assert.ok(reclaimed.fencingToken > lease.fencingToken);
      await sequence.release(reclaimed);
    } finally {
      await pool.end();
    }
  },
);
