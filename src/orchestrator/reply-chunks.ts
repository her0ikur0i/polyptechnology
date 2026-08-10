import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface ReplyChunk {
  ordinal: number;
  fragment: string;
}

// What CoalescingChunkWriter needs from storage. Narrow on purpose so the
// writer can be tested without a database.
export interface ReplyChunkSink {
  append(input: {
    taskId: string;
    conversationId: string;
    ordinal: number;
    fragment: string;
  }): Promise<void>;
}

// Turns a provider's token-by-token deltas into a sane number of database
// writes.
//
// AiGateway's onDelta is synchronous and fires per fragment, which for a
// chatty provider is hundreds of calls a second. One INSERT each would be
// wasteful anywhere and is genuinely unaffordable on this 2-vCPU host, so
// fragments are coalesced by size and by time: whichever comes first. The
// owner cannot perceive the difference between 20 and 200 updates a second,
// but the database certainly can.
//
// push() is deliberately synchronous and never throws. It is called from
// inside a live provider stream, where an unhandled rejection would abort a
// real answer to protect a progress indicator -- the wrong trade every time,
// since the answer's truth is the completion envelope and chunks are
// disposable.
export class CoalescingChunkWriter {
  private buffer = "";
  private ordinal = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(
    private readonly sink: ReplyChunkSink,
    private readonly taskId: string,
    private readonly conversationId: string,
    private readonly flushBytes = 240,
    private readonly flushMs = 200,
    private readonly flushTimeoutMs = 5_000,
  ) {}

  push(fragment: string): void {
    if (fragment.length === 0) return;
    this.buffer += fragment;
    if (this.buffer.length >= this.flushBytes) {
      this.drain();
      return;
    }
    // unref so a pending progress flush can never hold the supervisor process
    // open past the work it was doing.
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.drain(), this.flushMs);
      this.timer.unref?.();
    }
  }

  // Awaits everything push() queued, but never indefinitely.
  //
  // The bound is not defensive padding. This runs in the reply driver's
  // `finally`, inside the single-threaded sequence worker that processes one
  // task at a time. A sink write that *hangs* rather than fails -- pool
  // exhaustion, a lock, a network partition mid-query -- would otherwise wedge
  // flush() forever, so execute() never returns, the lease keeps renewing, the
  // task never fails or retries, and no other task of any kind is ever picked
  // up again until someone force-kills the process. A graceful SIGTERM cannot
  // unstick it either, because the shutdown signal reaches the spawned CLI but
  // not a stuck database call. Found by the CONTRACT-016 M4 independent review,
  // which reproduced the wedge with a never-settling sink.
  //
  // Abandoning a stuck write costs a fragment of progress. Not abandoning it
  // costs the whole worker.
  async flush(): Promise<void> {
    this.drain();
    this.stopTimer();
    const abandoned = Symbol("abandoned");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<typeof abandoned>((resolve) => {
      // Deliberately NOT unref'd, unlike the periodic drain timer. This timer
      // is the thing being waited on: unref'd, it cannot hold the event loop
      // open, so when a stuck write is the only work left Node drains the loop
      // and this promise never settles at all -- turning a bounded wait into a
      // permanent hang, which is the exact failure the bound exists to prevent.
      // Caught by this milestone's own tests immediately after the fix landed.
      timer = setTimeout(() => resolve(abandoned), this.flushTimeoutMs);
    });
    try {
      if ((await Promise.race([this.queue, bound])) === abandoned) {
        this.failures += 1;
        // Detach from the stuck chain so a later flush() is not held by it too.
        this.queue = Promise.resolve();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Number of writes that failed. Surfaced so a caller can record degraded
  // progress in evidence rather than discovering silence later.
  get failedWrites(): number {
    return this.failures;
  }

  private drain(): void {
    if (this.buffer.length === 0) {
      this.stopTimer();
      return;
    }
    const fragment = this.buffer;
    this.buffer = "";
    this.ordinal += 1;
    const ordinal = this.ordinal;
    // Serialized rather than fired in parallel: ordinals must land in order,
    // and an unbounded fan-out of inserts is exactly the flood this class
    // exists to prevent.
    this.queue = this.queue.then(async () => {
      try {
        await this.sink.append({
          taskId: this.taskId,
          conversationId: this.conversationId,
          ordinal,
          fragment,
        });
      } catch {
        // Progress is disposable. Losing a fragment costs the owner a gap in
        // the live view; failing the reply would cost them the answer.
        this.failures += 1;
      }
    });
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// Crosses the process boundary that makes streaming hard here:
// ConversationReplyDriver runs inside polyp-sequence.service and writes these,
// while the Control API's SSE route reads them from a different process.
//
// These fragments are progress, not record. CONTRACT-016 M1 established that
// ManagedCompletion.content is the only source of truth for a reply, so nothing
// in this module or downstream of it may rebuild a message by concatenating
// chunks. A stream that dies mid-answer simply leaves rows nobody promotes.
export class PostgresReplyChunkStore {
  constructor(private readonly pool: Pool) {}

  // Ordinals are supplied by the writer rather than computed here, because the
  // writer is a single sequential consumer of one provider stream and already
  // knows the order. Deriving them with a MAX() subquery would invite two
  // concurrent writers to agree on the same number, and the unique constraint
  // would then turn a harmless race into a failed reply.
  async append(input: {
    taskId: string;
    conversationId: string;
    ordinal: number;
    fragment: string;
  }): Promise<void> {
    if (input.fragment.length === 0) return;
    await this.pool.query(
      `INSERT INTO conversation_reply_chunks
         (id, task_id, conversation_id, ordinal, fragment, created_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (task_id, ordinal) DO NOTHING`,
      [
        randomUUID(),
        input.taskId,
        input.conversationId,
        input.ordinal,
        // The column caps at 65536; a provider emitting one enormous fragment
        // should degrade to a truncated progress view rather than fail the
        // whole reply, since the real answer arrives through the envelope.
        input.fragment.slice(0, 65_536),
      ],
    );
  }

  // "Everything after ordinal N, in order" — the SSE route's only query, and
  // the reason a reconnecting client resumes rather than replaying an answer
  // from the beginning.
  async since(
    taskId: string,
    afterOrdinal: number,
  ): Promise<ReadonlyArray<ReplyChunk>> {
    const result = await this.pool.query(
      `SELECT ordinal, fragment FROM conversation_reply_chunks
        WHERE task_id = $1 AND ordinal > $2
        ORDER BY ordinal ASC`,
      [taskId, afterOrdinal],
    );
    return result.rows.map((row) => ({
      ordinal: Number((row as { ordinal: number }).ordinal),
      fragment: (row as { fragment: string }).fragment,
    }));
  }

  // Called once a reply has been appended as a real message. Deliberately not
  // part of the same transaction as appendMessage(): a failure to clean up
  // progress debris must never be able to roll back a completed answer.
  async clear(taskId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM conversation_reply_chunks WHERE task_id = $1",
      [taskId],
    );
  }
}
