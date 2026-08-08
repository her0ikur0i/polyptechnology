BEGIN;

CREATE TABLE project_blueprints (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z][a-z0-9-]{0,62}$'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE project_blueprint_versions (
  id uuid PRIMARY KEY,
  blueprint_id uuid NOT NULL REFERENCES project_blueprints(id),
  version integer NOT NULL CHECK(version>0),
  status text NOT NULL CHECK(status IN ('draft','published','superseded','retired')),
  document jsonb NOT NULL,
  document_sha256 char(64) NOT NULL CHECK(document_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE(blueprint_id,version),
  UNIQUE(id,blueprint_id),
  CHECK((status='draft')=(published_at IS NULL))
);
CREATE UNIQUE INDEX one_published_blueprint_version
  ON project_blueprint_versions(blueprint_id) WHERE status='published';
CREATE FUNCTION protect_blueprint_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'published blueprint versions are immutable'; END IF;
  IF OLD.status='draft' THEN RETURN NEW; END IF;
  IF OLD.status='published' AND NEW.status='superseded'
    AND NEW.id=OLD.id AND NEW.blueprint_id=OLD.blueprint_id AND NEW.version=OLD.version
    AND NEW.document=OLD.document AND NEW.document_sha256=OLD.document_sha256
    AND NEW.created_at=OLD.created_at AND NEW.published_at=OLD.published_at
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published blueprint versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER published_blueprint_immutable BEFORE UPDATE OR DELETE ON project_blueprint_versions
  FOR EACH ROW EXECUTE FUNCTION protect_blueprint_version();

CREATE TABLE generated_projects (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z][a-z0-9-]{0,62}$'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  blueprint_id uuid NOT NULL,
  blueprint_version_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('idea','blueprint','provisioned','development','demo','approved','production','maintained','archived','exported','deleted')),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  repository_ref text NOT NULL UNIQUE CHECK(repository_ref ~ '^repo://projects/[a-z0-9-]+$'),
  workspace_ref text NOT NULL UNIQUE CHECK(workspace_ref ~ '^workspace://projects/[a-f0-9-]{36}$'),
  database_namespace text NOT NULL UNIQUE CHECK(database_namespace ~ '^project_[a-f0-9]{12}$'),
  secret_namespace text NOT NULL UNIQUE CHECK(secret_namespace ~ '^secret://polyp/projects/[a-f0-9-]{36}$'),
  budget_scope text NOT NULL UNIQUE CHECK(budget_scope ~ '^project:[a-f0-9-]{36}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY(blueprint_version_id,blueprint_id) REFERENCES project_blueprint_versions(id,blueprint_id)
);
CREATE TABLE project_lifecycle_events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES generated_projects(id),
  idempotency_key text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approval_ref text,
  resulting_version bigint NOT NULL CHECK(resulting_version>0),
  occurred_at timestamptz NOT NULL,
  UNIQUE(project_id,idempotency_key),
  UNIQUE(project_id,resulting_version),
  CHECK((to_state IN ('production','archived','exported','deleted'))=(approval_ref IS NOT NULL))
);
CREATE TRIGGER project_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON project_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER project_lifecycle_events_no_truncate BEFORE TRUNCATE ON project_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE capacity_reservations (
  request_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES generated_projects(id),
  provider_id text NOT NULL,
  fence bigint NOT NULL UNIQUE CHECK(fence>0),
  cpu_millis integer NOT NULL CHECK(cpu_millis BETWEEN 1 AND 2000),
  memory_mib integer NOT NULL CHECK(memory_mib BETWEEN 1 AND 6144),
  disk_mib integer NOT NULL CHECK(disk_mib BETWEEN 1 AND 102400),
  max_processes integer NOT NULL CHECK(max_processes BETWEEN 1 AND 128),
  network text NOT NULL CHECK(network IN ('none','egress-allowlist')),
  interactive boolean NOT NULL,
  priority integer NOT NULL CHECK(priority BETWEEN 0 AND 100),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE SEQUENCE capacity_fencing_seq;
CREATE INDEX capacity_provider_expiry_idx ON capacity_reservations(provider_id,expires_at);
CREATE INDEX capacity_project_expiry_idx ON capacity_reservations(project_id,expires_at);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK(version>0),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 100000),
  status text NOT NULL CHECK(status IN ('candidate','verified','curated','reusable','deprecated','superseded')),
  classification text NOT NULL CHECK(classification IN ('public','internal','confidential','private')),
  scope_kind text NOT NULL CHECK(scope_kind IN ('global','organization','project','contract','session','private')),
  scope_id text NOT NULL CHECK(length(scope_id)>0),
  source_type text NOT NULL CHECK(source_type IN ('decision','pattern','blueprint','component','test','solution','migration')),
  source_ref text NOT NULL,
  source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  license text NOT NULL CHECK(length(license)>0),
  confidence_permille integer NOT NULL CHECK(confidence_permille BETWEEN 0 AND 1000),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(dependencies)='array'),
  verification_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(verification_evidence)='array'),
  supersedes_id uuid REFERENCES knowledge_items(id),
  created_at timestamptz NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',title||' '||body)) STORED,
  CHECK(scope_kind<>'global' OR classification='public'),
  CHECK(status NOT IN ('verified','curated','reusable') OR jsonb_array_length(verification_evidence)>0),
  CHECK(status<>'reusable' OR (classification<>'private' AND scope_kind<>'private'))
);
CREATE INDEX knowledge_scope_status_idx ON knowledge_items(scope_kind,scope_id,status,classification);
CREATE INDEX knowledge_full_text_idx ON knowledge_items USING gin(search_vector);
CREATE TABLE knowledge_status_events (
  id uuid PRIMARY KEY,
  knowledge_id uuid NOT NULL REFERENCES knowledge_items(id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  resulting_version integer NOT NULL CHECK(resulting_version>1),
  evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  UNIQUE(knowledge_id,resulting_version)
);
CREATE TRIGGER knowledge_status_events_immutable BEFORE UPDATE OR DELETE ON knowledge_status_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE knowledge_derived_indexes (
  id uuid PRIMARY KEY,
  source_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  kind text NOT NULL CHECK(kind IN ('full_text','metadata')),
  object_ref text NOT NULL UNIQUE CHECK(object_ref ~ '^(index|object)://[a-zA-Z0-9/_-]+$'),
  state text NOT NULL CHECK(state IN ('active','purge_pending','purged'))
);
CREATE TABLE knowledge_purge_plans (
  id uuid PRIMARY KEY,
  source_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  derived_index_ids jsonb NOT NULL CHECK(jsonb_typeof(derived_index_ids)='array'),
  plan_sha256 char(64) NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
  approval_ref text,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','approved','executed')),
  created_at timestamptz NOT NULL,
  UNIQUE(source_item_id),
  CHECK((state IN ('approved','executed'))=(approval_ref IS NOT NULL))
);
CREATE TRIGGER knowledge_purge_plans_immutable BEFORE DELETE ON knowledge_purge_plans
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
