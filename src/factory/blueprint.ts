import { createHash } from "node:crypto";
import type { BlueprintDocument } from "./types.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const positive = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
const stringList = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= max &&
  value.every((item) => text(item, 300));

export function parseBlueprint(value: unknown): BlueprintDocument {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !text(value.slug, 63) ||
    !/^[a-z][a-z0-9-]*$/.test(value.slug) ||
    !text(value.displayName) ||
    !record(value.stack) ||
    !text(value.stack.runtime) ||
    !text(value.stack.framework) ||
    !text(value.stack.database) ||
    !stringList(value.requirements, 100) ||
    !stringList(value.qualityGates, 50) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 30 ||
    !value.capabilities.every((item) => text(item, 100)) ||
    !record(value.resources) ||
    !positive(value.resources.cpuMillis, 2000) ||
    !positive(value.resources.memoryMiB, 6144) ||
    !positive(value.resources.diskMiB, 102400) ||
    !positive(value.resources.maxProcesses, 128) ||
    !["none", "egress-allowlist"].includes(String(value.resources.network)) ||
    !record(value.lifecyclePolicy) ||
    value.lifecyclePolicy.productionApproval !== true ||
    value.lifecyclePolicy.destructiveApproval !== true
  )
    throw new Error("invalid or unsafe blueprint");
  if (new Set(value.capabilities).size !== value.capabilities.length)
    throw new Error("duplicate blueprint capability");
  return structuredClone(value) as unknown as BlueprintDocument;
}

export function blueprintDigest(document: BlueprintDocument) {
  return createHash("sha256").update(stable(document)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function isolatedProjectReferences(slug: string, projectId: string) {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(slug) ||
    !/^[a-f0-9-]{36}$/.test(projectId)
  )
    throw new Error("unsafe project identity");
  const suffix = projectId.replaceAll("-", "").slice(0, 12);
  return {
    repositoryRef: `repo://projects/${slug}-${suffix}`,
    workspaceRef: `workspace://projects/${projectId}`,
    databaseNamespace: `project_${suffix}`,
    secretNamespace: `secret://polyp/projects/${projectId}`,
    budgetScope: `project:${projectId}`,
  };
}
