# M2 — The drill, and the first blueprint this factory has ever produced

Date: 2026-08-11. Status: **done**.

## What now exists

`scripts/generation-drill.ts` drives the pipeline against a real database and
reports the stage it reached. Nine stages are declared; five are implemented.

Two reporting rules, inherited from CONTRACT-017B and enforced by construction:
a stage is reported as **reached**, never assumed, and an unimplemented stage is
`pending` rather than `skipped` — "skipped" would imply a decision was made.

It drives the **service layer**, not HTTP. The Control API routes are thin
wrappers over exactly these calls, and going through them would add CSRF and
session mechanics that are tested elsewhere while obscuring which pipeline
stage failed. What that loses is the Control API's _process identity_, which
matters for the permission defect M1 found — noted in the script itself, and
M3's job to assert directly rather than infer.

Identifiers derive from a run label, so re-running with the same label resumes
against the same conversation and project rather than littering the database.

## The run

Smoke-tested against the disposable test database, then run against **staging**:

```
generation drill: drill-1
reached: translation

  ok    conversation    projectId dd62b4a7-3a49-5093-b299-3ce4596b7113
  ok    brief           ordinal 1
  ok    proposal        6355335f-48c6-4e68-979e-84f7bd771192, owner_review
  ok    approval        handed_off, approvalId 7f15d595-…, version 4
  ok    translation     queued; taskId 09dd52aa-…, projectState idea
  ----  provisioning    not implemented until CONTRACT-017C M3+
  ----  generation      …
  ----  verification    …
  ----  publication     …
```

The supervisor then leased the translation task out of process and ran it.

**`untitled-dd62b4a73a49` moved `idea → blueprint`, version 0 → 2.** No project
in this system had ever left `idea` before. Zero proposals had ever existed;
there is now one, approved and handed off through the real authority boundary
rather than written directly into the database.

Both facts were read back from staging, not inferred from the drill's own
output — the approval stage asserts against the stored row for exactly that
reason.

## The blueprint

```json
{
  "slug": "slugify-4f7a0b00",
  "displayName": "Slugify",
  "stack": { "runtime": "node-22", "database": "none", "framework": "none" },
  "requirements": [
    "Export a function slugify(input: string): string",
    "Lowercase the input and replace runs of non-alphanumeric characters with a single hyphen",
    "Trim leading and trailing hyphens from the result",
    "Return an empty string for empty or all-punctuation input",
    "Cover every rule above with tests using node:test"
  ],
  "qualityGates": ["typecheck", "format:check", "test"],
  "resources": {
    "cpuMillis": 500,
    "memoryMiB": 1024,
    "diskMiB": 4096,
    "maxProcesses": 32,
    "network": "none"
  },
  "lifecyclePolicy": { "productionApproval": true, "destructiveApproval": true }
}
```

A genuinely good blueprint. The requirements are faithful to the brief and are
specific enough to write tests against.

## The defect it exposed on the first run

**`"runtime": "node-22"`.**

`NodeWorkspaceProvisioner.provision()` opens with:

```ts
if (blueprint.stack.runtime !== "node")
  throw new Error(
    `unsupported blueprint runtime for workspace provisioning: ${blueprint.stack.runtime}`,
  );
```

So **this blueprint cannot be provisioned.** Not because the model was wrong —
"node-22" is a more precise answer than "node", and the system runs Node 22 —
but because `BlueprintTranslationDriver` passes the model's free-text runtime
straight through while the provisioner demands one exact string.

M1 predicted this and ranked it **Low**, reasoning that the driver "builds the
document itself with safe defaults" and only `runtime` could break. The
mechanism was right and the confidence was wrong: it did not survive one run.

Worth being precise about where the fault is. Three candidates:

1. The model, for saying `node-22`. **No** — it answered well.
2. The provisioner, for exact-matching. **Partly** — but a loose match invites
   a blueprint saying `python` to be scaffolded as Node, which is the failure
   mode its comment says it exists to prevent.
3. **The translation driver, for treating a free-text model answer as a
   controlled vocabulary.** This is the fault. Every other field in that
   document is either fixed by the driver or validated; `runtime` alone is
   passed through untouched, into a check that accepts exactly one value.

The fix is normalisation at the boundary that already owns the vocabulary —
mapping model runtime text onto the supported set, and rejecting honestly and
early when it maps to nothing, rather than at provisioning time with a message
about an unsupported runtime. That lands in M3, with provisioning.

## Spend

One gateway attempt, `claude-sonnet-5`, succeeded, two usage rows, **$0.0852**.

Reported rather than tallied silently, per the standing rule. The generation
call in M4 is the expensive one; translation is cheap.

## What M1 got right and wrong, so far

| M1 said                                               | Reality                                   |
| ----------------------------------------------------- | ----------------------------------------- |
| Proposal path works (Unproven, not predicted to fail) | Correct — worked first time               |
| Blueprint translation is "robust by construction"     | **Wrong** — the one pass-through broke it |
| Runtime mismatch ranked **Low**                       | **Wrong tier** — hit on run one           |

Two of the four confirmed findings (#3 permissions, #1 no terminal state) are
still ahead and unchanged. #2 (retries) and #5 (patch left applied) are not
reachable until a generation task runs.
