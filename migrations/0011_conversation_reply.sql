BEGIN;

ALTER TABLE operation_task_specs
  DROP CONSTRAINT operation_task_specs_driver_check;
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_driver_check
  CHECK(driver IN ('deterministic_sha256','ai_patch_executor','conversation_reply'));

-- conversation_reply is self-verifying like ai_patch_executor (its own
-- appended-message result decides success, not a precomputed hash) --
-- broadened from naming ai_patch_executor specifically to "anything other
-- than deterministic_sha256", so a future self-verifying driver doesn't
-- need a third migration just to touch this constraint again.
ALTER TABLE operation_task_specs
  DROP CONSTRAINT operation_task_specs_hash_absent_for_self_verifying;
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_hash_absent_for_self_verifying
  CHECK(driver = 'deterministic_sha256' OR expected_output_sha256 IS NULL);

COMMIT;
