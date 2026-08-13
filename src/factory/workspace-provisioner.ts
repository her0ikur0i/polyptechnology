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
            // The old value globbed `tests/*.test.js` in a TypeScript project,
            // so it matched nothing -- and `node --test` exits 0 when it
            // matches nothing, meaning verification would have reported a pass
            // having run zero tests. Node 22 executes .ts directly via type
            // stripping, so tests are written in the same language as the code
            // they cover. Quoted, so Node expands the glob rather than the
            // shell: an unquoted glob that matches nothing is passed through
            // literally and fails confusingly.
            test: "node --test 'tests/**/*.test.ts'",
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
            // Node executes .ts by stripping types, and its ESM resolver wants
            // the real file extension in an import specifier. Without this,
            // `import { slugify } from "../src/index.ts"` -- the only form
            // that actually runs -- is a type error, so `typecheck` and `test`
            // would demand different code from each other.
            allowImportingTsExtensions: true,
          },
          // Explicit, because with neither key TypeScript reported the include
          // set as ["**/*"] and refused the scaffold outright: TS18003, "no
          // inputs were found". Naming the two source directories also keeps
          // node_modules out of the program.
          include: ["src", "tests"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(repoPath, "README.md"),
      `# ${blueprint.displayName}\n\n${blueprint.requirements.map((r) => `- ${r}`).join("\n")}\n`,
    );
    // A scaffold that cannot pass its own gates makes every generated patch
    // look wrong. This one is deliberately minimal and deliberately green:
    // one real TypeScript module and one real test over it, so a later
    // verification failure is the patch's fault and nothing else's.
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(repoPath, "src", "generated"), { recursive: true });
    await writeFile(
      join(repoPath, "src", "index.ts"),
      `export const projectName = ${JSON.stringify(blueprint.displayName)};\n`,
    );
    await mkdir(join(repoPath, "tests"), { recursive: true });
    await mkdir(join(repoPath, "tests", "generated"), { recursive: true });
    await writeFile(
      join(repoPath, "tests", "scaffold.test.ts"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { projectName } from "../src/index.ts";',
        "",
        'test("the scaffold builds, typechecks and runs", () => {',
        '  assert.equal(typeof projectName, "string");',
        "});",
        "",
      ].join("\n"),
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
    //
    // HOME and the npm cache are pinned inside the workspaces root rather than
    // inherited. The Control API runs as `polyp-factory`, whose home is a
    // root-owned directory it cannot write, so an inherited HOME makes npm
    // fail on its own cache -- a failure that reads as a network or registry
    // problem and is neither. Owning the cache location makes provisioning
    // independent of how the service user's home happens to be configured.
    const npmCache = join(this.workspacesRoot, ".npm-cache");
    await mkdir(npmCache, { recursive: true });
    // npm_config_production/--omit=dev must be forced off, explicitly, not
    // merely left unset. `polyp-sequence.service` runs with NODE_ENV=production
    // (deploy/systemd/polyp-sequence.service), and `...process.env` below
    // inherits it straight into this child process; npm reads that as "skip
    // devDependencies" with no warning. Every dependency this scaffold has --
    // typescript, prettier, @types/node -- is a devDependency, since none of
    // them ship in the generated project's own runtime. Under NODE_ENV=production
    // `npm install` installs none of them, silently leaves node_modules holding
    // only an empty `@types` stub, and every subsequent `tsc --noEmit` in the
    // verify sandbox fails with "tsc: not found" -- indistinguishable, in
    // `provider_artifacts.reason`, from a real rejection. Found in
    // CONTRACT-017D M2: a deep-drill run walked every tier to claude-sonnet-4-6
    // and every one of the first four was actually this, not a real verdict.
    // `npm_config_include=dev` overrides npm's production-mode omission
    // regardless of NODE_ENV; deleting NODE_ENV itself would be fragile if npm
    // ever adds another production-mode signal.
    await run("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: repoPath,
      env: {
        ...process.env,
        HOME: this.workspacesRoot,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
        npm_config_include: "dev",
      },
    });
    // Format the scaffold with the project's own prettier, now that it is
    // installed, instead of hand-matching its output above.
    //
    // `format:check` is a real verification gate, so a scaffold that does not
    // satisfy it fails every patch before the patch is even considered. Hand-
    // formatting is the wrong way to guarantee that: `JSON.stringify(…, 2)`
    // expands every array onto its own line and prettier collapses short ones,
    // so tsconfig.json was rejected by the very tool the project ships with.
    // Running the formatter is the only way to be certain the two agree, and
    // it keeps being certain when this scaffold is edited later.
    await run("npx", ["prettier", "--write", "--log-level", "warn", "."], {
      cwd: repoPath,
      env: {
        ...process.env,
        HOME: this.workspacesRoot,
        npm_config_cache: npmCache,
      },
    });

    await run("git", ["add", "-A"], { cwd: repoPath });
    await run("git", ["commit", "-q", "-m", "Initial scaffold"], {
      cwd: repoPath,
    });
    return { repoPath };
  }
}
