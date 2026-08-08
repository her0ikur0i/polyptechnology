import { createHash } from "node:crypto";
import type {
  Attachment,
  ContextItem,
  ContextManifest,
  Conversation,
  Message,
} from "./types.js";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
export function compileContext(
  conversation: Conversation,
  messages: ReadonlyArray<Message>,
  attachments: ReadonlyArray<Attachment>,
  limits = { totalBytes: 64_000, itemBytes: 16_000 },
): ContextManifest {
  if (
    limits.totalBytes < 1 ||
    limits.itemBytes < 1 ||
    limits.itemBytes > limits.totalBytes
  )
    throw new Error("invalid context limits");
  const candidates: ContextItem[] = [];
  for (const message of [...messages].sort((a, b) => a.ordinal - b.ordinal)) {
    if (
      message.projectId !== conversation.projectId ||
      message.conversationId !== conversation.id
    )
      throw new Error("context scope mismatch");
    if (
      message.classification !== "secret" &&
      bytes(message.content) <= limits.itemBytes
    )
      candidates.push({
        kind: "message",
        sourceId: message.id,
        classification: message.classification,
        content: message.content,
        sha256: message.contentSha256,
      });
  }
  for (const attachment of [...attachments].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (
      attachment.projectId !== conversation.projectId ||
      attachment.conversationId !== conversation.id
    )
      throw new Error("context scope mismatch");
    if (
      attachment.state === "redacted" &&
      attachment.classification &&
      attachment.classification !== "secret" &&
      attachment.safeText !== undefined &&
      bytes(attachment.safeText) <= limits.itemBytes
    )
      candidates.push({
        kind: "attachment",
        sourceId: attachment.id,
        classification: attachment.classification,
        content: attachment.safeText,
        sha256: digest(attachment.safeText),
      });
  }
  const items: ContextItem[] = [];
  let totalBytes = 0;
  for (const item of candidates) {
    const size = bytes(item.content);
    if (totalBytes + size > limits.totalBytes) break;
    items.push(item);
    totalBytes += size;
  }
  const canonical = JSON.stringify({
    conversationId: conversation.id,
    projectId: conversation.projectId,
    conversationVersion: conversation.version,
    items: items.map(({ kind, sourceId, classification, sha256 }) => ({
      kind,
      sourceId,
      classification,
      sha256,
    })),
  });
  return {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    conversationVersion: conversation.version,
    items,
    totalBytes,
    manifestSha256: digest(canonical),
  };
}
