BEGIN;
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  created_at timestamptz NOT NULL
);
CREATE INDEX conversations_project_idx ON conversations(project_id,created_at,id);
ALTER TABLE conversations ADD CONSTRAINT conversations_id_project_unique UNIQUE(id,project_id);
CREATE TABLE conversation_idempotency (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  intent_sha256 char(64) NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(scope,idempotency_key)
);
CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  project_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK(ordinal>0),
  role text NOT NULL CHECK(role IN ('owner','assistant','system')),
  content text NOT NULL,
  classification text NOT NULL CHECK(classification IN ('public','internal','confidential','secret')),
  content_sha256 char(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE(conversation_id,ordinal),
  FOREIGN KEY(conversation_id,project_id) REFERENCES conversations(id,project_id)
);
CREATE TRIGGER conversation_messages_immutable BEFORE UPDATE OR DELETE ON conversation_messages FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER conversation_messages_no_truncate BEFORE TRUNCATE ON conversation_messages FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE conversation_attachments (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE CHECK(object_key ~ '^[a-zA-Z0-9/_-]+$'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK(length(media_type) BETWEEN 1 AND 127),
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
  sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('quarantined','validated','scanned','classified','redacted','rejected')),
  classification text CHECK(classification IN ('public','internal','confidential','secret')),
  safe_text text,
  FOREIGN KEY(conversation_id,project_id) REFERENCES conversations(id,project_id),
  CHECK((state IN ('classified','redacted'))=(classification IS NOT NULL)),
  CHECK((state='redacted')=(safe_text IS NOT NULL))
);
CREATE TABLE attachment_events (
  attachment_id uuid NOT NULL REFERENCES conversation_attachments(id),
  ordinal integer NOT NULL CHECK(ordinal>0),
  from_state text,
  to_state text NOT NULL CHECK(to_state IN ('quarantined','validated','scanned','classified','redacted','rejected')),
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(attachment_id,ordinal)
);
CREATE TRIGGER attachment_events_immutable BEFORE UPDATE OR DELETE ON attachment_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER attachment_events_no_truncate BEFORE TRUNCATE ON attachment_events FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE context_manifests (
  manifest_sha256 char(64) PRIMARY KEY CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  conversation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_version bigint NOT NULL CHECK(conversation_version>=0),
  total_bytes bigint NOT NULL CHECK(total_bytes>=0),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(conversation_id,project_id) REFERENCES conversations(id,project_id)
);
CREATE TRIGGER context_manifests_immutable BEFORE UPDATE OR DELETE ON context_manifests FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER context_manifests_no_truncate BEFORE TRUNCATE ON context_manifests FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE conversation_proposals (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('draft','owner_review','approved','rejected','handed_off')),
  contract_candidate text NOT NULL CHECK(length(contract_candidate)>0),
  candidate_sha256 char(64) NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  approval_id uuid,
  FOREIGN KEY(conversation_id,project_id) REFERENCES conversations(id,project_id),
  CHECK((state IN ('approved','handed_off'))=(approval_id IS NOT NULL))
);
CREATE TABLE sequence_supervisor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  roadmap_state text NOT NULL CHECK(roadmap_state IN ('running','owner_blocked','gate_failed','completed','stopped')),
  active_contract text,
  active_milestone text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  lease_owner text,
  fencing_token bigint,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  CHECK((lease_owner IS NULL AND fencing_token IS NULL AND heartbeat_at IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND fencing_token IS NOT NULL AND heartbeat_at IS NOT NULL AND lease_expires_at>heartbeat_at))
);
INSERT INTO sequence_supervisor(singleton,roadmap_state,active_contract,active_milestone) VALUES(true,'running','CONTRACT-006','M1');
CREATE TABLE sequence_owner_blockers (
  id uuid PRIMARY KEY,
  contract_id text NOT NULL,
  milestone_id text NOT NULL,
  reason text NOT NULL,
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sequence_summaries (
  id uuid PRIMARY KEY,
  contract_id text NOT NULL,
  milestone_id text NOT NULL,
  summary jsonb NOT NULL,
  summary_sha256 char(64) NOT NULL CHECK(summary_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER sequence_summaries_immutable BEFORE UPDATE OR DELETE ON sequence_summaries FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER sequence_summaries_no_truncate BEFORE TRUNCATE ON sequence_summaries FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
COMMIT;
