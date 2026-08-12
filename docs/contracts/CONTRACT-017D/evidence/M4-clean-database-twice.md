# M4 — the drill runs from a clean database, twice

Date: 2026-08-12. Status: **done.**

Gate: _two clean-database runs produce the same terminal result._ Met.

## Why not staging

`polyp-staging-pg` holds real, persistent staging data — RESUME.md is
explicit that it is not disposable. "Genuinely clean" therefore means a
database that has never held anything, not staging wiped between runs, and
"nothing else queued" means no other suite's or drill's tasks can be leased
by the same `runOne()` — a real risk, since `runOne()` is documented as
global and leases the first eligible task in the whole database.

## Which brief

The simple brief (`slugify`), not `moneybag`. This milestone is proving the
_pipeline_ is deterministic in its outcome shape — same stages, same tier,
same terminal state — not re-litigating model capability on a hard brief,
which Scope already excludes ("Making models better at hard briefs... belongs
in a contract about task decomposition, not this one"). The deep brief's
own verdict varies by design — that is what makes it a useful stress test —
so it is the wrong tool for asking "is the plumbing repeatable."

## Setup, twice, independently

For each run: a fresh, disposable Postgres container (`docker run --rm`,
the same pinned image the test suite already uses), all 17 migrations
applied in filename order from empty, a throwaway
`sequence-main.ts` supervisor pointed at only that database (no
`TELEGRAM_BOT_TOKEN` — the real bot's poller and this throwaway one never
overlap), and a fresh `PROJECT_WORKSPACES_ROOT` under `/tmp`. `NODE_ENV=production`
was set deliberately, matching the real supervisor's actual environment
now that M2's provisioning fix makes it harmless. Nothing shared between run
1 and run 2: separate containers, separate ports, separate workspace roots,
separate supervisor processes, torn down completely between them.

## Result

|                             | Run 1                                 | Run 2                                 |
| --------------------------- | ------------------------------------- | ------------------------------------- |
| reached                     | `publication`                         | `publication`                         |
| every stage                 | 9/9 `ok`                              | 9/9 `ok`                              |
| generation tier             | `deepseek:deepseek-v4-flash=accepted` | `deepseek:deepseek-v4-flash=accepted` |
| verifier                    | `isolated-worker-v1`                  | `isolated-worker-v1`                  |
| working tree at publication | clean                                 | clean                                 |
| commit                      | `303bf782b378`                        | `d9b019929194`                        |
| changed lines               | 38                                    | 42                                    |

**Identical terminal result**, on the dimensions that are actually the
pipeline's to guarantee: which stage it reached, which tier accepted, that
verification ran for real, that the tree was clean at commit. The commit
hashes and line counts differ because two independent model calls wrote
different (both correct) implementations of the same brief — that is
expected variance in the content, not a reproducibility failure in the
system that generated, verified and published it.

## Teardown

Both containers stopped and removed (`--rm`), both throwaway supervisors
killed, both `/tmp` workspace roots deleted. Nothing from this milestone
touches `polyp-staging-pg` or the shared test database at any point.
