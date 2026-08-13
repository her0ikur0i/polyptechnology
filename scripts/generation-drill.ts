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
import type { ProposalState } from "../src/orchestrator/types.js";

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

function deterministicProjectId(idempotencyKey: string): string {
  return deterministicUuid(`${OWNER_ACTOR}:${idempotencyKey}:project`);
}

function deterministicConversationId(idempotencyKey: string): string {
  return deterministicUuid(`${OWNER_ACTOR}:${idempotencyKey}:conversation`);
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
  depth:
    | "simple"
    | "deep"
    | "landing"
    | "complex"
    | "extreme"
    | "ui-extreme"
    | "ui-deep-extreme" = "simple",
): Promise<DrillReport> {
  const brief =
    depth === "deep"
      ? DEEP_BRIEF
      : depth === "landing"
        ? LANDING_BRIEF
        : depth === "complex"
          ? COMPLEX_BRIEF
          : depth === "extreme"
            ? EXTREME_BRIEF
            : depth === "ui-extreme" || depth === "ui-deep-extreme"
              ? UI_EXTREME_BRIEF
              : SIMPLE_BRIEF;
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
    projectId = deterministicProjectId(identity.conversationKey);
    conversationId = deterministicConversationId(identity.conversationKey);
    const existing = await conversations.conversation(
      projectId,
      conversationId,
    );
    if (existing === undefined) {
      record({ name: "conversation", state: "failed", detail: message(error) });
      remaining(1, "conversation did not start");
      return { runLabel, reached, stages, ok: false };
    }
    conversationVersion = existing.version;
    record({
      name: "conversation",
      state: "passed",
      detail: `resumed after ${message(error)}`,
      facts: { projectId, conversationId },
    });
  }

  // --- 2. brief ------------------------------------------------------------
  // A proposal is compiled from the conversation transcript, so the
  // conversation needs to contain the requirements. Written by the drill
  // rather than by a model: what is being proven here is the pipeline, and a
  // model-authored brief would make the blueprint's contents vary run to run
  // for no gain.
  try {
    const existingMessages = await conversations.messages(
      projectId,
      conversationId,
    );
    const existingBrief = existingMessages.find(
      (message) => message.role === "owner" && message.content === brief,
    );
    const sent =
      existingBrief ??
      (await owner.sendMessage(context, {
        projectId,
        conversationId,
        expectedVersion: conversationVersion,
        idempotencyKey: deterministicUuid(`drill:${runLabel}:brief`),
        occurredAt: new Date().toISOString(),
        content: brief,
      }));
    // appendMessage() returns the message, not the conversation, so the fence
    // is tracked here. On resume, read the actual conversation version instead
    // of assuming this process appended the brief.
    conversationVersion = Math.max(conversationVersion, sent.ordinal);
    record({
      name: "brief",
      state: "passed",
      ...(existingBrief === undefined
        ? {}
        : { detail: "resumed existing brief" }),
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
    let drafted: Awaited<ReturnType<OwnerCommandService["draftProposal"]>>;
    try {
      drafted = await owner.draftProposal(context, {
        projectId,
        conversationId,
        idempotencyKey: identity.proposalKey,
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      const existing = await pool.query<{
        id: string;
        state: string;
        version: string;
        contract_candidate: string;
      }>(
        `SELECT id, state, version, contract_candidate
           FROM conversation_proposals
          WHERE project_id=$1 AND conversation_id=$2
          ORDER BY version DESC LIMIT 1`,
        [projectId, conversationId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw error;
      drafted = {
        proposalId: row.id,
        conversationId,
        state: row.state as ProposalState,
        version: Number(row.version),
        contractCandidate: row.contract_candidate,
      };
    }
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
    let approvalId: string | undefined;
    let stored = await conversations.proposal(projectId, proposalId);
    if (stored?.state === "handed_off") {
      contractCandidate = stored.contractCandidate;
      approvalId = stored.approvalId;
    } else {
      const handed = await owner.approveProposal(context, {
        projectId,
        proposalId,
        expectedVersion: proposalVersion,
      });
      contractCandidate = handed.contractCandidate;
      approvalId = handed.approvalId;
      // handoff() returns the frozen candidate, not the row, so the state is
      // read back rather than assumed. Asserting on what the database holds is
      // the whole point of a drill.
      stored = await conversations.proposal(projectId, proposalId);
    }
    if (stored === undefined)
      throw new Error("proposal vanished after handoff");
    if (stored.state !== "handed_off")
      throw new Error(`expected handed_off, got ${stored.state}`);
    record({
      name: "approval",
      state: "passed",
      facts: {
        state: stored.state,
        approvalId: approvalId ?? "already-handed-off",
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
    const existing = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM operation_task_specs s
         JOIN tasks t ON t.id=s.task_id
        WHERE s.driver='blueprint_translation'
          AND s.input->>'projectId'=$1
          AND s.input->>'proposalId'=$2
          AND t.state <> 'failed'
        ORDER BY s.created_at DESC LIMIT 1`,
      [projectId, proposalId],
    );
    const alreadyTranslated = project.state !== "idea";
    const queued =
      alreadyTranslated && existing.rows[0] === undefined
        ? { taskId: "already-translated" }
        : existing.rows[0] === undefined
          ? await queueBlueprintTranslation(pool, {
              projectId,
              proposalId,
              contractCandidate,
              expectedProjectVersion: project.version,
            })
          : { taskId: existing.rows[0].task_id };
    record({
      name: "translation",
      state: "passed",
      detail:
        alreadyTranslated && existing.rows[0] === undefined
          ? "resumed after translation"
          : existing.rows[0] === undefined
            ? "queued; execution is the supervisor's"
            : "resumed existing translation task",
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
    const current = await factory.getProject(projectId);
    if (current === undefined) throw new Error("project vanished");
    const translated =
      current.state === "idea"
        ? await waitForProjectState(
            factory,
            projectId,
            "blueprint",
            TRANSLATION_TIMEOUT_MS,
          )
        : current;
    const versionRow = await pool.query<{ document: unknown }>(
      "SELECT document FROM project_blueprint_versions WHERE id=$1",
      [translated.blueprintVersionId],
    );
    if (versionRow.rowCount !== 1)
      throw new Error("blueprint version not found");
    const blueprint = parseBlueprint(versionRow.rows[0]!.document);

    const provisioner = new NodeWorkspaceProvisioner(workspacesRoot);
    const repoPath = join(workspacesRoot, projectId, "repo");
    if (translated.state === "blueprint") {
      await provisioner.provision(projectId, blueprint);
      await new FactoryLifecycleAdvancer(factory).provisioned(
        projectId,
        translated.workspaceRef,
      );
    }
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

    const phases = generationPhases(blueprint.requirements, depth);
    const taskIds: string[] = [];
    const walkedByPhase: string[] = [];
    const existingTasks = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM operation_task_specs
        WHERE role='factory-generation'
          AND input->'attribution'->>'projectId'=$1
        ORDER BY created_at ASC`,
      [projectId],
    );
    for (const [index, requirements] of phases.entries()) {
      const phaseLabel = `phase-${index + 1}-of-${phases.length}`;
      const existingTask = existingTasks.rows[index];
      const task =
        existingTask === undefined
          ? await createGenerationTask(pool, project, blueprint, repoPath, {
              phaseLabel,
              requirements,
            })
          : { taskId: existingTask.task_id };
      taskIds.push(task.taskId);
      const outcome = await waitForTask(
        pool,
        task.taskId,
        generationTimeoutMs(depth, phases.length),
      );
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
      walkedByPhase.push(
        `${phaseLabel}: ${walked === "" ? "none recorded" : walked}`,
      );

      if (outcome !== "succeeded")
        throw new Error(
          `${phaseLabel} ended ${outcome}${walked === "" ? "" : `; tiers: ${walked}`}`,
        );
    }

    const generated = await factory.getProject(projectId);
    record({
      name: "generation",
      state: "passed",
      facts: {
        taskId: taskIds.join(", "),
        tiers: walkedByPhase.join(" | "),
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

function generationPhases(
  requirements: ReadonlyArray<string>,
  depth:
    | "simple"
    | "deep"
    | "landing"
    | "complex"
    | "extreme"
    | "ui-extreme"
    | "ui-deep-extreme",
): ReadonlyArray<ReadonlyArray<string>> {
  if (requirements.length === 0)
    return [["Keep the generated scaffold green."]];
  if (depth === "ui-extreme" || depth === "ui-deep-extreme")
    return [
      requirements.filter(
        (requirement) => requirement !== "single-phase-ui-review",
      ),
    ];
  return requirements.map((requirement) => [requirement]);
}

const STANDARD_GENERATION_TIMEOUT_MS = 900_000;
const EXTREME_GENERATION_TIMEOUT_MS = 3_600_000;

function generationTimeoutMs(
  depth:
    | "simple"
    | "deep"
    | "landing"
    | "complex"
    | "extreme"
    | "ui-extreme"
    | "ui-deep-extreme",
  phaseCount: number,
): number {
  if (
    depth === "extreme" ||
    depth === "ui-extreme" ||
    depth === "ui-deep-extreme"
  )
    return Math.max(EXTREME_GENERATION_TIMEOUT_MS, phaseCount * 600_000);
  return STANDARD_GENERATION_TIMEOUT_MS;
}

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

// Goal 1 of the factory is "generates anything from a landing page to a
// complex system" -- every drill before this one asked for a library, never
// the product the goal names first. Still small enough to verify quickly:
// one pure function producing a string, the same shape as SIMPLE_BRIEF, so a
// failure here is about the brief's content, not its size.
// Raised from a five-line brief to this on 2026-08-12, after the first
// version's output was judged real but "very basic" -- a fair verdict: five
// requirement lines cannot specify a type scale, an information
// architecture, or a spacing rhythm, and a model given no such direction has
// no way to produce them. This version gives the same kind of concrete
// direction a senior product designer's brief would, so a plain-looking
// result becomes evidence about the brief, not an unmovable ceiling on the
// model.
const LANDING_BRIEF = [
  "Build a Node/TypeScript module called `landing-page` that renders a",
  "complete, premium marketing landing page for a fictional product called",
  "Polyp AI Factory -- an AI software factory that turns a conversation into a",
  "working, deployed product. Write it as a senior product designer at a",
  "top-tier software studio would: real information architecture, a",
  "considered type scale, a deliberate spacing rhythm, and copy that reads",
  "like a real company wrote it, not placeholder text.",
  "",
  "Requirements:",
  "- Export a function `renderLandingPage(): string` returning one complete,",
  "  valid HTML5 document as a string (starting with `<!doctype html>`).",
  "- All styling lives in ONE embedded `<style>` block in the `<head>`. Use",
  "  CSS custom properties for a small, deliberate design-token system (a",
  "  base background, a surface color, a primary text color, a muted text",
  "  color, and exactly one accent color), and build every component from",
  "  those tokens. No external stylesheets, fonts, scripts, or images -- the",
  "  page must render correctly and look complete with zero network access.",
  "- Top to bottom, the page has: a sticky top nav bar with a wordmark and",
  "  2-3 nav links; a hero with an eyebrow label, a headline, a one-sentence",
  "  subhead, and two calls-to-action (a primary button and a secondary text",
  "  link); a three-item feature grid, each with a short label and a",
  "  one-sentence description (no external icons -- a CSS shape, an emoji, or",
  "  a single letter mark, your choice); a single-quote testimonial block",
  "  attributed to a named, titled person at a named company; a closing",
  "  call-to-action banner distinct from the hero; and a footer with a",
  "  copyright line and 2-3 links.",
  "- Use a real type scale (at least three distinct font-size steps beyond",
  "  body text) and consistent spacing on multiples of one base unit.",
  "- Every interactive element has a visible `:hover` and `:focus-visible`",
  "  state defined in the stylesheet.",
  "- The layout is responsive down to a 375px-wide viewport using CSS",
  "  grid/flexbox and relative units -- no fixed pixel widths on outer",
  "  containers.",
  "- Cover this with tests using node:test: assert the returned string",
  "  contains a `<style>` tag, an `<h1>`, a testimonial-attribution string,",
  '  the words "Get started" somewhere, a `:hover` rule, and starts with',
  "  `<!doctype html>`.",
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

// Harder again, and harder along a different axis than DEEP_BRIEF: not one
// module with several rules, but several modules that must agree with each
// other. A ledger's whole point is that its parts are correlated -- an
// account only means something in terms of the entries posted to it, and an
// entry only means something if the accounts it touches are real -- so a
// model has to get the *seams* right, not just each file in isolation.
const COMPLEX_BRIEF = [
  "Build a small Node/TypeScript double-entry accounting system called",
  "`ledger`, split across three correlated modules that must agree with each",
  "other on shared types.",
  "",
  "`src/accounts.ts`:",
  "- A `AccountType` union: 'asset' | 'liability' | 'equity' | 'revenue' |",
  "  'expense'.",
  "- Export `createAccount(name: string, type: AccountType): Account`, where",
  "  `Account` carries at least `id`, `name`, and `type`. Reject an empty",
  "  name by throwing.",
  "",
  "`src/ledger.ts`, importing `Account` from `./accounts.js`:",
  "- Export `postEntry(ledger: Ledger, entry: JournalEntry): Ledger`, where a",
  "  `JournalEntry` is a date plus a list of postings, each posting a",
  "  `{ account: Account; debit: number; credit: number }` in integer minor",
  "  units. `Ledger` holds every posted entry and a running balance per",
  "  account id.",
  "- An entry is only postable if its postings sum to the same total on the",
  "  debit side as the credit side across the whole entry -- reject an",
  "  unbalanced entry by throwing, and leave the ledger it was rejected from",
  "  completely unchanged (no partial posting).",
  "- A posting with a negative debit or credit, or with both non-zero on the",
  "  same posting, is invalid and must throw.",
  "- `postEntry` must not mutate the `Ledger` it was given -- return a new",
  "  one, the way the rest of this system's generated code already does.",
  "",
  "`src/reports.ts`, importing from both of the above:",
  "- Export `trialBalance(ledger: Ledger, accounts: Account[]): { account: Account; balance: number }[]`,",
  "  one row per account with its signed running balance (debits positive,",
  "  credits negative, for asset/expense; the reverse for",
  "  liability/equity/revenue).",
  "- Export `isBalanced(ledger: Ledger): boolean`, true exactly when the sum",
  "  of every posted entry's debits equals the sum of every posted entry's",
  "  credits across the whole ledger -- this must hold after every valid",
  "  `postEntry` call, by construction, and the tests must prove it rather",
  "  than assume it.",
  "",
  "Cover every rule and every error case above with tests using node:test,",
  "across all three modules, including at least one test that posts several",
  "entries touching the same account and asserts the running balance and the",
  "trial balance agree with hand-computed totals.",
  "",
  "Stack: node runtime, no framework, no database. No dependencies.",
].join("\n");

const EXTREME_BRIEF = [
  "Build a Node/TypeScript in-memory billing and inventory engine called",
  "`stockflow`, split across correlated modules with shared exported types.",
  "",
  "`src/catalog.ts`:",
  "- Export `Product`, `Sku`, and `Money` types.",
  "- Export `createProduct(input)` that validates a nonempty SKU, nonempty",
  "  name, positive integer price minor units, and uppercase 3-letter",
  "  currency.",
  "- Export `changePrice(product, nextPrice)` without mutating the original",
  "  product.",
  "",
  "`src/inventory.ts`:",
  "- Export `InventoryState`, `receiveStock(state, sku, quantity)`,",
  "  `reserveStock(state, sku, quantity)`, and `releaseReservation(state, sku, quantity)`.",
  "- Quantities must be positive integers.",
  "- Available stock can never go below zero; reservation attempts that would",
  "  over-reserve must throw and leave the original state unchanged.",
  "- Every function must return a new state object.",
  "",
  "`src/orders.ts`:",
  "- Export `OrderLine`, `Order`, `createOrder(id, lines)`, and",
  "  `calculateOrderTotal(order, catalog)`.",
  "- Reject an empty order id, duplicate SKUs in one order, empty lines,",
  "  unknown SKUs, and non-positive integer quantities.",
  "- The total must be a `Money` object and all order lines must share one",
  "  currency; mixed currencies must throw.",
  "",
  "`src/invoices.ts`:",
  "- Export `Invoice`, `createInvoice(order, catalog, issuedAt)`,",
  "  `markPaid(invoice, paidAt)`, and `isOverdue(invoice, today, termsDays)`.",
  "- `createInvoice` must snapshot the order total and start unpaid.",
  "- `markPaid` returns a new invoice and is idempotent if already paid.",
  "- `isOverdue` is false for paid invoices and true only after the due date.",
  "",
  "`src/reports.ts`:",
  "- Export `inventoryReport(state)` sorted by SKU.",
  "- Export `revenueReport(invoices)` returning paid, unpaid, and overdue",
  "  totals in integer minor units.",
  "- Export `topProductsByQuantity(orders, limit)` sorted by quantity desc",
  "  then SKU asc.",
  "",
  "Cover every module and every error case with node:test. Include tests that",
  "prove failed operations do not mutate their input, totals are computed from",
  "catalog prices rather than line-provided prices, mixed currencies fail, and",
  "reports sort deterministically.",
  "",
  "Stack: node runtime, no framework, no database. No dependencies.",
].join("\n");

const UI_EXTREME_BRIEF = [
  "Build a Node/TypeScript module called `polyp-factory-console-ui` that",
  "renders a reviewable operator console for Polyp AI Factory. This is a",
  "visual-quality drill, not a scaffold drill: the output must look like a",
  "designed product screen, not AI-generated dashboard filler.",
  "",
  "single-phase-ui-review",
  "",
  "Product context:",
  "- Audience: owner/operators supervising an AI DevOps factory at night,",
  "  reading quickly under pressure.",
  "- Workflow: an approved conversation becomes a blueprint, then phased code",
  "  generation, verification, publication, deployment, and Telegram reporting.",
  "- Register: product console. Design serves operational scanning; no",
  "  marketing hero, no feature brochure, no tutorial copy.",
  "",
  "Style reference:",
  "- Use the Auros Refero style reference as the concrete visual target:",
  "  https://styles.refero.design/style/21cfe0c1-778d-4613-9f47-a5718eb929b3",
  "- Also account for the second owner-provided Refero reference:",
  "  https://styles.refero.design/style/e5f5f8cf-e68d-4ed1-bbf5-6b67569af648",
  "- Apply Impeccable anti-slop discipline: clear product context, strong",
  "  hierarchy, restrained color, no generic SaaS gradients, no nested cards,",
  "  no icon tiles above headings, no lorem ipsum, no decorative blobs, no",
  "  mushy 'AI productivity' copy.",
  "",
  "Auros-derived visual system:",
  "- Canvas: near-black teal, using a strict surface stack of `#011d1c`,",
  "  `#012624`, and `#003734`. Do not introduce blue/slate/gray surfaces.",
  "- Text: cool off-white `#edfffe` and white for headings; muted silver",
  "  `#bbc7c6` for secondary copy. Use `#fde9ff` only for large statistics or",
  "  exceptional emphasis.",
  "- Accent: a bioluminescent teal-to-mist-to-lavender gradient, reserved for",
  "  one primary action, thin progress accents, and small instrument marks.",
  "- Typography: one geometric sans family stack such as `Inter`, `DM Sans`,",
  "  `Satoshi`, `system-ui`; headings at weight 500, body at 400. Use uppercase",
  "  tracked labels for instrumentation. Do not use bold-heavy SaaS headings.",
  "- Shape: 16px radius for major surface panels, 6px for controls and small",
  "  instrument chips. No drop shadows; hierarchy comes from surface color and",
  "  layout density.",
  "- Visual asset: create a CSS-only bioluminescent data-orb / particle-field",
  "  centerpiece inside the console. It must feel like live factory telemetry,",
  "  not a random background decoration.",
  "- Domain guard: Polyp is an AI DevOps/software factory. Do not use biology,",
  "  cultivation, laboratory, nutrient, biomass, airlock, or growth-protocol",
  "  metaphors. `bioluminescent` describes the visual treatment only.",
  "",
  "Requirements:",
  "- Export exactly `renderPolypFactoryConsole(): string` from the generated",
  "  TypeScript source. It returns one complete, valid HTML5 document as a",
  "  string and starts with `<!doctype html>`.",
  "- Use one embedded `<style>` block in the `<head>`. Do not use external",
  "  scripts, fonts, stylesheets, images, SVG files, or runtime dependencies.",
  "- The first viewport is the actual operator console, not a marketing hero:",
  "  collapsed left rail, compact top status bar, active project command strip,",
  "  model routing, budget state, current run state, and deployment state all",
  "  visible without burying the main workflow.",
  "- Include a generation phase timeline with at least 9 phases. Each phase",
  "  row or tile shows phase id, status, selected model, attempt count, changed",
  "  lines, and a short repair/failure note. Include the real diagnostic case",
  "  `phase-4-of-9`: DeepSeek V4 Flash rejected twice, then DeepSeek V4 Pro",
  "  accepted.",
  "- Include separate approvals, evidence, artifact preview, telemetry, and",
  "  Telegram signal panels. These panels must use realistic labels from the",
  "  drill system: blueprint translation, generation phase, verifier,",
  "  publication, commit, changed lines, route policy, fallback chain, and",
  "  notification suppression.",
  "- Include a mini design-system strip in the UI: swatches, type labels,",
  "  surface levels, and route-state chips. It should prove the screen is",
  "  governed by tokens rather than improvised decoration.",
  "- Design for dense operational scanning with cinematic craft: restrained",
  "  color, clear hierarchy, strong alignment, calibrated spacing, instrument",
  "  labels, and enough custom visual detail that it cannot be mistaken for a",
  "  default AI dashboard.",
  "- Make it responsive down to 375px using CSS grid/flexbox and relative",
  "  units. The layout must not rely on fixed outer widths, and text must not",
  "  overlap controls or panels.",
  "- Accessibility must be explicit: semantic landmarks, labelled regions,",
  "  good contrast, visible `:focus-visible` states, and keyboard-reachable",
  "  controls represented as links or buttons in the HTML.",
  "- Cover this with node:test tests. Assert the returned string starts with",
  "  `<!doctype html>`, contains exactly one `<style` block, contains",
  "  `DeepSeek`, `phase-4-of-9`, `focus-visible`, `approval`, `verifier`,",
  "  `bioluminescent`, `#012624`, `#fde9ff`, and semantic landmarks such as",
  "  `<main` and `<nav`.",
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
  const depth =
    process.argv[3] === "deep"
      ? "deep"
      : process.argv[3] === "landing"
        ? "landing"
        : process.argv[3] === "complex"
          ? "complex"
          : process.argv[3] === "extreme"
            ? "extreme"
            : process.argv[3] === "ui-extreme"
              ? "ui-extreme"
              : process.argv[3] === "ui-deep-extreme"
                ? "ui-deep-extreme"
                : "simple";
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
