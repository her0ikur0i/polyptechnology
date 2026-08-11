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

// The runtimes this factory can actually scaffold and verify. One today, and
// the list rather than a bare string comparison because CONTRACT-021 widens it.
export const SUPPORTED_RUNTIMES = ["node"] as const;
export type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

// Aliases a model plausibly writes for a runtime we support. Deliberately
// small and explicit: an unknown runtime must fail, not be guessed at.
const RUNTIME_ALIASES = new Map<string, SupportedRuntime>([
  ["node", "node"],
  ["nodejs", "node"],
  ["typescript", "node"],
  ["ts", "node"],
  ["javascript", "node"],
  ["js", "node"],
  ["deno", "node"], // close enough to scaffold; CONTRACT-021 can disagree
]);

// Maps a model's free-text runtime answer onto the supported vocabulary, or
// returns undefined when it maps onto nothing.
//
// This exists because of a real failure. The first blueprint this factory ever
// produced said `"runtime": "node-22"` -- a *better* answer than "node", since
// the host does run Node 22 -- and `NodeWorkspaceProvisioner` rejected it,
// because it compares against the single string "node". Every other field in a
// translated blueprint is either fixed by the driver or validated; runtime
// alone was passed through untouched into an exact-match check.
//
// The fault was never the model's and never really the provisioner's: a
// controlled vocabulary needs a boundary that converts into it. This is that
// boundary. It normalises aggressively (case, punctuation, trailing version
// digits) and then matches exactly, so `python3` still fails closed rather than
// being scaffolded as Node -- which is the failure the provisioner's strict
// check exists to prevent, and which is preserved here.
export function normalizeRuntime(raw: string): SupportedRuntime | undefined {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  // "node22" -> "node", "node2210" -> "node". Version digits only ever trail.
  const withoutVersion = collapsed.replace(/[0-9]+$/, "");
  return RUNTIME_ALIASES.get(collapsed) ?? RUNTIME_ALIASES.get(withoutVersion);
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
