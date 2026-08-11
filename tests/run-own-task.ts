import type { ExecutableTaskSupervisor } from "../src/operations/execution-supervisor.js";

// Drives a supervisor until it executes *this* test's task.
//
// `ExecutableTaskSupervisor.runOne()` leases the first eligible task across the
// whole database and has no notion of who queued it. In the shared test
// database that has always been a race between suites, noted in a comment in
// control-api.integration.test.ts long before this helper existed; it stayed
// mostly harmless because eligible work was usually gone by the time another
// suite looked.
//
// The retry sweep changed the odds. Due `retry_wait` tasks -- including stale
// ones other suites left behind -- are now promoted back to `queued` at the top
// of every runOne(), so there is reliably more eligible work than the caller
// created, and "the first task returned is mine" stopped being true. Four
// suites failed on it in one full run, each asserting against a task id it had
// never seen before.
//
// Looping is the honest fix: the production behaviour is correct and global,
// so the test is what has to stop assuming exclusivity.
export async function runOwnTask(
  supervisor: ExecutableTaskSupervisor,
  taskId: string,
  attempts = 40,
): Promise<Awaited<ReturnType<ExecutableTaskSupervisor["runOne"]>>> {
  for (let i = 0; i < attempts; i += 1) {
    const result = await supervisor.runOne(new AbortController().signal);
    if (result?.summary.taskId === taskId) return result;
    // Nothing eligible left at all: the task is not going to appear, so fail
    // now with a clear reason rather than spinning to the attempt ceiling.
    if (result === undefined) break;
  }
  throw new Error(`supervisor never reached task ${taskId}`);
}
