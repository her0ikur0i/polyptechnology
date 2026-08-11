import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BLOCK_END,
  BLOCK_START,
  alignTable,
  attachEvidence,
  normaliseForCheck,
  latestContractId,
  markedContractId,
  nextMilestone,
  parseMilestones,
  renderBlock,
  replaceBlock,
  shortTitle,
  type CheckpointFacts,
} from "../scripts/resume-checkpoint.js";

const contract = `# CONTRACT-017 — something

## Milestones

0. M0: owner confirmation gate — records the long-polling decision and the
   authority boundary above.
1. M1: the notification surface and its plain-text formatter, with delivery
   failures that degrade rather than break the work being reported on.
2. M2: notifications wired to real event sources.

## Gates

- something else entirely, and 3. M3: this must not be read as a milestone.
`;

test("parseMilestones joins wrapped continuation lines", () => {
  const milestones = parseMilestones(contract);
  assert.deepEqual(
    milestones.map((m) => m.index),
    [0, 1, 2],
  );
  // The wrap point falls inside "with delivery / failures". Cutting there is
  // the truncation bug this join exists to prevent.
  assert.equal(
    milestones[1]?.title,
    "the notification surface and its plain-text formatter, with delivery failures that degrade rather…",
  );
});

test("parseMilestones stops at the next section heading", () => {
  assert.equal(parseMilestones(contract).length, 3);
});

test("parseMilestones refuses a list that drifted out of step with its M-numbers", () => {
  assert.throws(
    () => parseMilestones("## Milestones\n\n0. M0: fine\n1. M2: wrong\n"),
    /item 1 is labelled M2/,
  );
});

test("shortTitle prefers the clause before an em dash", () => {
  assert.equal(
    shortTitle("owner confirmation gate — records things."),
    "owner confirmation gate",
  );
});

test("shortTitle truncates on a word boundary, never mid-word", () => {
  const title = shortTitle(`${"alpha ".repeat(30)}omega`);
  assert.ok(title.endsWith("…"));
  assert.ok(title.length <= 101);
  assert.ok(!title.includes("alph…"));
});

test("attachEvidence matches M<n>- exactly, not by prefix", () => {
  const milestones = [
    { index: 1, title: "one" },
    { index: 2, title: "two" },
  ];
  // "M12-..." must not satisfy M1: a ten-milestone contract would otherwise
  // report itself finished the moment M10 landed.
  const attached = attachEvidence(milestones, ["M12-decoy.md", "M2-real.md"]);
  assert.equal(attached[0]?.evidence, undefined);
  assert.equal(attached[1]?.evidence, "M2-real.md");
});

test("nextMilestone is the first one without evidence", () => {
  const state = attachEvidence(
    [
      { index: 0, title: "zero" },
      { index: 1, title: "one" },
      { index: 2, title: "two" },
    ],
    ["M0-done.md", "M2-done.md"],
  );
  assert.equal(nextMilestone(state)?.index, 1);
});

test("nextMilestone is undefined when every milestone is evidenced", () => {
  const state = attachEvidence([{ index: 0, title: "zero" }], ["M0-done.md"]);
  assert.equal(nextMilestone(state), undefined);
});

const facts: CheckpointFacts = {
  contractId: "CONTRACT-017",
  milestones: attachEvidence(
    [
      { index: 0, title: "zero" },
      { index: 1, title: "one" },
    ],
    ["M0-done.md"],
  ),
  head: "b239fe1 docs: something",
  dirtyCount: 3,
  lastTouched: { path: "src/telegram/poller.ts", at: "2026-08-11T04:00Z" },
  generatedAt: "2026-08-11",
};

test("renderBlock names the next action and the evidence that proves the rest", () => {
  const block = renderBlock(facts);
  assert.ok(block.startsWith(BLOCK_START));
  assert.ok(block.endsWith(BLOCK_END));
  assert.ok(block.includes("1 of 2 milestones evidenced"));
  assert.ok(block.includes("done — `M0-done.md`"));
  assert.ok(block.includes("**Next action:** M1 — one"));
  assert.ok(block.includes("src/telegram/poller.ts"));
});

