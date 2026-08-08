import type { Pool } from "pg";
export async function databaseReadiness(pool: Pool, timeoutMs = 2_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error("invalid readiness timeout");
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      pool.query<{ ready: boolean }>(
        "SELECT NOT emergency_stopped AS ready FROM factory_controls WHERE singleton",
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness timeout")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    return result.rows[0]?.ready === true
      ? { state: "ready" as const }
      : { state: "unready" as const, reason: "emergency_stop" };
  } catch {
    return { state: "unready" as const, reason: "database" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
