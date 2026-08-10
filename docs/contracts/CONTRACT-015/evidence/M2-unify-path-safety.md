# M2 — Unify path safety

Date: 2026-08-09. Status: **done**.

## What changed

`src/safe-path.ts` is new and holds two primitives that three modules
previously kept private copies of:

| Was                                                                      | Now                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `safeWorkerPath()` in `src/worker/planner.ts`                            | wrapper over `safeRelativePath(path, "worker path")`     |
| `safePath()` in `src/work/git-publication.ts`                            | wrapper over `safeRelativePath(path, "repository path")` |
| `safePath()` in `src/operations/patch-scope.ts`                          | wrapper over `safeRelativePath(path, "patch path")`      |
| `owned()` in `git-publication.ts` and `patch-scope.ts` (identical twice) | `ownedByManifest()`                                      |

The public name `safeWorkerPath` is retained because `src/worker/artifacts.ts:5`
imports it; only its body moved.

## The prior deliberate-duplication decision was honoured, not overruled

`src/operations/patch-scope.ts` carried an explicit comment stating its copy was
duplicated _on purpose_, so the boundary governing an untrusted AI-produced
patch stayed independently reviewable from the one governing the final
publication commit.

That concern was real and is preserved. What is now shared is the string-level
primitive only. Each of the three boundaries keeps its own wrapper, its own
label, its own error text, and its own tests, so each is still reviewed
separately at its point of use. What they no longer do is disagree about what a
dangerous path looks like — which is precisely what three drifting copies
guarantee over time. The comment in `patch-scope.ts` was rewritten to say this
rather than deleted, so a future reader sees the reasoning changed
deliberately.

## Union, not intersection — with one deliberate strengthening

Rejections common to all three implementations: absolute paths, `..` segments
(rejected pre-normalization, so even a non-escaping `a/b/../c.ts` is refused),
NUL bytes, Git pathspec/glob metacharacters `* ? [ :`, and a normalized result
of `.` or `../…`.

Only `safeWorkerPath` explicitly rejected empty input; the other two reached the
same outcome indirectly, because `posix.normalize("")` returns `"."`, which they
then rejected. The union makes the empty check explicit.

**One case is stronger than any of the three.** All three rejected `.git` and
`.git/…` only at the root, so `vendor/.git/config` and
`a/b/.git/hooks/pre-commit` passed every one of them. No legitimate source
change writes inside any `.git` directory at any depth, so the segment is now
refused wherever it appears. This is recorded as a strengthening rather than a
faithful merge because it is the single place this module is not a pure union.
The full suite confirms nothing legitimate was relying on the looser behaviour.

## Error messages no longer echo untrusted input

`safeWorkerPath` withheld the offending path from its message; the other two
interpolated it. The strict posture won.

These paths arrive from untrusted model output, and the resulting errors are
logged and persisted as milestone evidence. A path containing newlines could
otherwise forge additional log lines. `tests/safe-path.test.ts` asserts this
directly, using a path carrying an embedded fake log line.

## Known limit, stated rather than implied

This is a **string-level** guard. It cannot detect that an allowed path is a
symlink pointing outside the workspace, because resolving that requires
filesystem access this function deliberately does not have. The contract's
milestone wording mentioned symlink tests; the honest position is that symlink
containment is not this function's job and is not tested here as though it were.

That containment is provided instead by the worker sandbox —
`src/worker/planner.ts:63-75` runs with `--read-only`, `--cap-drop=ALL`,
`--security-opt`, `--pids-limit`, `--memory`, `--cpus`, and `--network=none`,
with only the project workspace mounted. Recording the boundary here so a future
reader does not mistake a passing path check for symlink safety.

## Verification

`tests/safe-path.test.ts` — 11 tests covering traversal in nine shapes,
absolute and drive-qualified paths, NUL bytes and empty input, all pathspec and
glob metacharacters, `.git` at eight depths, accepted normalizations
(including that `.github` and `.gitignore` are **not** caught by the `.git`
rule), message-injection resistance, per-boundary labels, and eight
`ownedByManifest` cases including the bare-`**` refusal and the
`src/dash/**` vs `src/dashboard/…` prefix trap.

Full backend suite, standing zero-skip invocation:

```
# tests 179
# pass 179
# fail 0
# skipped 0
# duration_ms 51073.9
```

179 = 168 after M1 + 11 new. Dashboard suite: 5 files, 20 tests, all passing.
`npm run typecheck` clean. `npm run format:check`: all matched files use
Prettier code style.

One test expectation was wrong on first run and was corrected, not the code:
`a/b/../c.ts` was initially asserted to normalize to `a/c.ts`, but every
implementation rejects any `..` segment before normalization. The stricter real
behaviour is now asserted explicitly, with a comment explaining why a
non-escaping traversal is still refused.
