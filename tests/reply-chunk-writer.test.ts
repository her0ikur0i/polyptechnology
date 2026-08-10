import assert from "node:assert/strict";
import test from "node:test";
import { CoalescingChunkWriter } from "../src/orchestrator/reply-chunks.js";
import type { ReplyChunkSink } from "../src/orchestrator/reply-chunks.js";

class RecordingSink implements ReplyChunkSink {
  readonly writes: Array<{ ordinal: number; fragment: string }> = [];
  failNext = false;
  async append(input: { ordinal: number; fragment: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("database unavailable");
    }
    this.writes.push({ ordinal: input.ordinal, fragment: input.fragment });
  }
}

const writerFor = (sink: ReplyChunkSink, bytes = 240, ms = 200) =>
  new CoalescingChunkWriter(sink, "task-1", "conversation-1", bytes, ms);

test("small fragments are coalesced instead of written one by one", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 20);

  // Ten fragments of five characters. One INSERT each would be the naive
  // reading of onDelta; on a 2-vCPU host that is the difference between a
  // working stream and a hammered database.
  for (let index = 0; index < 10; index++) writer.push("12345");
  await writer.flush();

  assert.equal(sink.writes.length, 3, "expected coalesced writes, not ten");
  assert.equal(
    sink.writes.map((write) => write.fragment).join(""),
    "12345".repeat(10),
    "coalescing must not lose or reorder any text",
  );
});

test("ordinals are sequential and gapless in write order", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 10);

  for (const fragment of ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"])
    writer.push(fragment);
  await writer.flush();

  assert.deepEqual(
    sink.writes.map((write) => write.ordinal),
    [1, 2, 3],
  );
});

test("flush writes the trailing partial fragment", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 1000);

  // Well under the size threshold: without an explicit flush this text would
  // be stranded in memory and the owner would never see the end of the answer.
  writer.push("the last few words");
  assert.equal(sink.writes.length, 0);

  await writer.flush();
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.writes[0]!.fragment, "the last few words");
});

test("flush is safe when nothing was ever pushed", async () => {
  const sink = new RecordingSink();
  await writerFor(sink).flush();
  assert.deepEqual(sink.writes, []);
});

test("empty fragments are ignored", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 10);
  writer.push("");
  writer.push("");
  await writer.flush();
  assert.deepEqual(sink.writes, []);
});

test("a failing write costs a fragment, never the answer", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 10);

  sink.failNext = true;
  writer.push("this one is lost");
  writer.push("this one survives");

  // push() is called from inside a live provider stream. If a storage failure
  // could propagate from there, a database hiccup would abort a real answer to
  // protect a progress indicator -- the wrong trade, since the answer's truth
  // is the completion envelope and chunks are disposable.
  await writer.flush();

  assert.equal(writer.failedWrites, 1);
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.writes[0]!.fragment, "this one survives");
});

test("flush abandons a hung write instead of wedging the worker", async () => {
  // The M4 review's second HIGH finding. A sink that *fails* was already
  // handled; a sink that *hangs* -- pool exhaustion, a lock, a partition
  // mid-query -- had no bound at all. Because flush() runs in the reply
  // driver's `finally`, inside the single-threaded sequence worker, a stuck
  // write meant execute() never returned, the lease kept renewing, the task
  // never failed or retried, and no other task of any kind was ever picked up
  // again until someone force-killed the process. SIGTERM could not unstick it
  // either, since the shutdown signal reaches the spawned CLI but not a stuck
  // database call.
  const hung: ReplyChunkSink = { append: () => new Promise<void>(() => {}) };
  const writer = new CoalescingChunkWriter(
    hung,
    "task-1",
    "conversation-1",
    5,
    200,
    150,
  );

  writer.push("this write will never settle");

  const startedAt = Date.now();
  await writer.flush();
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < 2_000,
    `flush took ${elapsed}ms; it must abandon a stuck write, not wait on it`,
  );
  // Abandoning costs a fragment of progress and is counted as such. Not
  // abandoning costs the whole worker.
  assert.equal(writer.failedWrites, 1);
});

test("a later flush is not held hostage by an abandoned one", async () => {
  let release: (() => void) | undefined;
  const sink: ReplyChunkSink = {
    append: () => new Promise<void>((resolve) => (release = resolve)),
  };
  const writer = new CoalescingChunkWriter(sink, "t", "c", 5, 200, 100);

  writer.push("stuck forever");
  await writer.flush();
  assert.equal(writer.failedWrites, 1);

  // The chain was detached, so this returns promptly rather than inheriting
  // the still-pending first write.
  const startedAt = Date.now();
  await writer.flush();
  assert.ok(Date.now() - startedAt < 500);
  release?.();
});

test("a slow trickle is flushed on time, not held until the end", async () => {
  const sink = new RecordingSink();
  const writer = writerFor(sink, 10_000, 25);

  // Far below the size threshold. Without the timer the owner would watch
  // nothing happen until the provider finished, which is the exact experience
  // streaming exists to remove.
  writer.push("drip");
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(sink.writes.length, 1, "timer flush did not fire");
  assert.equal(sink.writes[0]!.fragment, "drip");
  await writer.flush();
});
