BEGIN;
CREATE TABLE ai_budget_accounts (
  scope_id text PRIMARY KEY,
  max_cost_usd_micros bigint NOT NULL CHECK(max_cost_usd_micros>=0),
  spent_usd_micros bigint NOT NULL DEFAULT 0 CHECK(spent_usd_micros>=0),
  reserved_usd_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_usd_micros>=0),
  CHECK(spent_usd_micros+reserved_usd_micros<=max_cost_usd_micros)
);
CREATE TABLE ai_gateway_attempts (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash char(64) NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('reserved','dispatched','succeeded','failed','outcome_unknown')),
  provider_id text NOT NULL CHECK(provider_id IN ('deepseek','codex','claude')),
  requested_model_id text NOT NULL,
  role text NOT NULL,
  mode text CHECK(mode IN ('thinking','non-thinking')),
  effort text CHECK(effort IN ('low','medium','high','xhigh')),
  attribution jsonb NOT NULL,
  policy_version text NOT NULL,
  budget_scope_id text NOT NULL REFERENCES ai_budget_accounts(scope_id),
  reserved_cost_usd_micros bigint NOT NULL CHECK(reserved_cost_usd_micros>=0),
  provider_request_id text UNIQUE,
  resolved_model_id text,
  resolution_source text CHECK(resolution_source IN ('provider_response','pinned_request')),
  output_sha256 char(64),
  failure_code text,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  finalized_at timestamptz,
  CHECK((outcome='succeeded')=(provider_request_id IS NOT NULL AND resolved_model_id IS NOT NULL AND resolution_source IS NOT NULL AND output_sha256 IS NOT NULL))
);
CREATE TABLE ai_usage_events (
  attempt_id uuid NOT NULL REFERENCES ai_gateway_attempts(id),
  provider_request_id text NOT NULL,
  provider_id text NOT NULL,
  requested_model_id text NOT NULL,
  resolved_model_id text NOT NULL,
  input_tokens bigint NOT NULL CHECK(input_tokens>=0),
  output_tokens bigint NOT NULL CHECK(output_tokens>=0),
  reasoning_tokens bigint NOT NULL CHECK(reasoning_tokens>=0),
  cache_read_tokens bigint NOT NULL CHECK(cache_read_tokens>=0),
  cache_write_tokens bigint NOT NULL CHECK(cache_write_tokens>=0),
  cost_usd_micros bigint NOT NULL CHECK(cost_usd_micros>=0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(attempt_id,resolved_model_id),
  UNIQUE(provider_request_id,resolved_model_id)
);
CREATE TRIGGER ai_usage_immutable BEFORE UPDATE OR DELETE ON ai_usage_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ai_usage_no_truncate BEFORE TRUNCATE ON ai_usage_events FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE ai_attempt_verifications (
  attempt_id uuid PRIMARY KEY REFERENCES ai_gateway_attempts(id),
  passed boolean NOT NULL,
  verifier text NOT NULL,
  evidence_sha256 char(64) NOT NULL,
  verified_at timestamptz NOT NULL
);
CREATE TRIGGER ai_verification_immutable BEFORE UPDATE OR DELETE ON ai_attempt_verifications FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ai_verification_no_truncate BEFORE TRUNCATE ON ai_attempt_verifications FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE ai_attempt_reconciliations (
  attempt_id uuid PRIMARY KEY REFERENCES ai_gateway_attempts(id),
  decision text NOT NULL CHECK(decision='failed_no_charge'),
  reason text NOT NULL,
  evidence_sha256 char(64) NOT NULL,
  reconciled_at timestamptz NOT NULL
);
CREATE TRIGGER ai_reconciliation_immutable BEFORE UPDATE OR DELETE ON ai_attempt_reconciliations FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ai_reconciliation_no_truncate BEFORE TRUNCATE ON ai_attempt_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
COMMIT;