test("renderBlock says the contract is ready to close when nothing is left", () => {
  const block = renderBlock({
    ...facts,
    milestones: attachEvidence([{ index: 0, title: "zero" }], ["M0-done.md"]),
  });
  assert.ok(block.includes("ready to close"));
});

test("replaceBlock overwrites only between the markers", () => {
  const resume = `before\n${BLOCK_START}\nstale\n${BLOCK_END}\nafter\n`;
  const updated = replaceBlock(resume, renderBlock(facts));
  assert.ok(updated.startsWith("before\n"));
  assert.ok(updated.endsWith("\nafter\n"));
  assert.ok(!updated.includes("stale"));
});

test("replaceBlock refuses a resume file with no markers", () => {
  assert.throws(() => replaceBlock("no markers here", "x"), /missing the/);
});

test("alignTable pads every column to its widest cell", () => {
  const table = alignTable([
    ["Milestone", "Subject"],
    ["M0", "a much longer subject"],
  ]);
  assert.deepEqual(table, [
    "| Milestone | Subject               |",
    "| --------- | --------------------- |",
    "| M0        | a much longer subject |",
  ]);
});

test("normaliseForCheck ignores the generated date and table alignment", () => {
  const a = "x, generated 2026-08-11.\n| M0 | one |\n| -- | --- |\n";
  const b = "x, generated 2026-01-01.\n| M0  |  one   |\n| ---- | ----- |\n";
  assert.equal(normaliseForCheck(a), normaliseForCheck(b));
});

test("normaliseForCheck ignores HEAD, tree state and last-touched", () => {
  const before = [
    "- **HEAD:** `b239fe1 something`",
    "- **Working tree:** 46 changed path(s) — expected",
    "- **Last touched:** `src/a.ts` at 2026-08-11T01:00Z — here",
  ].join("\n");
  const after = [
    "- **HEAD:** `2e4290b something else`",
    "- **Working tree:** clean",
    "- **Last touched:** `src/b.ts` at 2026-08-11T02:00Z — here",
  ].join("\n");
  // Otherwise the file is stale the instant a contract is committed, and a
  // check that fires on a freshly generated file teaches everyone to skip it.
  assert.equal(normaliseForCheck(before), normaliseForCheck(after));

  // "Last touched" is omitted entirely once the tree is clean, so the lines
  // have to be removed whole rather than blanked.
  const committed = ["- **HEAD:** `x y`", "- **Working tree:** clean"].join(
    "\n",
  );
  assert.equal(normaliseForCheck(before), normaliseForCheck(committed));
});

test("normaliseForCheck still sees a real change in state", () => {
  const a = "| M6 | commands | **next** |";
  const b = "| M6 | commands | done — `M6-x.md` |";
  assert.notEqual(normaliseForCheck(a), normaliseForCheck(b));
});

test("the active contract comes from an explicit marker, not from sorting", () => {
  // CONTRACT-017A was opened after CONTRACT-017B closed. "Highest-numbered
  // directory" reported the finished one as active, because A sorts before B.
  // A contract can be inserted anywhere in the sequence, so inference was
  // never sound.
  assert.equal(
    markedContractId("prose\n<!-- resume:contract: CONTRACT-017A -->\nmore"),
    "CONTRACT-017A",
  );
  assert.equal(markedContractId("no marker here"), undefined);
  // Tolerant of spacing, since a formatter may reflow the comment.
  assert.equal(
    markedContractId("<!--resume:contract:CONTRACT-022-->"),
    "CONTRACT-022",
  );
});

test("latestContractId sorts numerically, not lexically", () => {
  assert.equal(
    latestContractId([
      "CONTRACT-009",
      "CONTRACT-017",
      "CONTRACT-100",
      "CONTRACT-021",
      "README.md",
    ]),
    "CONTRACT-100",
  );
});

test("latestContractId refuses an empty contracts directory", () => {
  assert.throws(() => latestContractId(["README.md"]), /No contracts found/);
});
