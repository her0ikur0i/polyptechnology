import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import { modelRoutes, MODEL_POLICY_VERSION } from "../gateway/model-policy.js";
import { verificationCommandFor } from "../operations/verification-image-policy.js";
import type { BlueprintDocument, GeneratedProject } from "./types.js";

export interface GenerationTaskResult {
  taskId: string;
  contractId: string;
  milestoneId: string;
}

// The producer M2's AiPatchExecutorDriver always needed and never had:
// creates a real tasks/operation_task_specs row (driver='ai_patch_executor')
// from a real blueprint, so ExecutableTaskSupervisor can actually lease and
// run it. factory_contracts/milestones here are a fresh, project-scoped
// unit of work -- not this repo's own CONTRACT-NNN numbering (that pattern
// was already established by the CONTRACT-010 synthetic-project acceptance
// test: factory_contracts.id is a generic UUID work-tracking key, reusable
// per generated project, not exclusive to this control plane's own
// contracts).
// What the executor is told about how to answer.
//
// The rules about paths and hunk headers are not style advice. The first six
// real attempts against DeepSeek all failed at `git apply`: one guessed the
// contents of package.json and tsconfig.json, one invented a `test/` directory
// when the repository has `tests/`, and four produced diffs git called
// "corrupt". None of that is the model being incapable -- it was being asked to
// patch files it had never seen.
const GENERATION_SYSTEM_PROMPT = [
  "You implement the initial code for a new project.",
  "",
  "Answer with a single unified diff and nothing else. No prose before or",
  "after it, no markdown fences.",
  "",
  "The diff must apply with `git apply` against the exact file contents given",
  "to you. That means:",
  "- Use paths exactly as listed. Do not invent directories.",
  "- Prefer creating new files over editing existing ones. A new file is a",
  "  hunk from /dev/null and cannot conflict.",
  "- When you must edit an existing file, reproduce its surrounding lines",
  "  exactly as given, and make the hunk header line counts correct.",
  "- Every path must stay inside this repository.",
  "",
  "The project is verified by `npm run typecheck && npm run format:check &&",
  "npm test` in a sandbox with no network. So: the code must typecheck under",
  "strict TypeScript, be formatted the way Prettier's defaults format it, and",
  "be covered by tests that genuinely exercise the requirements. Do not add",
  "dependencies -- nothing can be installed.",
].join("\n");

// Files whose contents the executor is shown. Small, textual, and the only
// ones a scaffold patch has any business touching -- node_modules, .git and
// lockfiles are excluded by construction rather than by size.
const CONTEXT_FILES = [
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
  "src/index.ts",
  "tests/scaffold.test.ts",
] as const;

const CONTEXT_BYTE_LIMIT = 8_000;

// Reads the scaffold so the diff can be written against what is actually
// there. Missing files are listed as missing rather than skipped silently: a
// model that is told a file does not exist will create it, whereas one told
// nothing will guess.
async function describeRepository(repoPath: string): Promise<string> {
  const sections: string[] = [];
  let budget = CONTEXT_BYTE_LIMIT;
  for (const relative of CONTEXT_FILES) {
    let body: string;
    try {
      body = await readFile(join(repoPath, relative), "utf8");
    } catch {
      sections.push(`--- ${relative} (does not exist yet) ---`);
      continue;
    }
    if (body.length > budget) {
      sections.push(`--- ${relative} (too large to include) ---`);
      continue;
    }
    budget -= body.length;
    sections.push(`--- ${relative} ---\n${body}`);
  }
  return sections.join("\n");
}

