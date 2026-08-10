# M0 — Owner confirmation gate

Date: 2026-08-09. Status: **done**.

This milestone runs first, at the owner's explicit direction, so that M1–M9
execute without interruption. Every decision below was taken by the owner
before any implementation work began.

## Decisions recorded

### 1. Dead-code removal approved

M1 may delete `src/providers/**` (adapter, registry, router, types — 289
lines), `src/index.ts`, `src/work/postgres-publication-recorder.ts`, and
`tests/providers.test.ts` (287 lines, the sole consumer of `src/providers/**`).

The owner was told explicitly that the backend test count drops from 178 to
approximately 174 as a result, and that this is a smaller number rather than a
regression. Evidence for M1 must state the new total plainly and account for
the difference.

**Correction, recorded after M1 executed:** that estimate was wrong. The real
figure is 168, not ~174 — `tests/providers.test.ts` held ten test cases, not
four. The delta is entirely attributable to that one file and no other test was
lost (see `M1-retire-dead-abstractions.md` for the accounting). The decision
itself is unaffected, but the number the owner was given when approving it was
understated, so it is corrected here rather than left to stand.

The reason given and accepted: `src/providers/**` is not merely unused, it is a
second plausible answer to "how does this system route to a provider",
competing with `src/gateway/**`, which is what actually runs. A reader has no
way to tell which is live.

### 2. Advance authority — granted for the whole roadmap

The owner granted advance authority **through the completion of every contract
in `docs/product/roadmap-2026H2.md`** ("penuh sampai semua contract selesai"),
not just CONTRACT-015. For each contract, once all gates are green, the
following proceed without a further pause:

- redeploying the private staging instance;
- creating the single contract commit;
- pushing that commit to `origin/main`.

**This authority explicitly does not extend to**, and each still requires fresh
owner approval at the time:

- any public DNS change, Cloudflare cutover, or public hostname exposure —
  already deferred by the owner's earlier decision that CONTRACT-020 builds the
  full domain capability while the public cutover stays out of scope;
- promotion of anything to production;
- any action touching the orphaned `polyptech-dashboard.service`, which the
  owner has repeatedly asked be left alone pending a deliberate decision;
- secret-impacting or otherwise irreversible operations not listed above.

The standing rule in `AGENTS.md` §8 is unchanged by this grant. What the grant
removes is the per-contract pause for ordinary, revertible delivery steps — not
the approval requirement for destructive or outward-facing ones.

### 3. Release criterion 8 — record correction authorised

`docs/contracts/CONTRACT-010/acceptance-matrix.md` records criterion 8
("Factory Live View displays real versioned events and pauses when hidden") as
`Verified`. The audit established that no server route emits those events and
that every supporting test is fixture-fed
(`docs/contracts/CONTRACT-015/audit-2026-08-09.md`, first finding). This
contract corrects the record to state what is true today. CONTRACT-017 is what
earns the `Verified` back, against a real producer.

Owner's standing instruction on that work, recorded verbatim because it sets
the acceptance bar: _"tentu saja nyata, we're doing real work here, not
dummy."_

### 4. Telegram scope — full conversational entry point

For CONTRACT-016, the owner chose the deeper option: Telegram becomes a full
conversational door into the factory, not only notifications and approvals.

Consequence accepted at decision time: this opens a second ingress for
untrusted text, so CONTRACT-016 carries its own security review of the
authority boundary in `docs/architecture/adr-0002-conversation-authority-boundary.md`
— specifically that a Telegram-originated message can never gain execution
authority that the same message typed into the dashboard would not have.

### 5. Design direction — locked

The console direction shown in the mockup published 2026-08-09 is accepted as
the basis for CONTRACT-018's token system: warm-neutral grounds, a single flat
ink accent with no glow or gradient, semantic colour reserved strictly for gate
state, and monospace as a structural voice for identifiers, costs, routes, and
domains.

CONTRACT-016 is deliberately built on the _current_ visual language so that a
behaviour change and an appearance change are never verified together.

## Baseline locked before any change

Measured with the standing zero-skip invocation from `docs/RESUME.md`:

```
178 tests, 178 pass, 0 fail, 0 skipped, 43.2 s
```

`scripts/verify-contract.ts CONTRACT-015`: structure and scope OK.

Every later milestone in this contract is measured against that baseline.
