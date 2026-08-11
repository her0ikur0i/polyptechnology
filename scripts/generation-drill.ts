import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Pool } from "pg";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { OwnerCommandService } from "../src/operations/owner-commands.js";
import { queueBlueprintTranslation } from "../src/factory/blueprint-translation-task.js";
import { NodeWorkspaceProvisioner } from "../src/factory/workspace-provisioner.js";
import { FactoryLifecycleAdvancer } from "../src/factory/generation-lifecycle.js";
import { parseBlueprint } from "../src/factory/blueprint.js";
import { createGenerationTask } from "../src/factory/generation-task.js";
import { deterministicUuid } from "../src/deterministic-id.js";
import type { OwnerContext } from "../src/operations/owner-commands.js";

// Drives the generation pipeline end to end against a real database, and says
// exactly how far it got.
//
// This exists because the pipeline had never run. On 2026-08-11 staging held
// seven generated projects, all in `idea`, with zero proposals and zero
// generation tasks -- every stage below was written, unit-tested, audited and
// security-reviewed without once being executed in sequence. A green suite
// proves the units agree with their tests; only this proves the factory works.
//
// Two rules govern the reporting, both inherited from CONTRACT-017B:
//
//   1. It reports the stage it *reached*, never a stage it assumed. A failure
//      names the stage that failed and the real error, and never attributes a
//      failure to a component that was never called.
//   2. A skipped stage is reported as skipped, not as passed.
//
// Deliberately drives the service layer rather than HTTP: the Control API
// routes are thin wrappers over exactly these calls, and going through them
// would add CSRF and session mechanics that are tested elsewhere and would
// obscure which pipeline stage failed. The one thing this loses is the
// *process identity* of the Control API -- see PERMISSION NOTE below.

const execFileAsync = promisify(execFile);

const OWNER_ACTOR = "generation-drill";

export type StageState = "passed" | "failed" | "skipped" | "pending";

export interface StageReport {
  name: string;
  state: StageState;
  detail?: string;
  // Anything a later stage needs, or a human wants to look up afterwards.
  facts?: Readonly<Record<string, string>>;
}

export interface DrillReport {
  runLabel: string;
  reached: string;
  stages: ReadonlyArray<StageReport>;
  ok: boolean;
}

// Every identifier the drill creates derives from this label, so re-running
// with the same label resumes against the same conversation and project
// instead of littering the database with abandoned attempts.
function runIdentity(runLabel: string) {
  return {
    conversationKey: deterministicUuid(`drill:${runLabel}:conversation`),
    proposalKey: deterministicUuid(`drill:${runLabel}:proposal`),
  };
}

export function renderReport(report: DrillReport): string {
  const symbol: Record<StageState, string> = {
    passed: "ok  ",
    failed: "FAIL",
    skipped: "skip",
    pending: "----",
  };
  const lines = [
    `generation drill: ${report.runLabel}`,
    `reached: ${report.reached}`,
    "",
  ];
  for (const stage of report.stages) {
    lines.push(
      `  ${symbol[stage.state]}  ${stage.name}${
        stage.detail === undefined ? "" : ` -- ${stage.detail}`
      }`,
    );
    for (const [key, value] of Object.entries(stage.facts ?? {}))
      lines.push(`          ${key}: ${value}`);
  }
  return lines.join("\n");
}

