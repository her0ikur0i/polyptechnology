BEGIN;

-- References only, never the bot token itself -- the token stays in
-- TELEGRAM_BOT_TOKEN (env, never touches Postgres or the browser). This is
-- exactly the boundary docs/operations/telegram-approvals.md's "Future
-- Master Dashboard configuration" section describes: authorized chat/user
-- IDs and a masked secret reference, nothing the browser could leak.
CREATE TABLE telegram_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^secret://[a-zA-Z0-9/_-]+$'),
  authorized_chat_ids text[] NOT NULL DEFAULT '{}',
  authorized_user_ids text[] NOT NULL DEFAULT '{}',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL
);
INSERT INTO telegram_settings (id, updated_by, updated_at)
  VALUES (true, 'system', CURRENT_TIMESTAMP);

COMMIT;
