import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { PostgresWorkRepository } from "../work/postgres-repository.js";
import { modelRoutes, MODEL_POLICY_VERSION } from "../gateway/model-policy.js";
import { verificationCommandFor } from "../operations/verification-image-policy.js";
import type { BlueprintDocument, GeneratedProject } from "./types.js";

const run = promisify(execFile);

export interface GenerationTaskResult {
  taskId: string;
  contractId: string;
  milestoneId: string;
}

export interface GenerationTaskOptions {
  phaseLabel?: string;
  requirements?: ReadonlyArray<string>;
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
  "",
  "For a multi-file TypeScript project, treat the requested public API as one",
  "contract across implementation and tests:",
  "- Use the exact requested module paths, exported names, and object shapes.",
  "  Do not create a parallel singular/plural module or an alternate API.",
  "- Import shared domain types from their owning module instead of redefining",
  "  lookalike interfaces in another file.",
  "- Under strict TypeScript, annotate composite test fixtures with the",
  "  exported type or use `satisfies`; do not let `true`, `false`, or string",
  "  discriminants widen inside untyped arrays and objects.",
  "- Before answering, check every import against an actual export and check",
  "  that the tests call the exact API the implementation provides.",
  "- Replace scaffold placeholders completely. In particular, do not keep or",
  "  re-export `notYetImplemented`, and do not add a second placeholder export",
  "  through another module.",
  "- Treat your own tests as production code: trace every asserted value",
  "  against the implementation before answering. A test suite with any",
  "  failing assertion is a failed implementation even when typecheck passes.",
  "- Implement the smallest complete solution to the stated requirements.",
  "  Do not invent extra APIs, compatibility layers, overloads, persistence,",
  "  or requirements. For this initial generation, keep the patch under 700",
  "  changed lines and write a focused test for each stated rule rather than",
  "  a combinatorial test matrix.",
  "- If this is a repair attempt, fix the verifier errors directly. Do not",
  "  restart from a different architecture, rename the public API, or rewrite",
  "  passing areas unrelated to the reported failure.",
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

function needsUiReferenceContract(
  requirements: ReadonlyArray<string>,
): boolean {
  return requirements.some(
    (requirement) =>
      requirement.includes("renderPolypFactoryConsole") ||
      requirement.includes("bioluminescent") ||
      requirement.includes("Refero"),
  );
}

function uiReferenceContractTest(
  phaseTestImportPath: string,
  phaseLabel: string,
): string {
  return [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `import { renderPolypFactoryConsole } from ${JSON.stringify(
      phaseTestImportPath,
    )};`,
    "",
    `test(${JSON.stringify(`${phaseLabel} renders the Refero/Auros UI contract`)}, () => {`,
    "  const html = renderPolypFactoryConsole();",
    "  assert.match(html, /^<!doctype html>/);",
    "  assert.equal((html.match(/<style\\b/g) ?? []).length, 1);",
    "  assert.match(html, /<nav\\b/);",
    "  assert.match(html, /<main\\b/);",
    "  assert.match(html, /DeepSeek/);",
    "  assert.match(html, /blueprint translation/i);",
    "  assert.match(html, /verifier/i);",
    "  assert.match(html, /publication/i);",
    "  assert.match(html, /deployment/i);",
    "  assert.match(html, /Telegram/i);",
    "  assert.match(html, /budget/i);",
    "  assert.match(html, /route policy|fallback chain|model routing/i);",
    "  assert.match(html, /phase-4-of-9/);",
    "  assert.match(html, /phase-9-of-9/);",
    "  assert.match(html, /bioluminescent/i);",
    "  assert.match(html, /data-orb|particle-field|telemetry orb/i);",
    "  assert.match(html, /attempt/i);",
    "  assert.match(html, /changed lines/i);",
    "  assert.match(html, /repair|failure/i);",
    "  assert.match(html, /#011d1c/i);",
    "  assert.match(html, /#012624/i);",
    "  assert.match(html, /#003734/i);",
    "  assert.match(html, /#fde9ff/i);",
    "  assert.match(html, /#edfffe/i);",
    "  assert.doesNotMatch(html, /#0b1020|#5ab8ff/i);",
    "  assert.doesNotMatch(html, /culture tank|biomass|nutrient|sterile|airlock|growth protocol/i);",
    "  assert.doesNotMatch(html, /<script\\b|<link\\b[^>]*href=|@import|url\\(http/i);",
    "  assert.ok(html.length > 15000, 'UI is too small to satisfy the dense operator-console contract');",
    "});",
    "",
  ].join("\n");
}

async function installUiReferenceContract(
  repoPath: string,
  phaseLabel: string,
  phaseTestImportPath: string,
): Promise<string | null> {
  const contractTest = uiReferenceContractTest(phaseTestImportPath, phaseLabel);
  const contractPath = join(
    repoPath,
    "tests",
    "generated",
    `${phaseLabel}-reference-contract.test.ts`,
  );
  try {
    const existing = await readFile(contractPath, "utf8");
    if (existing === contractTest) return contractTest;
  } catch {
    // Missing is expected on the first generation task for this phase.
  }

  await mkdir(dirname(contractPath), { recursive: true });
  await writeFile(contractPath, contractTest);
  await run(
    "npx",
    ["prettier", "--write", "--log-level", "warn", contractPath],
    {
      cwd: repoPath,
    },
  );
  await run("git", ["add", "tests/generated"], { cwd: repoPath });
  const diff = await run("git", ["diff", "--cached", "--quiet"], {
    cwd: repoPath,
  }).catch((error: unknown) => error as { code?: number });
  if ("code" in diff && diff.code === 1)
    await run("git", ["commit", "-q", "-m", `Add ${phaseLabel} UI contract`], {
      cwd: repoPath,
    });
  return contractTest;
}

export async function createGenerationTask(
  pool: Pool,
  project: GeneratedProject,
  blueprint: BlueprintDocument,
  repoPath: string,
  options: GenerationTaskOptions = {},
): Promise<GenerationTaskResult> {
  const work = new PostgresWorkRepository(pool);
  const contractId = randomUUID(),
    milestoneId = randomUUID();
  // Each attempt below reserves ATTEMPT_MAX_COST_USD_MICROS (500_000), and
  // maxAttempts gives every one of the five concrete tiers room for its one
  // bounded transport retry: 5 tiers x 2 attempts = 10. Six was enough only
  // when at most one transport failure occurred anywhere in the chain; the
  // first heavy wild drill produced two honest empty DeepSeek Pro responses
  // and exhausted the task immediately after its first Claude attempt. The
  // scope's own cap funds all 10 reservations. At
  // the old 2_000_000 ($2.00) cap, the 5th reservation always failed closed
  // with "gateway budget unavailable or exhausted" -- so a run whose first
  // four attempts were legitimately rejected (exactly what the moneybag deep
  // drill produced) could never reach claude-sonnet-4-6, the tier most likely
  // to succeed, no matter how much of maxAttempts remained. Found in
  // CONTRACT-017D M2; 3_000_000 was the minimum that removed the ceiling.
  //
  // Raised to 5_000_000 on 2026-08-12, owner-directed headroom for a bigger
  // future project -- a brief wide enough to need more real files per attempt
  // (still $0.50/attempt, unchanged) or a run that legitimately needs every
  // all of maxAttempts's 10 slots. Still just a
  // ceiling: nothing here claims a run will spend it all, and 017D's actual
  // drills spent under $0.03 total.
  const CONTRACT_MAX_COST_USD_MICROS = 5_000_000;
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

  const phaseLabel = options.phaseLabel ?? "complete";
  const phaseSlug = phaseLabel.replaceAll(/[^a-z0-9-]/g, "-");
  const phaseSourcePath = `src/generated/${phaseSlug}.ts`;
  const phaseTestPath = `tests/generated/${phaseSlug}.test.ts`;
  const phaseTestImportPath = `../../src/generated/${phaseSlug}.ts`;
  const phaseRequirements = options.requirements ?? blueprint.requirements;
  const immutableContract = needsUiReferenceContract(phaseRequirements)
    ? await installUiReferenceContract(
        repoPath,
        phaseLabel,
        phaseTestImportPath,
      )
    : null;
  const repoListing = await describeRepository(repoPath);
  const task = await work.submit({
    contractId,
    milestoneId,
    idempotencyKey: `generate-${project.id}-${phaseLabel}`,
    maxCostUsdMicros: CONTRACT_MAX_COST_USD_MICROS,
    maxAttempts: 10, // five concrete tiers, one bounded transport retry each
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
    phaseLabel,
    idempotencyKey: `generate-${project.id}-${phaseLabel}-${task.attemptCount + 1}`,
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
          `Generation phase: ${phaseLabel}`,
          "",
          "Implement only the requirements listed in this phase. Preserve all",
          "existing exported APIs and tests from earlier accepted phases.",
          "Prefer a small patch; do not rewrite passing code.",
          "",
          "For this phase, create or update only these paths:",
          `- ${phaseSourcePath}`,
          `- ${phaseTestPath}`,
          "",
          "Do not edit src/index.ts or tests/scaffold.test.ts. Put this",
          "phase's exported API in the phase source file and import it from",
          "the phase test file.",
          `The test file must import the phase source with exactly ${JSON.stringify(
            phaseTestImportPath,
          )}.`,
          "",
          "Phase requirements:",
          ...phaseRequirements.map((r) => `- ${r}`),
          ...(immutableContract === null
            ? []
            : [
                "",
                "Immutable verifier contract:",
                "The repository already contains a generated contract test",
                "outside your owned paths. It will be run by npm test and you",
                "must satisfy it, but you must not edit it.",
                "```ts",
                immutableContract,
                "```",
              ]),
          "",
          "The repository currently contains exactly these files, in full.",
          "Your diff must apply to them as they are written here.",
          "",
          repoListing,
        ].join("\n"),
      },
    ],
    // Thinking models consume this same completion allowance for reasoning.
    // At 8k, DeepSeek Pro exhausted the envelope twice on the correlated
    // ledger brief and returned no content at all. DeepSeek V4's documented
    // output ceiling is 384k, but reserving 128k caused the provider itself to
    // terminate complex Pro calls around seven minutes even with live SSE
    // traffic. 32k remains four times the original failing allowance and is
    // ample for reasoning plus a multi-file diff, while allowing the provider
    // to finish inside its execution window. Verification remains unchanged.
    maxOutputTokens: 32_000,
    maxCostUsdMicros: 500_000,
    policyVersion: MODEL_POLICY_VERSION,
    route: staticRoute,
    ownedPaths: [phaseSourcePath, phaseTestPath],
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
