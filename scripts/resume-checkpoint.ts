import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Regenerates the volatile half of docs/RESUME.md.
//
// Written because the file lied. Two sessions in a row ended with the
// connection dropping mid-milestone, and the resume checkpoint -- the one file
// a fresh session is told to read first -- still said M5 had not started when
// M5's evidence file was already on disk, and quoted a test count three
// milestones stale. Nothing was actually lost either time, but only because
// the working tree survived and state could be reconstructed from file mtimes.
//
// Everything this script writes is derived from something that cannot drift:
// the presence of evidence/M<n>-*.md, git, and the filesystem. The prose around
// the generated block stays hand-written, because judgement does not derive.

export const BLOCK_START = "<!-- resume:auto:start -->";
export const BLOCK_END = "<!-- resume:auto:end -->";

export interface Milestone {
  readonly index: number;
  readonly title: string;
}

export interface MilestoneState extends Milestone {
  readonly evidence: string | undefined;
}

export interface CheckpointFacts {
  readonly contractId: string;
  readonly milestones: readonly MilestoneState[];
  readonly head: string;
  readonly dirtyCount: number;
  readonly lastTouched:
    { readonly path: string; readonly at: string } | undefined;
  readonly generatedAt: string;
}

// The Milestones section is a numbered list whose entries open "N. MN: title"
// and wrap onto indented continuation lines. Those lines are joined back first:
// cutting an entry at the hard wrap produced titles that ended mid-clause
// ("anything outside it refused rather than"), which reads as a truncation bug
// in the very file a resuming session is supposed to trust.
export function parseMilestones(contractMarkdown: string): Milestone[] {
  const section = (
    contractMarkdown.split("## Milestones\n", 2)[1]?.split("\n## ", 1)[0] ?? ""
  ).replace(/\n\s+(?=\S)/g, " ");
  return [...section.matchAll(/^(\d+)\. M(\d+): (.+)$/gm)].flatMap((match) => {
    const [, ordinal, milestone, title] = match;
    if (ordinal === undefined || milestone === undefined || title === undefined)
      return [];
    // A numbered list that has drifted out of step with its own M-numbers is a
    // documentation bug that would silently mis-report state. Refuse it.
    if (ordinal !== milestone)
      throw new Error(
        `Milestone list is inconsistent: item ${ordinal} is labelled M${milestone}`,
      );
    return [{ index: Number(milestone), title: shortTitle(title) }];
  });
}

const TITLE_LIMIT = 100;

export function shortTitle(title: string): string {
  const clause = (title.split(" — ")[0] ?? title).trim().replace(/\.$/, "");
  if (clause.length <= TITLE_LIMIT) return clause;
  const cut = clause.slice(0, TITLE_LIMIT);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

// The presence of evidence/M<n>-*.md is the authoritative done signal. That
// rule predates this script; it is written down in RESUME.md and in the
// contract, and this only mechanises reading it.
export function attachEvidence(
  milestones: readonly Milestone[],
  evidenceFiles: readonly string[],
): MilestoneState[] {
  return milestones.map((milestone) => ({
    ...milestone,
    evidence: evidenceFiles.find((file) =>
      new RegExp(`^M${milestone.index}-.*\\.md$`).test(file),
    ),
  }));
}

export function nextMilestone(
  milestones: readonly MilestoneState[],
): MilestoneState | undefined {
  return milestones.find((milestone) => milestone.evidence === undefined);
}

// Emits the column-padded table shape Prettier produces, so that running the
// repository formatter immediately after this script does not rewrite what it
// just wrote -- which would make `--check` report a freshly generated file as
// stale. `--check` normalises whitespace anyway, so the two agree even if
// Prettier's alignment rules ever change.
export function alignTable(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  const [header, ...body] = rows;
  if (header === undefined) return [];
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ];
}

export function renderBlock(facts: CheckpointFacts): string {
  const done = facts.milestones.filter((m) => m.evidence !== undefined).length;
  const next = nextMilestone(facts.milestones);
  const rows = facts.milestones.map((milestone) => {
    const state =
      milestone.evidence === undefined
        ? milestone.index === next?.index
          ? "**next**"
          : "not started"
        : `done — \`${milestone.evidence}\``;
    return [`M${milestone.index}`, milestone.title, state];
  });

  return [
    BLOCK_START,
    "",
    `<!-- Generated by scripts/resume-checkpoint.ts. Do not hand-edit: run it. -->`,
    "",
    `**Active contract: ${facts.contractId}** — ${done} of ${facts.milestones.length} milestones evidenced, generated ${facts.generatedAt}.`,
    "",
    ...alignTable([["Milestone", "Subject", "State"], ...rows]),
    "",
    `- **HEAD:** \`${facts.head}\``,
    `- **Working tree:** ${facts.dirtyCount === 0 ? "clean" : `${facts.dirtyCount} changed path(s) — expected while a contract is in flight, since this repository commits once per contract`}`,
    ...(facts.lastTouched === undefined
      ? []
      : [
          `- **Last touched:** \`${facts.lastTouched.path}\` at ${facts.lastTouched.at} — if a session ended abruptly, work was here`,
        ]),
    `- **Next action:** ${next === undefined ? `every milestone is evidenced; ${facts.contractId} is ready to close` : `M${next.index} — ${next.title}`}`,
    "",
    BLOCK_END,
  ].join("\n");
}

