import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;
const scripts = join(repoRoot, "skills/remove-ai-marks/scripts");

async function runFindingCommand(file: string, args: string[]) {
  try {
    return await run(file, args);
  } catch (error) {
    const result = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (result.code === 1)
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    throw error;
  }
}

test("vendored remove-ai-marks skill inspects and cleans Layer A text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remove-ai-marks-"));
  const source = join(dir, "draft.md");
  const cleaned = join(dir, "draft.cleaned.md");
  await writeFile(
    source,
    "Title\u200b with hidden mark\n\nAI\u00a0metadata: true\n",
    "utf8",
  );

  const inspected = await runFindingCommand("python3", [
    join(scripts, "inspect_text.py"),
    "--json",
    source,
  ]);
  assert.match(inspected.stdout, /ZERO WIDTH SPACE/);

  await run("python3", [
    join(scripts, "clean_text.py"),
    source,
    "-o",
    cleaned,
    "--stats",
  ]);
  const output = await readFile(cleaned, "utf8");
  assert.equal(output.includes("\u200b"), false);
  assert.equal(output.includes("\u00a0"), false);
  assert.match(output, /Title with hidden mark/);
});

test("vendored remove-ai-marks unified cleaner works for markdown files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remove-ai-marks-file-"));
  const source = join(dir, "notes.md");
  const cleaned = join(dir, "notes.cleaned.md");
  await writeFile(
    source,
    "---\nai_model: claude\n---\nVisible\u200b body\n",
    "utf8",
  );

  const result = await run("python3", [
    join(scripts, "clean_file.py"),
    source,
    "-o",
    cleaned,
    "--json",
  ]);
  assert.match(result.stdout, /markdown/);
  const output = await readFile(cleaned, "utf8");
  assert.equal(output.includes("ai_model"), false);
  assert.equal(output.includes("\u200b"), false);
  assert.match(output, /Visible body/);
});
