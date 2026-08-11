BEGIN;

-- Telegram's getUpdates is an at-least-once queue: it returns everything past
-- an offset and only discards what the caller acknowledges by asking for a
-- higher one. That offset therefore has to outlive the process, or a restart
-- either replays every update it already handled or skips whatever arrived
-- while it was down.
--
-- It lives on telegram_settings rather than in a table of its own because that
-- table is already the singleton row for Telegram state (id boolean, always
-- true). A dedicated table for one integer would be more structure than the
-- fact deserves.
--
-- Deliberately NOT NULL DEFAULT 0: a fresh install starts by reading whatever
-- Telegram still has queued, which is correct -- an approval sent while the
-- service was being deployed should still arrive.
ALTER TABLE telegram_settings
  ADD COLUMN update_offset bigint NOT NULL DEFAULT 0
    CHECK (update_offset >= 0);

COMMIT;
