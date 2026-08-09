import { createHash } from "node:crypto";

// Derives a stable, replay-safe UUID from an arbitrary string (an
// idempotency key, a composite scope tag) -- same input always produces
// the same id, so retrying an already-applied command reuses the same
// row instead of creating a duplicate. Used across the conversation
// workspace (CONTRACT-014) wherever a task/contract/milestone/message id
// needs to be deterministic rather than random.
export function deterministicUuid(value: string): string {
  const hex = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
