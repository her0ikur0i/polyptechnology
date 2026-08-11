import type { Pool } from "pg";

// Which provider session, if any, this conversation already has.
//
// The whole point is that a miss is ordinary. An absent row means the next
// turn replays the transcript — exactly what every turn did before this
// existed — so nothing here is allowed to fail a reply. Callers treat a read
// error as "no session" and a write error as "not saved", never as an error
// worth surfacing to the owner.

export interface ProviderSessionStore {
  find(conversationId: string, providerId: string): Promise<string | undefined>;
  remember(
    conversationId: string,
    providerId: string,
    sessionId: string,
  ): Promise<void>;
  forget(conversationId: string, providerId: string): Promise<void>;
}

export class PostgresProviderSessionStore implements ProviderSessionStore {
  constructor(private readonly pool: Pool) {}

  async find(
    conversationId: string,
    providerId: string,
  ): Promise<string | undefined> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM conversation_provider_sessions
        WHERE conversation_id = $1 AND provider_id = $2`,
      [conversationId, providerId],
    );
    return result.rows[0]?.session_id;
  }

  // Upsert, and bump last_used_at even when the id is unchanged.
  //
  // A provider may hand back the same session id turn after turn, or a fresh
  // one; both are normal and neither is worth branching on. What matters is
  // that the row reflects the most recent successful exchange, because that is
  // what an expiry sweep would key off.
  async remember(
    conversationId: string,
    providerId: string,
    sessionId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation_provider_sessions
         (conversation_id, provider_id, session_id, last_used_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (conversation_id, provider_id) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             last_used_at = CURRENT_TIMESTAMP`,
      [conversationId, providerId, sessionId],
    );
  }

  // Called when a resume is refused. Dropping the row is what makes the next
  // turn fall back to replay instead of retrying a session the provider has
  // already forgotten.
  async forget(conversationId: string, providerId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM conversation_provider_sessions
        WHERE conversation_id = $1 AND provider_id = $2`,
      [conversationId, providerId],
    );
  }
}

// Wraps any store so that no failure inside it can reach a caller.
//
// Session lookup sits directly in the path of answering the owner. A database
// hiccup there must cost tokens, never a reply — so the degraded behaviour is
// the pre-existing behaviour, and it is enforced here rather than trusted to
// every call site remembering a try/catch.
export class ForgivingProviderSessionStore implements ProviderSessionStore {
  constructor(
    private readonly inner: ProviderSessionStore,
    private readonly onError: (event: string, detail: string) => void = (
      event,
      detail,
    ) => console.error(JSON.stringify({ event, detail })),
  ) {}

  private report(event: string, error: unknown): void {
    // Logged, not swallowed in silence: the failure that hid the approval bug
    // in CONTRACT-017 was a catch with an empty body.
    this.onError(event, error instanceof Error ? error.message : "unknown");
  }

  async find(
    conversationId: string,
    providerId: string,
  ): Promise<string | undefined> {
    try {
      return await this.inner.find(conversationId, providerId);
    } catch (error) {
      this.report("conversation.session.read_failed", error);
      return undefined;
    }
  }

  async remember(
    conversationId: string,
    providerId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.inner.remember(conversationId, providerId, sessionId);
    } catch (error) {
      this.report("conversation.session.write_failed", error);
    }
  }

  async forget(conversationId: string, providerId: string): Promise<void> {
    try {
      await this.inner.forget(conversationId, providerId);
    } catch (error) {
      this.report("conversation.session.forget_failed", error);
    }
  }
}
