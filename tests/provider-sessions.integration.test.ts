import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  ForgivingProviderSessionStore,
  PostgresProviderSessionStore,
  type ProviderSessionStore,
} from "../src/orchestrator/provider-sessions.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresProviderSessionStore(pool);

  test("a session is remembered and found again", async () => {
    const conversationId = randomUUID();
    assert.equal(await store.find(conversationId, "claude"), undefined);

    await store.remember(conversationId, "claude", "sess-abc");
    assert.equal(await store.find(conversationId, "claude"), "sess-abc");
  });

  test("one conversation can hold a session per provider", async () => {
    const conversationId = randomUUID();
    await store.remember(conversationId, "claude", "sess-claude");
    await store.remember(conversationId, "deepseek", "sess-deepseek");

    // The reason this is a side table rather than a column: the escalation
    // chain means a conversation may legitimately hold several.
    assert.equal(await store.find(conversationId, "claude"), "sess-claude");
    assert.equal(await store.find(conversationId, "deepseek"), "sess-deepseek");
  });

  test("remembering again replaces the id rather than failing on the key", async () => {
    const conversationId = randomUUID();
    await store.remember(conversationId, "claude", "first");
    await store.remember(conversationId, "claude", "second");
    assert.equal(await store.find(conversationId, "claude"), "second");
  });

  test("last_used_at moves forward even when the id is unchanged", async () => {
    const conversationId = randomUUID();
    await store.remember(conversationId, "claude", "stable");
    const before = await pool.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM conversation_provider_sessions WHERE conversation_id=$1",
      [conversationId],
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.remember(conversationId, "claude", "stable");
    const afterWrite = await pool.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM conversation_provider_sessions WHERE conversation_id=$1",
      [conversationId],
    );
    // An expiry sweep would key off this column, so it has to mean "last
    // exchange" and not "first exchange".
    assert.ok(
      afterWrite.rows[0]!.last_used_at.getTime() >
        before.rows[0]!.last_used_at.getTime(),
    );
  });

  test("forgetting a session sends the next turn back to replay", async () => {
    const conversationId = randomUUID();
    await store.remember(conversationId, "claude", "sess-x");
    await store.forget(conversationId, "claude");
    assert.equal(await store.find(conversationId, "claude"), undefined);
  });

  test("the schema refuses a provider it does not know", async () => {
    // The column is compared against the same three providers the rest of the
    // system routes to; a typo should fail at write time, not silently create
    // a session nothing will ever look up.
    await assert.rejects(() =>
      store.remember(randomUUID(), "not-a-provider", "x"),
    );
  });

  test("a broken store costs tokens, never a reply", async () => {
    const broken: ProviderSessionStore = {
      find: async () => {
        throw new Error("database unavailable");
      },
      remember: async () => {
        throw new Error("database unavailable");
      },
      forget: async () => {
        throw new Error("database unavailable");
      },
    };
    const logged: string[] = [];
    const forgiving = new ForgivingProviderSessionStore(broken, (event) =>
      logged.push(event),
    );

    // Degraded behaviour is the behaviour that existed before sessions: no
    // session found, so the turn replays the transcript and still answers.
    assert.equal(await forgiving.find("c", "claude"), undefined);
    await forgiving.remember("c", "claude", "s");
    await forgiving.forget("c", "claude");

    // Degraded, but never silent -- an empty catch is what hid the approval
    // bug in CONTRACT-017.
    assert.deepEqual(logged, [
      "conversation.session.read_failed",
      "conversation.session.write_failed",
      "conversation.session.forget_failed",
    ]);
  });

  after(() => pool.end());
}
