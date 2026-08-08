import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
export interface BackupManifest {
  id: string;
  sourceDatabase: string;
  migrationHead: string;
  artifactRef: string;
  artifactSha256: string;
  sizeBytes: number;
  encryptionState: "provider_encrypted" | "envelope_encrypted";
  keyRef: string;
  coveredDomains: ReadonlyArray<string>;
  createdAt: string;
}
export function createBackupManifest(
  input: Omit<BackupManifest, "id" | "artifactSha256" | "sizeBytes">,
  artifact: Uint8Array,
): BackupManifest {
  if (
    artifact.byteLength < 1 ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(input.sourceDatabase) ||
    !/^000[1-9]_[a-z0-9_]+$/.test(input.migrationHead) ||
    !/^backup:\/\/[a-zA-Z0-9/_-]+$/.test(input.artifactRef) ||
    !/^keyref:\/\/[a-zA-Z0-9/_-]+$/.test(input.keyRef) ||
    input.coveredDomains.length === 0
  )
    throw new Error("invalid backup manifest");
  return {
    id: randomUUID(),
    ...input,
    artifactSha256: createHash("sha256").update(artifact).digest("hex"),
    sizeBytes: artifact.byteLength,
  };
}
export function verifyBackupArtifact(
  manifest: BackupManifest,
  artifact: Uint8Array,
) {
  const digest = createHash("sha256").update(artifact).digest("hex");
  if (
    artifact.byteLength !== manifest.sizeBytes ||
    digest !== manifest.artifactSha256
  )
    throw new Error("backup artifact integrity failure");
  return true;
}
export class PostgresBackupCatalog {
  constructor(private readonly pool: Pool) {}
  async record(manifest: BackupManifest) {
    await this.pool.query(
      "INSERT INTO backup_manifests(id,source_database,migration_head,artifact_ref,artifact_sha256,size_bytes,encryption_state,key_ref,covered_domains,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        manifest.id,
        manifest.sourceDatabase,
        manifest.migrationHead,
        manifest.artifactRef,
        manifest.artifactSha256,
        manifest.sizeBytes,
        manifest.encryptionState,
        manifest.keyRef,
        JSON.stringify(manifest.coveredDomains),
        manifest.createdAt,
      ],
    );
    return manifest;
  }
}
