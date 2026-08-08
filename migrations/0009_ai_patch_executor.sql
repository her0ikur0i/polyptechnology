BEGIN;

ALTER TABLE operation_task_specs
  ALTER COLUMN expected_output_sha256 DROP NOT NULL;

ALTER TABLE operation_task_specs
  DROP CONSTRAINT operation_task_specs_driver_check;
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_driver_check
  CHECK(driver IN ('deterministic_sha256','ai_patch_executor'));

-- deterministic_sha256 keeps its original invariant (a precomputed expected
-- hash is mandatory); ai_patch_executor's correctness is decided by its own
-- self-verifying result (see src/operations/execution-supervisor.ts), so a
-- precomputed hash for AI-generated output would be meaningless and NULL is
-- the documented signal to skip hash comparison entirely.
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_hash_required_for_deterministic
  CHECK(driver <> 'deterministic_sha256' OR expected_output_sha256 IS NOT NULL);
ALTER TABLE operation_task_specs
  ADD CONSTRAINT operation_task_specs_hash_absent_for_self_verifying
  CHECK(driver <> 'ai_patch_executor' OR expected_output_sha256 IS NULL);

COMMIT;
