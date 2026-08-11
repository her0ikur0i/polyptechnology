import { createHash, randomUUID } from "node:crypto";
import type { OperationDriver } from "./execution-supervisor.js";
import type { AiGateway } from "../gateway/gateway.js";
import type { PostgresProjectFactory } from "../factory/postgres-repository.js";
import {
  normalizeRuntime,
  parseBlueprint,
  SUPPORTED_RUNTIMES,
} from "../factory/blueprint.js";
import type { GatewayAttribution, ModelRoute } from "../gateway/types.js";

export interface BlueprintTranslationTaskInput {
  projectId: string;
  contractCandidate: string;
  expectedProjectVersion: number;
  idempotencyKey: string;
  attribution: GatewayAttribution;
  maxOutputTokens: number;
  maxCostUsdMicros: number;
  policyVersion: string;
  route: ModelRoute;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(
      `blueprint_translation input: ${label} must be a nonblank string`,
    );
  return value;
}

export function parseBlueprintTranslationTaskInput(
  raw: unknown,
): BlueprintTranslationTaskInput {
  if (typeof raw !== "object" || raw === null)
    throw new Error("blueprint_translation input must be an object");
  const input = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(input.expectedProjectVersion))
    throw new Error(
      "blueprint_translation input: expectedProjectVersion invalid",
    );
  return {
    projectId: assertString(input.projectId, "projectId"),
    contractCandidate: assertString(
      input.contractCandidate,
      "contractCandidate",
    ),
    expectedProjectVersion: input.expectedProjectVersion as number,
    idempotencyKey: assertString(input.idempotencyKey, "idempotencyKey"),
    attribution: input.attribution as GatewayAttribution,
    maxOutputTokens: input.maxOutputTokens as number,
    maxCostUsdMicros: input.maxCostUsdMicros as number,
    policyVersion: assertString(input.policyVersion, "policyVersion"),
    route: input.route as ModelRoute,
  };
}

const SYSTEM_PROMPT =
  "Extract a project blueprint from the conversation transcript that " +
  "follows. Respond with ONLY a JSON object -- no markdown fencing, no " +
  'commentary -- matching exactly this shape: {"slug": ' +
  '"lowercase-hyphenated-id", "displayName": "Human readable name", ' +
  '"runtime": "e.g. node-22", "framework": "e.g. express", "database": ' +
  '"e.g. postgresql", "requirements": ["short requirement strings, at ' +
  'least one"]}. If the transcript lacks enough information to fill a ' +
  "field confidently, make a reasonable, conservative choice rather than " +
  "leaving it blank.";

function sanitizeSlugFragment(value: string): string {
  const lowered = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return lowered.length > 0 ? lowered.slice(0, 40) : "project";
}