export function replaceBlock(resumeMarkdown: string, block: string): string {
  const start = resumeMarkdown.indexOf(BLOCK_START);
  const end = resumeMarkdown.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start)
    throw new Error(
      `docs/RESUME.md is missing the ${BLOCK_START} / ${BLOCK_END} markers`,
    );
  return (
    resumeMarkdown.slice(0, start) +
    block +
    resumeMarkdown.slice(end + BLOCK_END.length)
  );
}

export function latestContractId(entries: readonly string[]): string {
  const contracts = entries
    .filter((entry) => /^CONTRACT-\d+/.test(entry))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const latest = contracts.at(-1);
  if (latest === undefined) throw new Error("No contracts found");
  return latest;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Which file was edited most recently, among the ones this contract has
// changed. Cheap to compute and disproportionately useful: it is how the state
// of both dropped sessions was actually reconstructed.
//
// docs/RESUME.md is excluded because this script writes it. Including it would
// make every run report the resume file itself as the newest work, which is
// the one answer that tells a resuming session nothing.
export const LAST_TOUCHED_EXCLUDES: readonly string[] = ["docs/RESUME.md"];

export function lastTouched(
  paths: readonly string[],
): { path: string; at: string } | undefined {
  const stats = paths
    .filter((path) => !LAST_TOUCHED_EXCLUDES.includes(path))
    .flatMap((path) => {
      try {
        return [{ path, mtime: statSync(resolve(path)).mtime }];
      } catch {
        return []; // deleted paths still appear in git status
      }
    });
  const newest = stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
  return newest === undefined
    ? undefined
    : { path: newest.path, at: newest.mtime.toISOString().slice(0, 16) + "Z" };
}

export function collectFacts(contractId: string): CheckpointFacts {
  const contract = readFileSync(
    resolve(`docs/contracts/${contractId}/contract.md`),
    "utf8",
  );
  let evidenceFiles: string[] = [];
  try {
    evidenceFiles = readdirSync(
      resolve(`docs/contracts/${contractId}/evidence`),
    );
  } catch {
    evidenceFiles = []; // a contract at M0 has no evidence directory yet
  }

  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  const changed = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) =>
      path.includes(" -> ") ? (path.split(" -> ").at(-1) ?? path) : path,
    );

  return {
    contractId,
    milestones: attachEvidence(parseMilestones(contract), evidenceFiles),
    head: git("log", "--oneline", "-1"),
    dirtyCount: changed.length,
    lastTouched: lastTouched(changed),
    generatedAt: new Date().toISOString().slice(0, 10),
  };
}

// `--check` answers "has the recorded state drifted from the evidence on
// disk", not "is this byte-identical". The generated-on date changes daily and
// table alignment is cosmetic; neither is drift, and treating them as drift
// would train everyone to ignore the check.
export function normaliseForCheck(text: string): string {
  return (
    text
      .replace(/, generated \d{4}-\d{2}-\d{2}\./, ".")
      // HEAD, the dirty-path count and the last-touched file change on every
      // commit and every edit, so comparing them would report a freshly
      // regenerated file as stale the moment anything happened -- including
      // immediately after the commit that closes a contract. They are also the
      // three facts a resuming session can re-derive in one command each.
      // Milestone state is what actually rots, and that is what is compared.
      // Removed whole, newline included: "Last touched" vanishes entirely once
      // the tree is clean, so blanking the line would still leave a difference
      // in blank lines and report stale for the same non-reason.
      .replace(/^- \*\*(HEAD|Working tree|Last touched):\*\*.*\n?/gm, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\| */g, "|")
      .replace(/-{2,}/g, "--")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
  );
}

export function resumeCheckpoint(
  contractId?: string,
  options: { readonly check?: boolean } = {},
): void {
  const id =
    contractId ?? latestContractId(readdirSync(resolve("docs/contracts")));
  const resumePath = resolve("docs/RESUME.md");
  const current = readFileSync(resumePath, "utf8");
  const updated = replaceBlock(current, renderBlock(collectFacts(id)));

  if (options.check) {
    if (normaliseForCheck(current) !== normaliseForCheck(updated))
      throw new Error(
        "docs/RESUME.md is stale — run: node --import tsx scripts/resume-checkpoint.ts",
      );
    console.log(`docs/RESUME.md is current for ${id}`);
    return;
  }

  writeFileSync(resumePath, updated);
  console.log(`docs/RESUME.md regenerated for ${id}`);
}

const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    resumeCheckpoint(
      args.find((arg) => !arg.startsWith("--")),
      { check: args.includes("--check") },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
