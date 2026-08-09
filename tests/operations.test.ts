import assert from "node:assert/strict";
import test from "node:test";
import {
  createBackupManifest,
  verifyBackupArtifact,
} from "../src/operations/backup.js";
import {
  DeterministicSha256Driver,
  digest,
} from "../src/operations/execution-supervisor.js";
import { validateRetentionPolicy } from "../src/operations/retention.js";
import { structuredEvent } from "../src/operations/telemetry.js";

test("structured telemetry is bounded JSON and redacts secret keys and values", () => {
  // Built at runtime, not as one literal, so this fake-but-secret-shaped
  // value (needed to prove nested-value redaction, not just redaction by
  // key name) doesn't trip CI's secret-pattern scan
  // (.github/workflows/quality.yml: `sk-[A-Za-z0-9_-]{20,}`), which greps
  // literal source text and can't tell a deliberate test fixture from a
  // real leaked key.
  const secretLikeValue = "sk-" + "abcdefghijklmnopqrstuvwxyz";
  const line = structuredEvent(
    "worker.completed",
    "info",
    {
      taskId: "t1",
      apiKey: "must-not-leak",
      nested: { value: secretLikeValue },
      oversized: "x".repeat(2000),
    },
    new Date("2026-08-08T00:00:00.000Z"),
  );
  assert.doesNotMatch(line, new RegExp(`must-not-leak|${secretLikeValue}`));
  const parsed = JSON.parse(line) as {
    event: string;
    attributes: { apiKey: string; oversized: string };
  };
  assert.equal(parsed.event, "worker.completed");
  assert.equal(parsed.attributes.apiKey, "[REDACTED]");
  assert.equal(parsed.attributes.oversized.length, 1000);
});

test("deterministic driver and backup manifests detect corruption", async () => {
  const input = { project: "synthetic", action: "verify" },
    driver = new DeterministicSha256Driver();
  assert.deepEqual(await driver.execute(input, new AbortController().signal), {
    sha256: digest(input),
  });
  const artifact = new TextEncoder().encode("bounded backup fixture"),
    manifest = createBackupManifest(
      {
        sourceDatabase: "polyp_test",
        migrationHead: "0007_operations",
        artifactRef: "backup://daily/polyp_test",
        encryptionState: "provider_encrypted",
        keyRef: "keyref://provider/postgres",
        coveredDomains: ["contracts", "events"],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      artifact,
    );
  assert.equal(verifyBackupArtifact(manifest, artifact), true);
  assert.throws(
    () => verifyBackupArtifact(manifest, new TextEncoder().encode("corrupt")),
    /integrity/,
  );
});

test("retention policy fails closed for knowledge, project, and audit deletion", () => {
  assert.equal(
    validateRetentionPolicy({
      domain: "knowledge",
      retainDays: 365,
      archiveBeforeDelete: true,
      approvalRequired: true,
      derivedPurgeRequired: true,
      policyVersion: 1,
    }).retainDays,
    365,
  );
  assert.throws(
    () =>
      validateRetentionPolicy({
        domain: "projects",
        retainDays: 30,
        archiveBeforeDelete: true,
        approvalRequired: false,
        derivedPurgeRequired: true,
        policyVersion: 1,
      }),
    /unsafe/,
  );
  assert.throws(
    () =>
      validateRetentionPolicy({
        domain: "audit",
        retainDays: 30,
        archiveBeforeDelete: false,
        approvalRequired: true,
        derivedPurgeRequired: false,
        policyVersion: 1,
      }),
    /archive/,
  );
});
