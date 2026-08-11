import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";
import { PostgresUpdateOffsetStore } from "../src/telegram/poller.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // telegram_settings is a singleton row and update_offset only ever moves
  // forward, so a test that commits a fixed value cannot pass twice unless it
  // resets the fixture first. The reset uses a direct assignment on purpose:
  // the monotonic guarantee belongs to PostgresUpdateOffsetStore.commit(),
  // which is the thing under test, and a test that reached for it here would
  // be unable to set up the very case it needs to prove.
  async function resetSettingsRow() {
    await pool.query(
      `INSERT INTO telegram_settings (id, authorized_chat_ids, authorized_user_ids, updated_by, updated_at)
       VALUES (true, '{}', '{}', 'test', now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      "UPDATE telegram_settings SET update_offset = 0 WHERE id = true",
    );
  }

  test("the offset survives a new store instance", async () => {
    await resetSettingsRow();
    await new PostgresUpdateOffsetStore(pool).commit(4242);

    // A different instance stands in for a process restart: the whole reason
    // this is in Postgres rather than memory is that getUpdates is an
    // at-least-once queue, and a restart that forgets the offset either
    // replays everything or skips whatever arrived while it was down.
    assert.equal(await new PostgresUpdateOffsetStore(pool).read(), 4242);
  });

  test("a lower offset cannot rewind the queue", async () => {
    await resetSettingsRow();
    const store = new PostgresUpdateOffsetStore(pool);
    await store.commit(9000);
    await store.commit(10);
    // Two pollers briefly overlapping during a restart would otherwise let the
    // slower one replay everything the faster one had already handled.
    assert.equal(await store.read(), 9000);
  });

  test("a negative or fractional offset is refused by clamping, not by throwing", async () => {
    await resetSettingsRow();
    const store = new PostgresUpdateOffsetStore(pool);
    await store.commit(9000);
    await store.commit(-5);
    assert.equal(await store.read(), 9000);
    await store.commit(9001.9);
    assert.equal(await store.read(), 9001);
  });

  after(() => pool.end());
}
