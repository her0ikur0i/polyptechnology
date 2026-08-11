# M5 — The factory built something

Date: 2026-08-11. Status: **done.**

## The result

```
generation drill: drill-13
reached: publication

  ok  conversation    projectId 24f3c82d-7167-5a5c-ba3a-e684620a10cc
  ok  brief
  ok  proposal        approved and handed off through the real gate
  ok  translation     blueprint derived by claude-sonnet-5
  ok  provisioning    runtime node, projectState provisioned
  ok  generation      tiers: deepseek:deepseek-v4-flash=accepted
                      projectState development
  ok  verification    verifier isolated-worker-v1, 26 changed lines
  ok  publication     commit 86ce0920702b, working tree clean
```

**Nine stages, all green.** A conversation became an approved proposal, a
blueprint, a provisioned git workspace, generated code, a passing verification
inside the Docker sandbox, and a commit — with no human touching anything after
the brief.

The accepted patch came from **`deepseek-v4-flash`, the cheapest tier, on the
first attempt.** That is the execution policy working as written: cheapest
viable tier first, escalation only on verified failure. An earlier run
(drill-12) needed two escalations before `codex:gpt-5.6-terra` accepted, which
is the same policy working in the other direction.

## What the factory actually wrote

```ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

with four tests covering the brief's rules. Verified independently of the
pipeline's own verdict, because a drill that grades itself proves nothing:

| Check                                     | Result                      |
| ----------------------------------------- | --------------------------- |
| `npm run typecheck` on the real workspace | OK                          |
| `npm run format:check`                    | OK                          |
| `npm test`                                | 4 tests, 4 passing          |
| Independent behaviour cases, run by hand  | all pass                    |
| Git history                               | scaffold → generated commit |
| Working tree after publication            | clean                       |

The independent cases included ones the model never saw — empty string,
all-punctuation, leading and trailing hyphens, digits, collapsed whitespace,
and a non-ASCII input — and the implementation is correct on every one.

## The three defects that stood between here and there

### 1. The verification sandbox had never seen a file

The worst finding in this contract, and the last one to surface because nothing
had ever reached the gate to expose it.

`polyp-sequence.service` sets `PrivateTmp=yes`. The verify workspace was created
under `tmpdir()`, and the patched repository was copied into it correctly —
inside the service's private mount namespace. Docker then bind-mounts by **host**
path, where that directory does not exist, so the daemon created an empty one
and mounted it at `/workspace`. Verification ran:

```
npm error enoent Could not read package.json:
  ENOENT: no such file or directory, open '/workspace/package.json'