export async function runDrill(
  pool: Pool,
  runLabel: string,
  workspacesRoot: string,
  depth: "simple" | "deep" = "simple",
): Promise<DrillReport> {
  const brief = depth === "deep" ? DEEP_BRIEF : SIMPLE_BRIEF;
  const identity = runIdentity(runLabel);
  const stages: StageReport[] = [];
  const conversations = new PostgresConversationStore(pool);
  const factory = new PostgresProjectFactory(pool);
  // The service compares this with timingSafeEqual against the context's
  // token; both sides are ours here, so a fresh random secret per run is
  // correct -- it authenticates nothing, it only satisfies the guard that
  // exists for HTTP callers.
  const csrfToken = randomBytes(32).toString("hex");
  const owner = new OwnerCommandService(
    factory,
    conversations,
    csrfToken,
    new OrchestratorService(conversations),
    // No reply is queued: the drill is proving the generation path, and an
    // assistant reply would spend real money on a turn nothing reads.
  );
  const context: OwnerContext = {
    authenticated: true,
    actorId: OWNER_ACTOR,
    csrfToken,
  };

  let reached = "nothing";
  const record = (stage: StageReport) => {
    stages.push(stage);
    if (stage.state === "passed") reached = stage.name;
    return stage;
  };
  const remaining = (from: number, why: string) => {
    for (const name of STAGE_NAMES.slice(from))
      stages.push({ name, state: "skipped", detail: why });
  };

  // --- 1. conversation -----------------------------------------------------
  let projectId: string, conversationId: string, conversationVersion: number;
  try {
    const started = await owner.startConversation(context, {
      idempotencyKey: identity.conversationKey,
      occurredAt: new Date().toISOString(),
      title: `Generation drill ${runLabel}`,
    });
    projectId = started.projectId;
    conversationId = started.conversationId;
    conversationVersion = started.version;
    record({
      name: "conversation",
      state: "passed",
      facts: { projectId, conversationId },
    });
  } catch (error) {
    record({ name: "conversation", state: "failed", detail: message(error) });
    remaining(1, "conversation did not start");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 2. brief ------------------------------------------------------------
  // A proposal is compiled from the conversation transcript, so the
  // conversation needs to contain the requirements. Written by the drill
  // rather than by a model: what is being proven here is the pipeline, and a
  // model-authored brief would make the blueprint's contents vary run to run
  // for no gain.
  try {
    const sent = await owner.sendMessage(context, {
      projectId,
      conversationId,
      expectedVersion: conversationVersion,
      idempotencyKey: deterministicUuid(`drill:${runLabel}:brief`),
      occurredAt: new Date().toISOString(),
      content: brief,
    });
    // appendMessage() returns the message, not the conversation, so the
    // fence is tracked here rather than read back.
    conversationVersion += 1;
    record({
      name: "brief",
      state: "passed",
      facts: { ordinal: String(sent.ordinal) },
    });
  } catch (error) {
    record({ name: "brief", state: "failed", detail: message(error) });
    remaining(2, "no brief to propose from");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 3. proposal ---------------------------------------------------------
  let proposalId: string, proposalVersion: number;
  try {
    const drafted = await owner.draftProposal(context, {
      projectId,
      conversationId,
      idempotencyKey: identity.proposalKey,
      occurredAt: new Date().toISOString(),
    });
    proposalId = drafted.proposalId;
    proposalVersion = drafted.version;
    record({
      name: "proposal",
      state: "passed",
      facts: { proposalId, state: drafted.state },
    });
  } catch (error) {
    record({ name: "proposal", state: "failed", detail: message(error) });
    remaining(3, "no proposal to approve");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 4. approval ---------------------------------------------------------
  // approveProposal() approves *and* hands off: there is no owner decision
  // between the two states, so one action covers both. This is the authority
  // boundary the whole system rests on -- nothing reaches the generation
  // pipeline that the owner did not approve -- and the drill exercises it
  // rather than writing `handed_off` directly.
  let contractCandidate: string;
  try {
    const handed = await owner.approveProposal(context, {
      projectId,
      proposalId,
      expectedVersion: proposalVersion,
    });
    contractCandidate = handed.contractCandidate;
    // handoff() returns the frozen candidate, not the row, so the state is
    // read back rather than assumed. Asserting on what the database holds is
    // the whole point of a drill.
    const stored = await conversations.proposal(projectId, proposalId);
    if (stored === undefined)
      throw new Error("proposal vanished after handoff");
    if (stored.state !== "handed_off")
      throw new Error(`expected handed_off, got ${stored.state}`);
    record({
      name: "approval",
      state: "passed",
      facts: {
        state: stored.state,
        approvalId: handed.approvalId,
        version: String(stored.version),
      },
    });
  } catch (error) {
    record({ name: "approval", state: "failed", detail: message(error) });
    remaining(4, "proposal was never handed off");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 5. translation ------------------------------------------------------
  // Queues the real blueprint_translation task. The supervisor executes it
  // out of process, so the drill queues and reports the task id; waiting for
  // it is M3's job, together with the stages that depend on its output.
  try {
    const project = await factory.getProject(projectId);
    if (project === undefined) throw new Error("project vanished");
    const queued = await queueBlueprintTranslation(pool, {
      projectId,
      proposalId,
      contractCandidate,
      expectedProjectVersion: project.version,
    });
    record({
      name: "translation",
      state: "passed",
      detail: "queued; execution is the supervisor's",
      facts: { taskId: queued.taskId, projectState: project.state },
    });
  } catch (error) {
    record({ name: "translation", state: "failed", detail: message(error) });
    remaining(5, "no blueprint to build from");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 6. provisioning -----------------------------------------------------
  // Waits for the supervisor to finish translating, then provisions the
  // workspace the blueprint describes and advances the project to
  // `provisioned` -- a state nothing in this system had ever written before
  // CONTRACT-017C.
  try {
    const translated = await waitForProjectState(
      factory,
      projectId,
      "blueprint",
      TRANSLATION_TIMEOUT_MS,
    );
    const versionRow = await pool.query<{ document: unknown }>(
      "SELECT document FROM project_blueprint_versions WHERE id=$1",
      [translated.blueprintVersionId],
    );
    if (versionRow.rowCount !== 1)
      throw new Error("blueprint version not found");
    const blueprint = parseBlueprint(versionRow.rows[0]!.document);

    const provisioner = new NodeWorkspaceProvisioner(workspacesRoot);
    const { repoPath } = await provisioner.provision(projectId, blueprint);
    await new FactoryLifecycleAdvancer(factory).provisioned(
      projectId,
      translated.workspaceRef,
    );
    const provisioned = await factory.getProject(projectId);
    record({
      name: "provisioning",
      state: "passed",
      facts: {
        runtime: blueprint.stack.runtime,
        repoPath,
        projectState: provisioned?.state ?? "unknown",
      },
    });
  } catch (error) {
    record({ name: "provisioning", state: "failed", detail: message(error) });
    remaining(6, "no workspace to generate into");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 7. generation -------------------------------------------------------
  // The real thing: a provider writes the code. `bulk_code` routes
  // deepseek-v4-flash -> deepseek-v4-pro -> codex -> claude, so DeepSeek is the
  // executor and the others are fallback tiers, exactly as the execution policy
  // requires. The supervisor runs it out of process; the drill waits on the
  // task and reports which provider actually produced the accepted patch.
  try {
    const project = await factory.getProject(projectId);
    if (project === undefined) throw new Error("project vanished");
    const versionRow = await pool.query<{ document: unknown }>(
      "SELECT document FROM project_blueprint_versions WHERE id=$1",
      [project.blueprintVersionId],
    );
    const blueprint = parseBlueprint(versionRow.rows[0]!.document);
    const repoPath = join(workspacesRoot, projectId, "repo");

    const task = await createGenerationTask(pool, project, blueprint, repoPath);
    const outcome = await waitForTask(pool, task.taskId, GENERATION_TIMEOUT_MS);
    const attempts = await pool.query<{
      provider_id: string;
      requested_model_id: string;
      status: string;
    }>(
      `SELECT provider_id, requested_model_id, status FROM provider_artifacts
        WHERE task_id = $1 ORDER BY created_at ASC`,
      [task.taskId],
    );
    const walked = attempts.rows
      .map(
        (row) => `${row.provider_id}:${row.requested_model_id}=${row.status}`,
      )
      .join(" -> ");

    if (outcome !== "succeeded")
      throw new Error(
        `generation task ended ${outcome}${walked === "" ? "" : `; tiers: ${walked}`}`,
      );

    const generated = await factory.getProject(projectId);
    record({
      name: "generation",
      state: "passed",
      facts: {
        taskId: task.taskId,
        tiers: walked === "" ? "none recorded" : walked,
        projectState: generated?.state ?? "unknown",
      },
    });
  } catch (error) {
    record({ name: "generation", state: "failed", detail: message(error) });
    remaining(7, "nothing was generated");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 8. verification ------------------------------------------------------
  // The Docker gates ran inside the generation stage; this asserts on what they
  // actually recorded rather than restating the stage above. Read back from the
  // database, because the point of a drill is that the record agrees.
  try {
    const accepted = await pool.query<{
      provider_id: string;
      requested_model_id: string;
      verifier_id: string | null;
      patch_sha256: string | null;
      changed_lines: number;
    }>(
      `SELECT provider_id, requested_model_id, verifier_id, patch_sha256, changed_lines
         FROM provider_artifacts
        WHERE task_id = (SELECT task_id FROM operation_task_specs
                          WHERE role = 'factory-generation'
                          ORDER BY created_at DESC LIMIT 1)
          AND status = 'accepted'
        ORDER BY created_at DESC LIMIT 1`,
    );
    const row = accepted.rows[0];
    if (row === undefined) throw new Error("no accepted artifact recorded");
    if (row.verifier_id === null)
      throw new Error("accepted without a verifier -- the gate did not run");
    if (row.patch_sha256 === null)
      throw new Error("accepted without a patch hash");
    record({
      name: "verification",
      state: "passed",
      facts: {
        verifier: row.verifier_id,
        by: `${row.provider_id}:${row.requested_model_id}`,
        changedLines: String(row.changed_lines),
      },
    });
  } catch (error) {
    record({ name: "verification", state: "failed", detail: message(error) });
    remaining(8, "nothing verified");
    return { runLabel, reached, stages, ok: false };
  }

  // --- 9. publication -------------------------------------------------------
  // The accepted patch is committed into the generated project's own
  // repository, so what the factory built is durable rather than a dirty
  // working tree that the next attempt's revert would erase.
  try {
    const repoPath = join(workspacesRoot, projectId, "repo");
    const head = await gitOutput(repoPath, ["rev-parse", "HEAD"]);
    const subject = await gitOutput(repoPath, [
      "log",
      "-1",
      "--pretty=format:%s",
    ]);
    const dirty = await gitOutput(repoPath, ["status", "--porcelain"]);
    if (subject.startsWith("Initial scaffold"))
      throw new Error("only the scaffold commit exists; nothing was published");
    record({
      name: "publication",
      state: "passed",
      facts: {
        commit: head.slice(0, 12),
        subject,
        workingTree: dirty === "" ? "clean" : "dirty",
      },
    });
  } catch (error) {
    record({ name: "publication", state: "failed", detail: message(error) });
    return { runLabel, reached, stages, ok: false };
  }

  return { runLabel, reached, stages, ok: true };
}

async function gitOutput(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

const GENERATION_TIMEOUT_MS = 900_000;

const TERMINAL_TASK_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_blocked",
]);

async function waitForTask(
  pool: Pool,
  taskId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM tasks WHERE id = $1",
      [taskId],
    );
    const state = result.rows[0]?.state;
    if (state === undefined) throw new Error("generation task vanished");
    if (TERMINAL_TASK_STATES.has(state)) return state;
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s with the task in ${state}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const TRANSLATION_TIMEOUT_MS = 180_000;

// The supervisor executes the translation in another process, so the drill
// waits on the project's recorded state rather than on a task row: the state
// is what the next stage actually depends on.
async function waitForProjectState(
  factory: PostgresProjectFactory,
  projectId: string,
  state: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await factory.getProject(projectId);
    if (project === undefined) throw new Error("project vanished");
    if (project.state === state) return project;
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for project state ` +
          `${state}; it is ${project.state}. Is polyp-sequence.service running?`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const STAGE_NAMES = [
  "conversation",
  "brief",
  "proposal",
  "approval",
  "translation",
  "provisioning",
  "generation",
  "verification",
  "publication",
] as const;

// Small enough to verify quickly and cheaply, real enough that passing means
// something: it has behaviour worth testing, and the tests can genuinely fail.
// Small enough to verify quickly and cheaply, real enough that passing means
// something: it has behaviour worth testing, and the tests can genuinely fail.
const SIMPLE_BRIEF = [
  "Build a tiny Node/TypeScript library called `slugify`.",
  "",
  "Requirements:",
  "- Export a function `slugify(input: string): string`.",
  "- Lowercase the input, replace runs of non-alphanumeric characters with a",
  "  single hyphen, and trim leading and trailing hyphens.",
  "- An empty or all-punctuation input returns an empty string.",
  "- Cover every rule above with tests using node:test.",
  "",
  "Stack: node runtime, no framework, no database.",
].join("\n");

// Deliberately harder, and harder along the axes that actually broke things.
//
// Every success so far came from the one brief above: a single pure function
// in a single file. That proves the pipeline runs; it does not prove the
// pipeline generalises, and the difference matters because the failures this
// contract fixed were mostly about diff *shape* -- multi-file patches, new
// directories, hunks against files that already have content.
//
// So this asks for several exported functions with interacting rules, error
// cases that must throw, and enough surface that a model will naturally split
// it across files.
const DEEP_BRIEF = [
  "Build a Node/TypeScript library called `moneybag` for handling money without",
  "floating-point error.",
  "",
  "Requirements:",
  "- Represent an amount as integer minor units (cents) plus a 3-letter",
  "  uppercase currency code.",
  '- Export `fromString(text: string)`, parsing forms like "USD 12.34",',
  '  "usd 12.3" and "EUR 0.05" into that representation. Reject anything else',
  "  by throwing an Error.",
  "- Export `add(a, b)` and `subtract(a, b)`. Both throw when the currencies",
  "  differ.",
  "- Export `allocate(amount, ratios: number[])`, splitting an amount across",
  "  ratios so that no minor unit is lost -- the parts must sum exactly to the",
  "  original. Distribute any remainder one unit at a time to the earliest",
  "  parts.",
  '- Export `format(amount): string` returning e.g. "USD 12.34", always with',
  "  two decimal places.",
  "- Cover every rule and every error case with tests using node:test,",
  "  including that allocate never loses or invents a cent.",
  "",
  "Stack: node runtime, no framework, no database. No dependencies.",
].join("\n");

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// PERMISSION NOTE
//
// Run as root, this drill will not reproduce the deployment defect M1 found:
// /var/lib/polyp-ai-factory/project-workspaces is root:root 755 while the
// Control API runs as polyp-factory, so provisioning fails there and would
// succeed here. M3 fixes the permission and asserts it directly rather than
// inferring it from a drill that happens to run as the wrong user.

const invoked = process.argv[1]?.endsWith("generation-drill.ts") === true;
if (invoked) {
  const databaseUrl = process.env.DATABASE_URL;
  const runLabel = process.argv[2] ?? "default";
  const workspacesRoot =
    process.env.PROJECT_WORKSPACES_ROOT ?? "/var/lib/polyp/project-workspaces";
  const depth = process.argv[3] === "deep" ? "deep" : "simple";
  if (databaseUrl === undefined) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const report = await runDrill(pool, runLabel, workspacesRoot, depth);
      console.log(renderReport(report));
      if (!report.ok) process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
