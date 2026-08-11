import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { WorkspaceFormatter } from "./ai-patch-driver.js";

const run = promisify(execFile);

// The control plane's own Prettier, resolved from this package rather than
// from the workspace being formatted.
//
// This matters for a reason a security review had to point out. The first
// version of this class ran `npx prettier --write .` inside the patched
// workspace, and that is arbitrary code execution as root:
//
//   * Prettier resolves configuration with cosmiconfig, which `require()`s
//     `.prettierrc.js` / `prettier.config.js`. A generation patch runs with
//     `ownedPaths: "unscoped"`, so a model can create either file, and it
//     would have been executed by the supervisor -- `User=root`, with
//     `ReadWritePaths` covering both `/var/lib/polyp-ai-factory` and this
//     repository's own source -- with the network available.
//   * `npx` resolves `node_modules/.bin/prettier` from the workspace. `git
//     apply` will happily create that path, so the "formatter" itself could
//     have been a shell script the model wrote.
//
// Worse, this runs on the host **before** the workspace is copied into the
// Docker sandbox, so neither `--read-only` nor `--network=none` nor
// `--cap-drop=ALL` stood between a model's patch and root on this machine --
// breaking the invariant the systemd unit states about itself, that untrusted
// AI-authored code only ever executes in the sandbox.
//
// Both holes are closed by never letting the workspace choose what runs:
// the binary comes from here, and `--no-config` stops any project file being
// loaded at all. Formatting is applied to the workspace's *content*; nothing
// in the workspace gets to influence the tool.
const prettierBin = createRequire(import.meta.url).resolve(
  "prettier/bin/prettier.cjs",
);

export class PrettierWorkspaceFormatter implements WorkspaceFormatter {
  // Kept for npm/node cache locations only -- the service user's real home is
  // not writable. It no longer influences which binary runs.
  constructor(private readonly home?: string) {}

  async format(workspaceRoot: string): Promise<void> {
    await run(
      process.execPath,
      [
        prettierBin,
        "--write",
        // Never read .prettierrc*, prettier.config.*, or package.json#prettier
        // from the workspace: those are model-writable and executable.
        "--no-config",
        "--log-level",
        "warn",
        ".",
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          ...(this.home === undefined
            ? {}
            : { HOME: this.home, npm_config_cache: `${this.home}/.npm-cache` }),
        },
        timeout: 120_000,
      },
    );
  }
}
