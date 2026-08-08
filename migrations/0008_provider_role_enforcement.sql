BEGIN;

CREATE TABLE orchestration_policies (
  id uuid PRIMARY KEY,
  policy_key text NOT NULL CHECK(length(btrim(policy_key)) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK(version > 0),
  state text NOT NULL CHECK(state IN ('draft','validated','approved','active','superseded')),
  policy jsonb NOT NULL CHECK(jsonb_typeof(policy) = 'object'),
  policy_sha256 char(64) NOT NULL CHECK(policy_sha256 ~ '^[0-9a-f]{64}$'),
  emergency_cost_ceiling_usd_micros bigint NOT NULL CHECK(emergency_cost_ceiling_usd_micros > 0),
  creator_id text NOT NULL CHECK(length(btrim(creator_id)) BETWEEN 1 AND 200),
  validator_id text CHECK(validator_id IS NULL OR length(btrim(validator_id)) BETWEEN 1 AND 200),
  approver_id text CHECK(approver_id IS NULL OR length(btrim(approver_id)) BETWEEN 1 AND 200),
  activator_id text CHECK(activator_id IS NULL OR length(btrim(activator_id)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  validated_at timestamptz,
  approved_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz,
  UNIQUE(policy_key,version),
  CHECK(
    (state='draft' AND validator_id IS NULL AND approver_id IS NULL AND activator_id IS NULL AND validated_at IS NULL AND approved_at IS NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (state='validated' AND validator_id IS NOT NULL AND approver_id IS NULL AND activator_id IS NULL AND validated_at IS NOT NULL AND approved_at IS NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (state='approved' AND validator_id IS NOT NULL AND approver_id IS NOT NULL AND activator_id IS NULL AND validated_at IS NOT NULL AND approved_at IS NOT NULL AND activated_at IS NULL AND superseded_at IS NULL) OR
    (state='active' AND validator_id IS NOT NULL AND approver_id IS NOT NULL AND activator_id IS NOT NULL AND validated_at IS NOT NULL AND approved_at IS NOT NULL AND activated_at IS NOT NULL AND superseded_at IS NULL) OR
    (state='superseded' AND validator_id IS NOT NULL AND approver_id IS NOT NULL AND activator_id IS NOT NULL AND validated_at IS NOT NULL AND approved_at IS NOT NULL AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
  ),
  CHECK(validated_at IS NULL OR validated_at >= created_at),
  CHECK(approved_at IS NULL OR approved_at >= validated_at),
  CHECK(activated_at IS NULL OR activated_at >= approved_at),
  CHECK(superseded_at IS NULL OR superseded_at >= activated_at)
);
CREATE UNIQUE INDEX orchestration_policies_one_active
  ON orchestration_policies(policy_key) WHERE state='active';

CREATE TABLE policy_events (
  id uuid PRIMARY KEY,
  policy_key text NOT NULL,
  policy_version integer NOT NULL,
  event_type text NOT NULL CHECK(length(btrim(event_type)) BETWEEN 1 AND 100),
  actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 200),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY(policy_key,policy_version) REFERENCES orchestration_policies(policy_key,version)
);
CREATE INDEX policy_events_policy_time ON policy_events(policy_key,policy_version,occurred_at);
CREATE TRIGGER policy_events_immutable BEFORE UPDATE OR DELETE ON policy_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER policy_events_no_truncate BEFORE TRUNCATE ON policy_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE task_role_overrides (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  owner_id text NOT NULL CHECK(length(btrim(owner_id)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  codex_technical_execution boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX task_role_overrides_task_expiry ON task_role_overrides(task_id,expires_at);
CREATE TRIGGER task_role_overrides_immutable BEFORE UPDATE OR DELETE ON task_role_overrides
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER task_role_overrides_no_truncate BEFORE TRUNCATE ON task_role_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE provider_artifacts (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES ai_gateway_attempts(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  provider_id text NOT NULL CHECK(length(btrim(provider_id)) BETWEEN 1 AND 100),
  requested_model_id text NOT NULL CHECK(length(btrim(requested_model_id)) BETWEEN 1 AND 200),
  resolved_model_id text NOT NULL CHECK(length(btrim(resolved_model_id)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK(status IN ('accepted','rejected')),
  output_sha256 char(64) NOT NULL CHECK(output_sha256 ~ '^[0-9a-f]{64}$'),
  patch_sha256 char(64) CHECK(patch_sha256 IS NULL OR patch_sha256 ~ '^[0-9a-f]{64}$'),
  changed_lines integer NOT NULL CHECK(changed_lines >= 0),
  verifier_id text CHECK(verifier_id IS NULL OR length(btrim(verifier_id)) BETWEEN 1 AND 200),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  fallback_reason text CHECK(fallback_reason IS NULL OR length(btrim(fallback_reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  CHECK(
    (status='accepted' AND patch_sha256 IS NOT NULL AND verifier_id IS NOT NULL AND reason IS NULL) OR
    (status='rejected' AND reason IS NOT NULL)
  )
);
CREATE INDEX provider_artifacts_attempt ON provider_artifacts(attempt_id);
CREATE INDEX provider_artifacts_task ON provider_artifacts(task_id);
CREATE TRIGGER provider_artifacts_immutable BEFORE UPDATE OR DELETE ON provider_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER provider_artifacts_no_truncate BEFORE TRUNCATE ON provider_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
