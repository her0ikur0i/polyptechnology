BEGIN;

ALTER TABLE operation_task_specs
  DROP CONSTRAINT operation_task_specs_driver_check;
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_driver_check
  CHECK(driver IN ('deterministic_sha256','ai_patch_executor','conversation_reply','blueprint_translation'));

COMMIT;
