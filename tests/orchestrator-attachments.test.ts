import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAttachment,
  validateAttachmentMetadata,
} from "../src/orchestrator/attachments.js";
const base = {
  id: "a",
  conversationId: "c",
  projectId: "p",
  objectKey: "quarantine/a",
  displayName: "input.txt",
  mediaType: "text/plain",
  sizeBytes: 4,
  sha256: "a".repeat(64),
  state: "quarantined" as const,
};
test("attachment admission and lifecycle fail closed", () => {
  validateAttachmentMetadata(base);
  assert.throws(
    () => validateAttachmentMetadata({ ...base, objectKey: "../secret" }),
    /invalid/,
  );
  const validated = advanceAttachment(base, "validated", {
      evidenceSha256: "b".repeat(64),
    }),
    scanned = advanceAttachment(validated, "scanned", {
      evidenceSha256: "c".repeat(64),
    }),
    classified = advanceAttachment(scanned, "classified", {
      evidenceSha256: "d".repeat(64),
      classification: "confidential",
    }),
    redacted = advanceAttachment(classified, "redacted", {
      evidenceSha256: "e".repeat(64),
      safeText: "safe",
    });
  assert.equal(redacted.safeText, "safe");
  assert.throws(
    () =>
      advanceAttachment(redacted, "validated", {
        evidenceSha256: "f".repeat(64),
      }),
    /invalid/,
  );
});
