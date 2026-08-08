BEGIN;

CREATE TABLE operation_task_specs (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  driver text NOT NULL CHECK(driver IN ('deterministic_sha256')),
  input jsonb NOT NULL,
  expected_output_sha256 char(64) NOT NULL CHECK(expected_output_sha256 ~ '^[a-f0-9]{64}$'),
  provider_id text,
  requested_model_id text,
  resolved_model_id text,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((provider_id IS NULL AND requested_model_id IS NULL AND resolved_model_id IS NULL) OR
        (provider_id IS NOT NULL AND requested_model_id IS NOT NULL AND resolved_model_id IS NOT NULL))
);
CREATE TRIGGER operation_task_specs_immutable BEFORE UPDATE OR DELETE ON operation_task_specs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE operation_task_evidence (
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_ordinal integer NOT NULL CHECK(attempt_ordinal>0),
  ordinal integer NOT NULL CHECK(ordinal>0),
  kind text NOT NULL CHECK(kind IN ('driver_started','driver_output','verification')),
  payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(task_id,attempt_ordinal,ordinal)
);
CREATE TRIGGER operation_task_evidence_immutable BEFORE UPDATE OR DELETE ON operation_task_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER operation_task_evidence_no_truncate BEFORE TRUNCATE ON operation_task_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE operational_incidents (
  fingerprint char(64) PRIMARY KEY CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL,
  state text NOT NULL CHECK(state IN ('new','seen','acknowledged','resolved')),
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK(occurrence_count>0),
  owner_id text,
  source_href text NOT NULL CHECK(source_href ~ '^/[a-zA-Z0-9/_?=&.-]+$' AND source_href !~ '^//'),
  details jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);
CREATE TABLE operational_health_observations (
  id uuid PRIMARY KEY,
  component text NOT NULL,
  state text NOT NULL CHECK(state IN ('ready','degraded','unready')),
  details jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>observed_at)
);
CREATE INDEX operational_health_component_idx ON operational_health_observations(component,observed_at DESC);
CREATE TRIGGER operational_health_immutable BEFORE UPDATE OR DELETE ON operational_health_observations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE backup_manifests (
  id uuid PRIMARY KEY,
  source_database text NOT NULL CHECK(source_database ~ '^[a-zA-Z][a-zA-Z0-9_]{0,62}$'),
  migration_head text NOT NULL CHECK(migration_head ~ '^000[1-9]_[a-z0-9_]+$'),
  artifact_ref text NOT NULL UNIQUE CHECK(artifact_ref ~ '^backup://[a-zA-Z0-9/_-]+$'),
  artifact_sha256 char(64) NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK(size_bytes>0),
  encryption_state text NOT NULL CHECK(encryption_state IN ('provider_encrypted','envelope_encrypted')),
  key_ref text NOT NULL CHECK(key_ref ~ '^keyref://[a-zA-Z0-9/_-]+$'),
  covered_domains jsonb NOT NULL CHECK(jsonb_typeof(covered_domains)='array'),
  created_at timestamptz NOT NULL
);
CREATE TRIGGER backup_manifests_immutable BEFORE UPDATE OR DELETE ON backup_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER backup_manifests_no_truncate BEFORE TRUNCATE ON backup_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE restore_verifications (
  id uuid PRIMARY KEY,
  backup_manifest_id uuid NOT NULL REFERENCES backup_manifests(id),
  target_database text NOT NULL,
  migration_head text NOT NULL,
  integrity_passed boolean NOT NULL,
  application_passed boolean NOT NULL,
  row_counts jsonb NOT NULL,
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  duration_ms bigint NOT NULL CHECK(duration_ms>=0),
  verified_at timestamptz NOT NULL
);
CREATE TRIGGER restore_verifications_immutable BEFORE UPDATE OR DELETE ON restore_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE retention_policies (
  domain text PRIMARY KEY,
  retain_days integer NOT NULL CHECK(retain_days BETWEEN 1 AND 3650),
  archive_before_delete boolean NOT NULL,
  approval_required boolean NOT NULL,
  derived_purge_required boolean NOT NULL,
  policy_version integer NOT NULL CHECK(policy_version>0)
);

COMMIT;
