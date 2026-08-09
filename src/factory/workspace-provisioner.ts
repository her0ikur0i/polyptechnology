import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintDocument } from "./types.js";

const run = promisify(execFile);

export interface ProvisionedWorkspace {
  repoPath: string;
}

// Resolves a project's logical workspaceRef (workspace://projects/{id}, see
// src/factory/blueprint.ts's isolatedProjectReferences()) to a real,
// git-initialized directory AiPatchExecutorDriver can actually apply diffs
// to. This never existed before CONTRACT-013 -- "generated project" was
// pure database metadata with no real filesystem/git counterpart at all.
// Only a Node/TS scaffold is supported today, matching the single
// verification image policy owner decision
// (src/operations/verification-image-policy.ts): a blueprint requesting a
// different runtime is rejected rather than silently scaffolded wrong.
export class NodeWorkspaceProvisioner {
  constructor(private readonly workspacesRoot: string) {}

  async provision(
    projectId: string,
    blueprint: BlueprintDocument,
  ): Promise<ProvisionedWorkspace> {
    if (blueprint.stack.runtime !== "node")
      throw new Error(
        `unsupported blueprint runtime for workspace provisioning: ${blueprint.stack.runtime}`,
      );
    if (!/^[a-f0-9-]{36}$/.test(projectId))
      throw new Error("unsafe project identity");

    const repoPath = join(this.workspacesRoot, projectId, "repo");
    if (existsSync(join(repoPath, ".git"))) return { repoPath };

    await mkdir(repoPath, { recursive: true });
    await writeFile(
      join(repoPath, "package.json"),
      JSON.stringify(
        {
          name: blueprint.slug,
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {
            typecheck: "tsc --noEmit",
            "format:check": "prettier --check .",
            test: "node --test 'tests/*.test.js'",
          },
          devDependencies: {
            typescript: "^5.9.0",
            prettier: "^3.9.0",
            "@types/node": "^22.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(repoPath, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(repoPath, "README.md"),
      `# ${blueprint.displayName}\n\n${blueprint.requirements.map((r) => `- ${r}`).join("\n")}\n`,
    );
    await mkdir(join(repoPath, "tests"), { recursive: true });
    await writeFile(
      join(repoPath, "tests", "scaffold.test.js"),
      'import test from "node:test";\ntest("scaffold placeholder", () => {});\n',
    );
    await writeFile(join(repoPath, ".gitignore"), "node_modules/\n");

    await run("git", ["init", "-q"], { cwd: repoPath });
    await run("git", ["config", "user.email", "factory@polyp.local"], {
      cwd: repoPath,
    });
    await run("git", ["config", "user.name", "Polyp Factory"], {
      cwd: repoPath,
    });
    // One real, host-side, networked install -- the isolated verification
    // sandbox is network-free by default (src/worker/planner.ts), so
    // node_modules must already exist before any task reaches it. This is
    // the host-side half of the contract
    // src/operations/verification-image-policy.ts documents.
    await run("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: repoPath,
    });
    await run("git", ["add", "-A"], { cwd: repoPath });
    await run("git", ["commit", "-q", "-m", "Initial scaffold"], {
      cwd: repoPath,
    });
    return { repoPath };
  }
}
