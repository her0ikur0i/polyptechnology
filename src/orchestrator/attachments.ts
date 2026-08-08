import type { Attachment, AttachmentState, Classification } from "./types.js";
const transitions: Record<AttachmentState, ReadonlyArray<AttachmentState>> = {
  quarantined: ["validated", "rejected"],
  validated: ["scanned", "rejected"],
  scanned: ["classified", "rejected"],
  classified: ["redacted", "rejected"],
  redacted: [],
  rejected: [],
};
export function validateAttachmentMetadata(value: Attachment): void {
  if (
    !/^[a-zA-Z0-9/_-]+$/.test(value.objectKey) ||
    value.objectKey.includes("..") ||
    value.objectKey.startsWith("/")
  )
    throw new Error("invalid internal object key");
  if (
    Buffer.byteLength(value.displayName) > 255 ||
    /[\0/\\]/.test(value.displayName)
  )
    throw new Error("invalid display name");
  if (
    value.sizeBytes < 1 ||
    value.sizeBytes > 25 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error("invalid attachment bounds");
  if (value.state !== "quarantined")
    throw new Error("new attachment must be quarantined");
}
export function advanceAttachment(
  value: Attachment,
  to: AttachmentState,
  options: {
    evidenceSha256: string;
    classification?: Classification;
    safeText?: string;
  },
): Attachment {
  if (!transitions[value.state].includes(to))
    throw new Error("invalid attachment transition");
  if (!/^[a-f0-9]{64}$/.test(options.evidenceSha256))
    throw new Error("attachment evidence required");
  if (to === "classified" && !options.classification)
    throw new Error("classification required");
  if (
    to === "redacted" &&
    (value.classification === undefined || options.safeText === undefined)
  )
    throw new Error("redacted text required");
  return {
    ...value,
    state: to,
    ...(options.classification
      ? { classification: options.classification }
      : {}),
    ...(options.safeText !== undefined ? { safeText: options.safeText } : {}),
  };
}
