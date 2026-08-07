BEGIN;
CREATE TABLE domain_events (id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id uuid NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_records (id uuid PRIMARY KEY, action text NOT NULL, aggregate_id uuid NOT NULL, actor text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE approval_requests (id uuid PRIMARY KEY, target_kind text NOT NULL, target_id text NOT NULL, summary text NOT NULL, risk text NOT NULL, rollback text NOT NULL, status text NOT NULL CHECK (status IN ('pending','approved','denied')), token_hash char(64) NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, decided_at timestamptz, decided_by text, CHECK ((status='pending' AND decided_at IS NULL AND decided_by IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)));
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable table'; END $$;
CREATE TRIGGER domain_events_immutable BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_records_immutable BEFORE UPDATE OR DELETE ON audit_records FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
COMMIT;
