import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import multer from "multer";
import type { Request } from "express";
import type { ConversationStore } from "../orchestrator/types.js";
import { validateAttachmentMetadata } from "../orchestrator/attachments.js";

// Confirmed decision (CONTRACT-014 scope): "scanned" means structural
// type/size validation for this contract, not a real antivirus/content
// -scanning integration -- matches the project's existing "one pinned
// tier first" pragmatism (src/operations/verification-image-policy.ts).
// Deliberately does not advance past "scanned" -- classification/redaction
// need real content-sensitivity judgment, out of this milestone's scope,
// and ADR-0002/context.ts already exclude anything short of "redacted"
// from the assistant's context, so an unclassified attachment is inert
// but safely visible, not silently half-trusted.
const ALLOWED_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/json",
]);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function createAttachmentUpload(storageRoot: string) {
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, callback) => {
        try {
          await mkdir(storageRoot, { recursive: true });
          callback(null, storageRoot);
        } catch (error) {
          callback(error as Error, storageRoot);
        }
      },
      // The stored filename is an opaque internal name, never the
      // client-supplied original -- ADR-0002: "Original filenames are
      // display-only untrusted metadata."
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    fileFilter: (_req: Request, file, callback) => {
      callback(null, ALLOWED_MEDIA_TYPES.has(file.mimetype));
    },
  });
}

const sha256File = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

export async function acceptAttachmentUpload(
  conversations: ConversationStore,
  input: {
    conversationId: string;
    projectId: string;
    storedPath: string;
    storedFilename: string;
    displayName: string;
    mediaType: string;
    sizeBytes: number;
  },
) {
  const sha256 = await sha256File(input.storedPath);
  const attachment = {
    id: randomUUID(),
    conversationId: input.conversationId,
    projectId: input.projectId,
    objectKey: `${input.projectId}/${input.storedFilename}`,
    displayName: input.displayName,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
    sha256,
    state: "quarantined" as const,
  };
  validateAttachmentMetadata(attachment);
  const created = await conversations.putAttachment(attachment, attachment.id);
  await conversations.transitionAttachment(
    input.projectId,
    created.id,
    "quarantined",
    "validated",
    sha256,
  );
  return conversations.transitionAttachment(
    input.projectId,
    created.id,
    "validated",
    "scanned",
    sha256,
  );
}