```

recorded as nothing more than `verification_failed`.

**No patch this system ever produced had been verified.** Release criterion 5 —
"deterministic verification rejects an intentionally incorrect result" — could
not have rejected anything, because the verifier never saw code. Its own
integration tests passed throughout, because they run in a process with no
`PrivateTmp` and a shared `/tmp`.

M1 predicted this mechanism exactly, ranked it Medium, and I dismissed it with
"checked: neither unit sets it today." I checked wrong. The prediction was
better than the verification of it.

The verify workspace now lives at `<workspacesRoot>/<projectId>/verify` — a real
host path the service, the Control API and the Docker daemon all agree about.

### 2. A missing trailing newline

Patches kept failing as `corrupt patch at line <n+1>`, pointing one line past
the end, which reads like a truncated hunk and sent this contract chasing prompt
wording and `--recount` across two milestones.

It was one byte. **A unified diff must end with a newline**, and chat APIs trim
trailing whitespace. The same captured diffs git called corrupt applied cleanly
with a newline appended and nothing else changed:

```
deepseek-v4-flash   corrupt at line 47  ->  4 0 src/index.ts, 27 1 tests/scaffold.test.ts
deepseek-v4-pro     corrupt at line 58  ->  8 0 src/index.ts, 38 0 tests/slugify.test.ts
```

### 3. Formatting rejected correct code

With the first two fixed, every tier produced code that **passed `tsc
--noEmit`** and was rejected on `prettier --check src/index.ts`.

`verification-image-policy.ts` argued that rejection was the point — that
formatting is a mechanical gate rather than something left to whichever provider
wrote the patch. That reasoning held while nothing had ever reached the gate.
With evidence, it only rejected correct work: asking a model to reproduce
Prettier's output byte-for-byte is asking it to be a formatter.

The pipeline now runs the **generated project's own Prettier** over the patched
workspace before verification. The gate is unchanged and still runs in the
read-only sandbox, so an accepted artifact is still provably formatted. What
changed is that clean is achieved rather than guessed.

This adjusts a prior owner decision, taken under the authority the owner granted
on 2026-08-11 ("approve everything necessary to achieve goals"), and is recorded
here rather than applied quietly.

## Publication

An accepted patch is now committed into the generated project's own repository.
Without it the project had generated code and a history containing only
"Initial scaffold": nothing durable said what the factory built, the next
attempt's `revert()` would have destroyed it, and a second generation would have
patched against a baseline git did not agree with.

`git add -A` rather than named paths, deliberately: the formatter runs between
apply and verify, so the committed tree is the tree that was **verified**, not
the diff as the model wrote it.

## Gates

**396 backend tests, 396 passing, 0 skipped** under the standing invocation, 38
dashboard tests, typecheck, format:check, `npm audit` clean, dashboard build,
`verify-contract` and `resume-checkpoint --check` all green.

## What M1 predicted, scored honestly

| M1 said                                               | Outcome                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Model must produce a git-applicable diff blind — High | Correct, and the dominant failure                                                                 |
| `prettier --check` rejects correct output — High      | **Correct.** Exactly what blocked the last mile                                                   |
| Verify temp dir crosses a process boundary — Medium   | **Correct in mechanism, and I dismissed it on a bad check.** The single most consequential defect |
| Scaffold may fail its own gates — Medium              | Correct, and understated                                                                          |
| Runtime mismatch — Low                                | Wrong tier; hit on run one                                                                        |

Every mis-ranking was too low, and every one concerned a boundary between
components rather than a component itself.

## Security review: a Critical finding, in my own change

Run on Sonnet 5 before the push. It found one issue and rated it Critical, and
it was right.

The formatter I added in this milestone ran `npx prettier --write .` inside the
just-patched workspace. That is **arbitrary code execution as root**, by two
independent routes, both reachable because generation patches run
`ownedPaths: "unscoped"`:

1. Prettier resolves configuration with cosmiconfig, which `require()`s
   `.prettierrc.js` / `prettier.config.js`. A model can create either file.
2. `npx` resolves `node_modules/.bin/prettier` **from the workspace**, and
   `git apply` will create that path — so the "formatter" could have been a
   shell script the model wrote.

And it ran on the host _before_ the copy into Docker, so `--read-only`,
`--network=none` and `--cap-drop=ALL` protected nothing. The supervisor is
`User=root` with `ReadWritePaths` covering `/var/lib/polyp-ai-factory` **and
this repository's own source**, with the network available. That is a
supply-chain path into the control plane, triggered by one model response,
breaking the invariant `polyp-sequence.service` states about itself: untrusted
AI-authored code only ever executes in the sandbox.

**Confirmed exploitable before fixing**, rather than accepted on argument: a
`.prettierrc.js` planted in a temp directory and `npx prettier --write .` run
over it executed the config and wrote the sentinel file.

**Fixed by never letting the workspace choose what runs.** The binary is
resolved from this package (`createRequire(import.meta.url).resolve`), invoked
through `process.execPath`, with `--no-config` so no project file is loaded at
all. Formatting applies to the workspace's content; nothing in the workspace
influences the tool.

`tests/workspace-formatter-safety.test.ts` plants each attack — a
`.prettierrc.js`, a `prettier.config.cjs`, and a `node_modules/.bin/prettier`
shell script — and asserts none of them executes, plus a fourth test that the
formatter still formats, so the safety cannot be satisfied by doing nothing.

The reviewer cleared the other four areas: the relocated verify workspace
cannot escape (only `workspaceRoot` is bind-mounted; the repo and its `.git`
are a sibling that is never mounted), `commit()` cannot be abused via hooks or
filters (`.git` writes are blocked at any depth and case by `safe-path.ts`),
the stored verification output reaches only a truthiness check, and the
trailing-newline append cannot change which paths a patch touches.

Re-ran the full drill after the fix: **drill-14 passed all nine stages**,
`deepseek-v4-flash` accepted, commit `0a7557ae8a63`, working tree clean.

Final gates: **400 backend tests, 400 passing, 0 skipped**, 38 dashboard tests,
0 vulnerabilities, typecheck, format:check, dashboard build, verify-contract
and resume-checkpoint --check all green.
