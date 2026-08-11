-- Provider sessions held per conversation, so a turn can resume rather than
-- replay the whole transcript.
--
-- Keyed by (conversation_id, provider_id) rather than stored as a column on
-- `conversations`: a conversation can hold a live Claude session and a dead
-- DeepSeek one at the same time, and the execution chain deepseek -> codex ->
-- claude means the "one provider per conversation" assumption behind a single
-- column would not survive its first escalation.
--
-- Nothing here is load-bearing for correctness. An empty table means every
-- turn falls back to replaying the transcript, which is exactly the behaviour
-- that existed before this migration -- so a lost row costs tokens, never an
-- answer.
CREATE TABLE conversation_provider_sessions (
  conversation_id uuid NOT NULL,
  provider_id     text NOT NULL,
  session_id      text NOT NULL,
  -- Written on every use, so an operator can see which sessions are live and
  -- a later contract can expire the stale ones without guessing.
  last_used_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, provider_id),
  CONSTRAINT conversation_provider_sessions_provider_check
    CHECK (provider_id IN ('deepseek', 'codex', 'claude')),
  CONSTRAINT conversation_provider_sessions_session_check
    CHECK (length(session_id) BETWEEN 1 AND 200)
);

CREATE INDEX conversation_provider_sessions_last_used
  ON conversation_provider_sessions (last_used_at);
