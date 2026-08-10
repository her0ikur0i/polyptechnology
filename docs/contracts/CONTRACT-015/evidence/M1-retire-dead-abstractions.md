# M1 — Retire dead and competing abstractions

Date: 2026-08-09. Status: **done**.

## What was removed

| Path                                        | Lines | Why                                                                                                                                           |
| ------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/providers/adapter.ts`                  |   ~50 | Zero importers outside `src/providers/`                                                                                                       |
| `src/providers/registry.ts`                 |  ~120 | Zero importers outside `src/providers/`                                                                                                       |
| `src/providers/router.ts`                   |  ~145 | Zero importers outside `src/providers/`                                                                                                       |
| `src/providers/types.ts`                    |   ~75 | Zero importers outside `src/providers/`                                                                                                       |
| `src/index.ts`                              |    17 | Zero importers; not the entrypoint (`package.json` starts `src/control-api/server.ts`); unreferenced by `deploy/`, `package.json`, `.github/` |
| `src/work/postgres-publication-recorder.ts` |   ~85 | Zero importers; the `PublicationRecorder` **interface** it implemented lives in `src/work/publication-executor.ts:21` and stays               |
| `tests/providers.test.ts`                   |   287 | Sole consumer of `src/providers/**`                                                                                                           |

The decisive point was never the unused bytes. `src/providers/**` implemented a
provider registry, router, and adapter interface — the same responsibility
`src/gateway/**` actually performs in production. A reader arriving at this
repository had two plausible answers to "how does this system route to a
provider" and no way to tell which one runs.

## Verification that nothing depended on them

`npm run typecheck` — clean, no errors.

Full backend suite, standing zero-skip invocation from `docs/RESUME.md`:

```
# tests 168
# pass 168
# fail 0
# skipped 0
# duration_ms 42618.7
```

Dashboard suite: `Test Files 5 passed (5)`, `Tests 20 passed (20)`.

Dangling-reference sweep for every deleted module path across `src/` and
`tests/`: **0 matches**.

## Test-count accounting

Baseline before this milestone was **178**; it is now **168**. The delta is
**10**, and all ten came from `tests/providers.test.ts`:

- 178 − 168 = 10
- `tests/providers.test.ts` was the only test file deleted
- every remaining test file passes unchanged, 0 skipped, so no test was lost
  anywhere else

This is stated explicitly because a falling test count normally signals a
regression, and here it does not: the removed tests had exactly one subject —
code that no production path could reach. A test whose only subject is
unreachable code protects nothing.

**The estimate given to the owner at the M0 confirmation gate was ~174, which
was wrong.** `tests/providers.test.ts` contained ten cases rather than the four
assumed when the approval was requested. The correction is recorded in
`M0-owner-confirmation.md` §1 as well, so the approval record and the outcome
do not disagree.

## What deliberately stayed

- `src/work/publication-executor.ts` — live, exercised by
  `tests/work-engine.test.ts:182,200,234`, which supplies its own recorder
  double. Only the unused Postgres implementation of its interface was removed,
  not the interface or the executor.
- `src/work/git-publication.ts` — live, imported by `publication-executor.ts:8`.
  Its `safePath()` is one of the three implementations M2 unifies; removing it
  here would have mixed two milestones' concerns.
