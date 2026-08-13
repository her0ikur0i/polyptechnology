BEGIN;
ALTER TABLE conversation_messages
  ADD COLUMN source_task_id uuid REFERENCES tasks(id);
CREATE INDEX conversation_messages_source_task_idx
  ON conversation_messages(source_task_id)
  WHERE source_task_id IS NOT NULL;
COMMIT;
