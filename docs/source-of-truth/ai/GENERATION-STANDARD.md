# Generation Standard

Generation must be normalized before patch execution.

Required controls:

- Blueprint translation produces product intent, not direct patch scope.
- Generation planning converts product intent into small implementation phases.
- Each phase has owned paths, acceptance checks, and a bounded prompt.
- DeepSeek receives small path-scoped tasks before any coding fallback.
- Fallback is allowed only after durable verifier evidence.
- A task is complete only after deterministic verification and a clean commit.

Heavy drill controls:

- Large generation work should be split into phase-scoped tasks unless the
  artifact is intentionally reviewable as a single output.
- A single-output UI drill may use the `single-phase-ui-review` marker so the
  generated HTML can be reviewed directly, but it must still include dense
  acceptance checks and tests.
- Extreme and UI-extreme generation waits must allow at least 60 minutes before
  declaring timeout. The former 15-minute cap was too small for heavy UI or
  multi-phase generation.
- Telegram reporting should summarize phase, model, repair, verifier, and
  publication evidence while suppressing low-signal first-attempt phase spam.
