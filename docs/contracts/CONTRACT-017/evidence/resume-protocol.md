# Evidence — the resume protocol (Amendment 2)

Not a milestone. Recorded here because it changes how every milestone after it
is closed, and because the thing it fixes cost real time twice.

## What went wrong

Two consecutive sessions ended with the connection dropping mid-milestone
(2026-08-10 ~18:41 and ~20:13 local). Neither lost work — the working tree
survived both times — but reconstructing _where_ the work stopped took a full
investigation on each resume: reading `git status`, sorting changed files by
mtime, and finally reading the previous session's transcript.

`docs/RESUME.md`, the one file `CLAUDE.md` tells a fresh session to read first,
was actively wrong at that moment:

| Claim in the file                                      | Reality on disk                                     |
| ------------------------------------------------------ | --------------------------------------------------- |
| "M5–M8 not started"                                    | `evidence/M5-conversation-from-telegram.md` existed |
| "265 tests, 265 passing"                               | 276 passing, reconciled the previous session        |
| "Plain text, not MarkdownV2"                           | HTML parse mode since M1's amendment                |
| "Nothing executes ... in a chat"                       | Amendment 1 gave the assistant tools as root        |
| "CONTRACT-017 builds the real [Factory Live] producer" | that is CONTRACT-019 since the renumbering          |

Every one of those was true when written. The file was updated once per
contract, so it decayed for the entire span of a contract — exactly the window
in which a dropped session needs it.

## The fix

`scripts/resume-checkpoint.ts` generates the volatile part of `docs/RESUME.md`
between `<!-- resume:auto:start -->` and `<!-- resume:auto:end -->`, from facts
that cannot drift:

- milestone state from the presence of `evidence/M<n>-*.md` — a rule that
  already existed and was already documented, now mechanically read instead of
  manually transcribed;
- `HEAD` and the dirty-path count from `git`;
- **the most recently modified changed file**, which is what actually located
  the stopping point both times, now computed in advance instead of after the
  fact.

`--check` fails when the recorded state has drifted from the evidence on disk.
It is a contract gate, so a milestone cannot close on a stale checkpoint.

Prose outside the markers stays hand-written. Judgement does not derive from
the filesystem, and pretending otherwise would produce a file that is accurate
and useless.

## Verified

```
$ node --import tsx scripts/resume-checkpoint.ts
docs/RESUME.md regenerated for CONTRACT-017
$ npm run format
docs/RESUME.md 104ms (unchanged)
$ node --import tsx scripts/resume-checkpoint.ts --check
docs/RESUME.md is current for CONTRACT-017
$ npx tsx --test tests/resume-checkpoint.test.ts
# tests 17
# pass 17
# fail 0
```

Prettier reporting `(unchanged)` matters more than it looks: the first version
emitted unpadded tables, Prettier repadded them, and `--check` then declared a
file stale that had been generated seconds earlier. A check that cries wolf is
a check everyone learns to skip, so the generator now emits the aligned shape
Prettier would produce, and `--check` compares state rather than bytes.

Two defects were found in the generator by reading its own first output, both
fixed and both now covered by tests: milestone titles were cut at the
contract's hard line wrap (`"anything outside it refused rather than"`), and
`lastTouched` reported `docs/RESUME.md` itself — the script's own write —
which is the single least useful answer it could give.

## Not done here, deliberately

The check is not wired into a git hook or into `npm run verify`. `verify` is
the contract-close gate and the check belongs at every milestone, which is a
discipline `CLAUDE.md` now states explicitly. Automating it further is a
CONTRACT-017A-or-later question, not something to smuggle in at M6 of M8.