function extractJsonObject(content: string): unknown {
  // Providers sometimes wrap JSON in a markdown fence even when told not
  // to -- strip a leading/trailing ``` fence if present rather than
  // failing closed on a cosmetic formatting choice the instruction didn't
  // fully prevent.
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

// The real "blueprint translation" M6 scope calls for: an approved
// proposal's narrative contractCandidate (M5's compiled transcript) goes
// through one more AiGateway call (taskClass "orchestration", same as M2 --
// this is still an orchestration-tier task, not code generation) asking
// for structured fields, which are then validated through the *same*
// parseBlueprint() the existing, unmodified generation pipeline (M5 of
// CONTRACT-013) already requires -- so a successful translation is
// guaranteed to produce something createGenerationTask() can actually
// consume, not a shape this driver invented independently.
export class BlueprintTranslationDriver implements OperationDriver {
  constructor(
    private readonly gateway: AiGateway,
    private readonly factory: PostgresProjectFactory,
  ) {}

  async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
    const stored = parseBlueprintTranslationTaskInput(input);
    const result = await this.gateway.execute({
      idempotencyKey: stored.idempotencyKey,
      taskClass: "orchestration",
      attribution: stored.attribution,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: stored.contractCandidate },
      ],
      maxOutputTokens: stored.maxOutputTokens,
      maxCostUsdMicros: stored.maxCostUsdMicros,
      policyVersion: stored.policyVersion,
      routeOverride: stored.route,
      signal,
    });

    let extracted: unknown;
    try {
      extracted = extractJsonObject(result.content);
    } catch {
      return { verified: false, reason: "model response was not valid JSON" };
    }
    if (typeof extracted !== "object" || extracted === null)
      return {
        verified: false,
        reason: "model response was not a JSON object",
      };
    const fields = extracted as Record<string, unknown>;

    // The model answers `runtime` in free text, and everything downstream
    // treats it as a controlled vocabulary. Normalise here, at the boundary
    // that owns the conversion, and fail honestly when it maps to nothing --
    // rather than at provisioning time, several minutes and one queued task
    // later, with an error about an unsupported runtime the owner never chose.
    //
    // The first blueprint this factory ever produced said "node-22" and could
    // not be provisioned because of exactly this gap.
    const requestedRuntime =
      typeof fields.runtime === "string" && fields.runtime.length > 0
        ? fields.runtime
        : "node";
    const runtime = normalizeRuntime(requestedRuntime);
    if (runtime === undefined)
      return {
        verified: false,
        reason:
          `blueprint runtime ${JSON.stringify(requestedRuntime)} is not supported ` +
          `(supported: ${SUPPORTED_RUNTIMES.join(", ")})`,
      };

    const blueprintId = randomUUID();
    const slug = `${sanitizeSlugFragment(
      typeof fields.slug === "string" ? fields.slug : "",
    )}-${blueprintId.replaceAll("-", "").slice(0, 8)}`;
    const document = {
      schemaVersion: 1 as const,
      slug,
      displayName:
        typeof fields.displayName === "string" && fields.displayName.length > 0
          ? fields.displayName.slice(0, 200)
          : "Generated project",
      stack: {
        runtime,
        framework:
          typeof fields.framework === "string" ? fields.framework : "none",
        database:
          typeof fields.database === "string" ? fields.database : "none",
      },
      requirements: Array.isArray(fields.requirements)
        ? fields.requirements.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      qualityGates: ["typecheck", "format:check", "test"],
      capabilities: [] as string[],
      resources: {
        cpuMillis: 500,
        memoryMiB: 1024,
        diskMiB: 4096,
        maxProcesses: 32,
        network: "none" as const,
      },
      lifecyclePolicy: { productionApproval: true, destructiveApproval: true },
    };
    if (document.requirements.length === 0)
      document.requirements.push(
        "Requirements were not clearly specified in the conversation.",
      );

    let blueprint;
    try {
      blueprint = parseBlueprint(document);
    } catch (error) {
      return {
        verified: false,
        reason:
          error instanceof Error
            ? error.message
            : "extracted document failed blueprint validation",
      };
    }

    const versionId = randomUUID();
    try {
      await this.factory.publishBlueprint({
        blueprintId,
        versionId,
        version: 1,
        createdAt: new Date().toISOString(),
        document: blueprint,
      });
      const project = await this.factory.attachBlueprintVersion({
        projectId: stored.projectId,
        blueprintVersionId: versionId,
        expectedVersion: stored.expectedProjectVersion,
      });
      await this.factory.transition(project.id, {
        idempotencyKey: stored.idempotencyKey,
        expectedVersion: project.version,
        to: "blueprint",
        actorId: "conversation-interview",
        correlationId: stored.idempotencyKey,
        // The transitioned-to blueprint version id is always present and
        // deterministic here -- a real, always-available piece of evidence
        // for this transition, unlike result.attempt.outputSha256 (present
        // on a successful gateway attempt in practice, but typed optional).
        evidenceSha256: createHash("sha256").update(versionId).digest("hex"),
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      return {
        verified: false,
        reason:
          error instanceof Error
            ? error.message
            : "could not attach the derived blueprint to the project",
      };
    }

    return { verified: true, blueprintVersionId: versionId, slug };
  }
}
