import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import pg from "pg";
import { PostgresReplyChunkStore } from "../src/orchestrator/reply-chunks.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  async function conversation(): Promise<{ id: string; projectId: string }> {
    const id = randomUUID(),
      projectId = randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, project_id, title, version, created_at)
       VALUES ($1, $2, 'streaming test', 0, now())`,
      [id, projectId],
    );
    return { id, projectId };
  }

  test("chunks are read back in order, resuming after an ordinal", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const taskId = randomUUID();

    for (const [index, fragment] of [
      "Two ",
      "systems ",
      "live here.",
    ].entries())
      await store.append({
        taskId,
        conversationId,
        ordinal: index + 1,
        fragment,
      });

    assert.deepEqual(
      (await store.since(taskId, 0)).map((chunk) => chunk.fragment),
      ["Two ", "systems ", "live here."],
    );
    // A reconnecting client resumes rather than replaying the answer from the
    // beginning, which is the whole reason ordinals exist.
    assert.deepEqual(
      (await store.since(taskId, 2)).map((chunk) => chunk.fragment),
      ["live here."],
    );
    assert.deepEqual(await store.since(taskId, 3), []);
  });

  test("a replayed ordinal is ignored rather than duplicating progress", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const taskId = randomUUID();

    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "first",
    });
    // A driver retried after a transient failure must not be able to double a
    // fragment into the reader's view.
    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "first again",
    });

    const chunks = await store.since(taskId, 0);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.fragment, "first");
  });

  test("chunks are scoped to their task", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const first = randomUUID(),
      second = randomUUID();

    await store.append({
      taskId: first,
      conversationId,
      ordinal: 1,
      fragment: "one",
    });
    await store.append({
      taskId: second,
      conversationId,
      ordinal: 1,
      fragment: "two",
    });

    assert.deepEqual(
      (await store.since(first, 0)).map((chunk) => chunk.fragment),
      ["one"],
    );
    assert.deepEqual(
      (await store.since(second, 0)).map((chunk) => chunk.fragment),
      ["two"],
    );
  });

  test("an oversized fragment is truncated, never rejected", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const taskId = randomUUID();

    // The real answer arrives through the completion envelope, so a provider
    // emitting one enormous fragment should cost the owner a truncated
    // progress view, not a failed reply.
    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "x".repeat(80_000),
    });

    const chunks = await store.since(taskId, 0);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.fragment.length, 65_536);
  });

  test("an empty fragment is not stored", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const taskId = randomUUID();

    await store.append({ taskId, conversationId, ordinal: 1, fragment: "" });
    assert.deepEqual(await store.since(taskId, 0), []);
  });

  test("a retried attempt must clear first, or a dead attempt's text wins", async () => {
    // The M4 review's first HIGH finding, reproduced here as a regression
    // guard. A retried task keeps its task_id, but each attempt's writer
    // restarts ordinals at 1 -- so ON CONFLICT DO NOTHING preserves the failed
    // attempt's fragments and silently drops the live one's at every colliding
    // ordinal. A reader would see a splice of stale text followed by the real
    // tail.
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const taskId = randomUUID();

    // Attempt 1 streams, then dies before ever appending a message, so its
    // rows are never cleaned up by the success path.
    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "STALE",
    });

    // Without the clear, attempt 2's real text loses to the corpse.
    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "REAL",
    });
    assert.equal(
      (await store.since(taskId, 0))[0]!.fragment,
      "STALE",
      "collision hazard is real: the conflict keeps the dead attempt's text",
    );

    // ConversationReplyDriver now clears at the START of every attempt, which
    // is what makes the retry safe.
    await store.clear(taskId);
    await store.append({
      taskId,
      conversationId,
      ordinal: 1,
      fragment: "REAL",
    });
    assert.deepEqual(
      (await store.since(taskId, 0)).map((chunk) => chunk.fragment),
      ["REAL"],
    );
  });

  test("clearing removes only the finished task's progress", async () => {
    const store = new PostgresReplyChunkStore(pool);
    const { id: conversationId } = await conversation();
    const finished = randomUUID(),
      live = randomUUID();

    await store.append({
      taskId: finished,
      conversationId,
      ordinal: 1,
      fragment: "done",
    });
    await store.append({
      taskId: live,
      conversationId,
      ordinal: 1,
      fragment: "still going",
    });

    await store.clear(finished);
    assert.deepEqual(await store.since(finished, 0), []);
    assert.equal((await store.since(live, 0)).length, 1);
  });

  after(() => pool.end());
}
