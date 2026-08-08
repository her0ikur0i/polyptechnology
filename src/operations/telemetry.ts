const deniedKey = /(authorization|cookie|password|secret|token|api[-_]?key)/iu;
const deniedValue =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\b\d{7,12}:[A-Za-z0-9_-]{20,})/u;
export type LogLevel = "debug" | "info" | "warn" | "error";
export function structuredEvent(
  event: string,
  level: LogLevel,
  attributes: unknown,
  now = new Date(),
) {
  if (!/^[a-z][a-z0-9_.-]{1,80}$/.test(event))
    throw new Error("invalid telemetry event");
  return JSON.stringify({
    timestamp: now.toISOString(),
    level,
    event,
    attributes: scrub(attributes, 0),
  });
}
function scrub(value: unknown, depth: number): unknown {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (typeof value === "string")
    return deniedValue.test(value) ? "[REDACTED]" : value.slice(0, 1000);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [
          key.slice(0, 80),
          deniedKey.test(key) ? "[REDACTED]" : scrub(item, depth + 1),
        ]),
    );
  return String(value).slice(0, 200);
}
