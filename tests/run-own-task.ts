import type { ExecutableTaskSupervisor } from "../src/operations/execution-supervisor.js";

// Drives a supervisor against exactly this test's task.
//
// The earlier helper looped over runOne(), which leases the first eligible task
// in the whole database. That is not acceptable when tests use provider stubs:
// a stubbed supervisor can consume unrelated live work, and a live supervisor
// can consume a test fixture before the test reaches it. runTask() keeps test
// doubles scoped to the task they created.
export async function runOwnTask(
  supervisor: ExecutableTaskSupervisor,
  taskId: string,
): Promise<Awaited<ReturnType<ExecutableTaskSupervisor["runOne"]>>> {
  return supervisor.runTask(taskId, new AbortController().signal);
}
