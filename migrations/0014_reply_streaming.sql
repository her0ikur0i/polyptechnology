BEGIN;

-- Incremental reply fragments, written by ConversationReplyDriver inside
-- polyp-sequence.service and read by the Control API's SSE route in a
-- different process. That process boundary is the entire reason these are
-- durable rather than held in memory.
--
-- They are deliberately NOT the answer. CONTRACT-016 M1 established that
-- ManagedCompletion.content is the single source of truth and accumulated
-- fragments are disposable progress; a stream that dies mid-answer therefore
-- leaves rows here that nothing ever promotes, and the conversation is
-- unharmed. Nothing downstream may reconstruct a message by concatenating
-- these.
--
-- No foreign key to tasks(id) on purpose: a chunk outliving its task row would
-- be harmless progress debris, while a cascade could delete evidence of a live
-- stream mid-read. The conversation reference is real, because a chunk that
-- outlives its conversation has nowhere to be displayed.
CREATE TABLE conversation_reply_chunks (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  ordinal integer NOT NULL CHECK(ordinal > 0),
  fragment text NOT NULL CHECK(length(fragment) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL,
  UNIQUE(task_id, ordinal)
);

-- No explicit index for the SSE query shape ("everything for this task after
-- ordinal N", in order): UNIQUE(task_id, ordinal) above already creates exactly
-- that btree, and a second identical one would only add write cost to the very
-- path CoalescingChunkWriter exists to keep cheap. An earlier draft created it
-- anyway; the CONTRACT-016 M4 review caught the duplication against the live
-- schema.

-- Supports an age-based sweep. **No such sweep exists yet** -- an earlier draft
-- of this file and of the reply driver both cited "retention sweeps by age" as
-- though it were an implemented control, and the CONTRACT-016 M4 review
-- correctly called that out: src/operations/retention.ts is a policy validator
-- with no notion of this table, and nothing schedules a delete.
--
-- What actually bounds growth today: the driver clears this task's rows at the
-- start of every attempt and again after a successful append, so a task can
-- leave behind at most one attempt's fragments, and only if it exhausts every
-- retry and ends permanently failed. The index is created now so the sweep,
-- when CONTRACT-018 adds it alongside the reader, does not need a migration.
CREATE INDEX conversation_reply_chunks_age
  ON conversation_reply_chunks(created_at);

COMMIT;
