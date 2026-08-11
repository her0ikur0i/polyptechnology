# M0 — Owner confirmation

Date: 2026-08-11. Status: **done**. The contract's only owner checkpoint.

## How this M0 was different

The owner's standing rule is that confirmations are batched at the front of a
contract. They then asked for three contracts to run unattended, one after the
other, which makes a per-contract M0 a contradiction: a question asked at the
start of CONTRACT-017A would stop the chain it was supposed to run.

So the batch covered **all three contracts at once**, in two rounds, before any
work began. Recorded here because the next session should not mistake
017A's and 018's answered questions for decisions somebody made up.

## Round 1 — CONTRACT-017B

**Task naming.** Type plus what it is about, no uuid. Chosen from three options
against a rendered preview of the resulting Telegram message.

> ❌ Chat reply failed
> "ada berapa contract pada project ini?"
> Gave up after 3 attempts

The alternative that kept an 8-character id for correlation was declined. The
subject line is the correlation.

**Report noise.** Terminal outcomes only — success and final failure. Retries
stay silent. Any line whose value is zero or unchanged is dropped. The measured
target is the transcript that prompted this contract: six messages become
three.

A daily digest was offered as a third option and declined.

**Chain mode.** Ask the whole chain's questions now, then run 017B → 017A → 018
unattended, stopping only for DNS, secrets, public exposure, irreversible
actions, or a failed gate.

## Round 2 — CONTRACT-017A and CONTRACT-018

Answered now so the chain does not stop later.

**017A session storage:** a side table `conversation_provider_sessions`, keyed
by `(conversation_id, provider_id)`. A conversation can hold a live Claude
session and a dead DeepSeek one at once, and the escalation chain means the
"one provider per conversation" assumption behind a single column will not
hold.

**017A retry identity:** each attempt gets its own ledger entry, keyed per
`(task, attempt)` rather than per task. A retry becomes a new reservation and a
new audit row, which is what actually happened. The alternative — rewriting the
first attempt's request hash — was declined for overwriting the record the
ledger exists to keep.

**018 layout:** single column, claude.ai-like, with everything else behind a
collapsible left rail. The owner will still see a rendered mockup before any UI
is written; this decides which one gets built, not whether it gets reviewed.

## Standing rules confirmed the same day

These apply from this contract onward and are recorded in `docs/RESUME.md`:

- `/security-review` runs **before** the push. Findings are fixed first.
- `README.md` is updated when a contract closes.
- Commits are authored `heroikuroi <heroikuroi@gmail.com>`, Claude as
  `Co-Authored-By`. Pushed history is not rewritten to correct earlier commits,
  so CONTRACT-017's four commits keep their `root@` author.
- A successful push rolls straight into the next contract.

## Advance authority

Unchanged from CONTRACT-015 M0 and reconfirmed on 2026-08-11: staging
redeploys, `polyp-sequence.service` restarts, live drills that spend real
provider money, and the single commit and push all proceed without pausing.

Still excluded, still needing fresh approval at the time: public DNS, the
Cloudflare cutover, public hostname exposure, production promotion, anything
secret-impacting or irreversible, and `polyptech-dashboard.service`.

## One thing the owner was told rather than asked

The permission allow-list they requested includes shell command substitution.
Approving `$(…)` means approving whatever is inside it, so in practice that
rule auto-approves most Bash commands on this host. They asked for it
explicitly for a single-owner machine; it is recorded here rather than quietly
narrowed, because a security boundary that was widened silently is the kind of
thing this project writes contracts to avoid.