export async function createGenerationTask(
  pool: Pool,
  project: GeneratedProject,
  blueprint: BlueprintDocument,
  repoPath: string,
): Promise<GenerationTaskResult> {
  const repoListing = await describeRepository(repoPath);
  const work = new PostgresWorkRepository(pool);
  const contractId = randomUUID(),
    milestoneId = randomUUID();
  // Each attempt below reserves ATTEMPT_MAX_COST_USD_MICROS (500_000), and
  // maxAttempts gives the chain up to 6 attempts to walk
  // deepseek(x2) -> codex(x2) -> claude-sonnet-5(x2, the one-retry case from
  // nextStaticTier()). The scope's own cap must fund all 6, not just 4: at
  // the old 2_000_000 ($2.00) cap, the 5th reservation always failed closed
  // with "gateway budget unavailable or exhausted" -- so a run whose first
  // four attempts were legitimately rejected (exactly what the moneybag deep
  // drill produced) could never reach claude-sonnet-5, the tier most likely
  // to succeed, no matter how much of maxAttempts remained. Found in
  // CONTRACT-017D M2. 6 * 500_000 = 3_000_000 is the minimum that removes
  // this ceiling; nothing here claims a run will spend it all.
  const CONTRACT_MAX_COST_USD_MICROS = 3_000_000;
  await pool.query(
    "INSERT INTO factory_contracts(id,baseline_sha,status,max_cost_usd_micros) VALUES($1,$2,'active',$3)",
    [contractId, "0".repeat(40), CONTRACT_MAX_COST_USD_MICROS],
  );
  await pool.query(
    "INSERT INTO milestones(id,contract_id,ordinal,status) VALUES($1,$2,1,'active')",
    [milestoneId, contractId],
  );
  // AiGateway.execute()'s reservation (src/gateway/postgres-ledger.ts) is
  // scoped to attribution.contractId -- without a budget account row for
  // this freshly-generated contractId, every attempt fails closed with
  // "gateway budget unavailable or exhausted" before any provider is ever
  // called.
  await pool.query(
    "INSERT INTO ai_budget_accounts(scope_id,max_cost_usd_micros) VALUES($1,$2) ON CONFLICT (scope_id) DO NOTHING",
    [contractId, CONTRACT_MAX_COST_USD_MICROS],
  );

  const task = await work.submit({
    contractId,
    milestoneId,
    idempotencyKey: `generate-${project.id}`,
    maxCostUsdMicros: CONTRACT_MAX_COST_USD_MICROS,
    maxAttempts: 6, // enough to walk deepseek(x2) -> codex(x2) -> claude
  });
  await work.controlTransition(task.id, "draft", "queued");

  // The verification workspace lives beside the repository, NOT in /tmp.
  //
  // This is the single most consequential defect this contract found. The
  // supervisor unit sets `PrivateTmp=yes`, so its `/tmp` is a private mount
  // namespace. The workspace was created under `tmpdir()` and the patched
  // repository was copied into it correctly -- inside that namespace. Docker
  // then bind-mounts by **host** path, where that directory does not exist, so
  // the daemon silently created an empty one and mounted it at /workspace.
  //
  // Verification therefore ran `npm run typecheck && format:check && test`
  // against an empty directory and failed with:
  //
  //   npm error enoent Could not read package.json:
  //     ENOENT: no such file or directory, open '/workspace/package.json'
  //
  // recorded only as `verification_failed`. **No patch this system has ever
  // produced has been verified.** The gate that release criterion 5 rests on --
  // "deterministic verification rejects an intentionally incorrect result" --
  // could not have rejected anything, because it never saw a file. It passed
  // its own integration tests throughout, because those run in a process with
  // no PrivateTmp and a shared /tmp.
  //
  // Both paths below are under the project's workspace root, which is a real
  // host directory the service, the Control API and the Docker daemon all
  // agree about. `isolationRoot` is the project directory and `workspaceRoot`
  // the verify subdirectory, satisfying planWorker()'s containment check while
  // keeping the two distinct.
  const projectRoot = dirname(repoPath);
  const verifyDir = join(projectRoot, "verify");
  await rm(verifyDir, { recursive: true, force: true });
  await mkdir(verifyDir, { recursive: true });
  const verify = verificationCommandFor("bulk_code");
  const staticRoute = modelRoutes("bulk_code")[0];
  if (staticRoute === undefined) throw new Error("no static bulk_code route");

  const input = {
    taskId: task.id,
    taskClass: "bulk_code" as const,
    idempotencyKey: `generate-${project.id}-${task.attemptCount + 1}`,
    attribution: {
      projectId: project.id,
      contractId,
      milestoneId,
      taskId: task.id,
      taskAttemptOrdinal: 1,
      agentId: "factory-generation",
    },
    messages: [
      {
        role: "system" as const,
        content: GENERATION_SYSTEM_PROMPT,
      },
      {
        role: "user" as const,
        content: [
          `Project: ${blueprint.displayName} (${blueprint.slug})`,
          `Stack: ${blueprint.stack.runtime}/${blueprint.stack.framework}/${blueprint.stack.database}`,
          "",
          "Requirements:",
          ...blueprint.requirements.map((r) => `- ${r}`),
          "",
          "The repository currently contains exactly these files, in full.",
          "Your diff must apply to them as they are written here.",
          "",
          repoListing,
        ].join("\n"),
      },
    ],
    maxOutputTokens: 8_000,
    maxCostUsdMicros: 500_000,
    policyVersion: MODEL_POLICY_VERSION,
    route: staticRoute,
    ownedPaths: "unscoped" as const,
    workspaceRoot: repoPath,
    verifyJob: {
      isolationRoot: projectRoot,
      workspaceRoot: verifyDir,
      image: verify.image,
      command: verify.command,
      args: verify.args,
      // Nothing in the verify chain (typecheck/format:check/test) writes a
      // dedicated report file -- package.json always exists post-verify and
      // is harmless to hash as the nominal collected artifact.
      // collectArtifacts() (src/worker/artifacts.ts) requires every declared
      // path to exist, and planWorker() requires at least one declared path.
      ownedPaths: ["package.json"],
      capabilities: [] as const,
      timeoutMs: 300_000,
      outputByteLimit: 1_000_000,
      memoryMb: 1024,
      cpuLimit: 1,
      environment: { CI: "true" },
    },
    fallbackReason: null,
  };

  await pool.query(
    "INSERT INTO operation_task_specs(task_id,driver,input,expected_output_sha256,role) VALUES($1,'ai_patch_executor',$2,NULL,'factory-generation')",
    [task.id, input],
  );

  return { taskId: task.id, contractId, milestoneId };
}
