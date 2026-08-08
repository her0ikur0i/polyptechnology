export interface VerificationCommand {
  image: string;
  command: string;
  args: ReadonlyArray<string>;
}

// Single default policy for every generated project until a real per-stack
// registry exists (owner decision, 2026-08-09): every project on this stack
// is TypeScript/Node today, so one pinned Node image running the check chain
// below covers it. The isolated workspace copy being verified already
// carries node_modules from the source checkout, so this deliberately does
// not run `npm ci` -- verification stays network-free (WorkerJob defaults to
// --network=none) rather than needing the "network" capability just to
// reinstall dependencies that are already present.
const DEFAULT_NODE_IMAGE =
  "node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436"; // node:22-bookworm-slim, pulled and pinned 2026-08-09

// typecheck -> format:check -> test, in that order (cheapest/fastest failure
// first). This is the mechanism that keeps executor-generated code clean:
// formatting is a deterministic verification gate, not something left to
// whichever provider happened to produce the patch. The sandbox is
// --read-only (src/worker/planner.ts), so this can only *check* formatting,
// never auto-fix it in place -- a patch that isn't already formatted is
// rejected and escalates to the next fallback tier, same as a failing test.
// Every generated project must carry `typecheck` and `format:check` npm
// scripts -- this repo's own package.json is the template ("typecheck":
// "tsc --noEmit", "format:check": "prettier --check .").
const DEFAULT_VERIFY_SCRIPT =
  "npm run typecheck && npm run format:check && npm test";

export function verificationCommandFor(
  _taskClass: string,
): VerificationCommand {
  return {
    image: DEFAULT_NODE_IMAGE,
    command: "sh",
    args: ["-c", DEFAULT_VERIFY_SCRIPT],
  };
}
