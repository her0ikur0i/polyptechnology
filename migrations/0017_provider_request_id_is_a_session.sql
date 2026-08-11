-- `provider_request_id` stops being a unique call identifier once sessions are
-- resumed.
--
-- The Claude CLI returns one `session_id` per *conversation*, not per call.
-- This system stores it as `provider_request_id`, which was harmless while
-- every turn started a fresh session: one call, one id. CONTRACT-017A resumes
-- sessions, so the second turn of any conversation reports the same id as the
-- first -- and two constraints written against the old assumption rejected it.
--
-- Found by running it, not by reading it. Every unit test passed; on staging
-- the first genuinely resumed turn failed with
--   duplicate key value violates unique constraint
--     "ai_usage_events_provider_request_id_resolved_model_id_key"
-- the driver dropped the session as if it had expired, and the retry
-- cold-started. The result was a conversation that silently never resumed and
-- a new session row on every single turn.
--
-- Per-call identity is `ai_gateway_attempts.id`, and usage is already keyed
-- primarily on `(attempt_id, resolved_model_id)`. That is the real uniqueness
-- and it is untouched. What goes is the pair of constraints that assumed a
-- session id could only ever appear once.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT ai_usage_events_provider_request_id_resolved_model_id_key;

ALTER TABLE ai_gateway_attempts
  DROP CONSTRAINT ai_gateway_attempts_provider_request_id_key;

-- Still indexed, because reconciling "what did this session cost in total" is
-- a real question and the dropped constraints were also serving as its index.
CREATE INDEX ai_usage_events_provider_request_id
  ON ai_usage_events (provider_request_id);
CREATE INDEX ai_gateway_attempts_provider_request_id
  ON ai_gateway_attempts (provider_request_id);
