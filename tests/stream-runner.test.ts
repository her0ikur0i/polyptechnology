import assert from "node:assert/strict";
import test from "node:test";
import { defaultStreamRunner } from "../src/gateway/cli-adapters.js";

// Every case here was a real defect found by the CONTRACT-016 M4 independent
// review, reproduced against real child processes. They are regression guards,
// not speculative hardening.

const nodeScript = (body: string) => ["-e", body];

test("a timeout kill is reported as a timeout, not as a clean exit", async () => {
  // Node reports a SIGKILLed child as code=null. The runner used to translate
  // that to `exitCode: 0` and RESOLVE, so a force-killed provider call was
  // recorded as having exited cleanly -- actively misleading anyone triaging a
  // costed failure. The buffered execFile path rejects here; this must match.
  await assert.rejects(
    defaultStreamRunner(
      process.execPath,
      nodeScript("process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"),
      { timeout: 300 },
      () => {},
    ),
    /claude_cli_timeout_after_300ms/,
  );
});

test("an ordinary non-zero exit still resolves with its real code", async () => {
  const result = await defaultStreamRunner(
    process.execPath,
    nodeScript("process.exit(3)"),
    { timeout: 5_000 },
    () => {},
  );
  assert.equal(result.exitCode, 3);
});

test("stderr keeps the tail, because the diagnostic reads the last line", async () => {
  // The cap used to refuse to append once full, keeping the HEAD -- so a
  // provider that printed 70 kB of noise before its real error had that error
  // silently discarded, and the extracted "last line" was a filler fragment.
  const lines: string[] = [];
  const result = await defaultStreamRunner(
    process.execPath,
    nodeScript(
      "process.stderr.write('x'.repeat(70000)+'\\n');" +
        "process.stderr.write('THE ACTUAL ERROR: provider auth token expired\\n');" +
        "process.exit(1);",
    ),
    { timeout: 10_000 },
    (line) => lines.push(line),
  );

  assert.ok(
    result.stderr.includes("THE ACTUAL ERROR"),
    "the meaningful last line must survive truncation",
  );
  assert.equal(
    result.stderr.trim().split("\n").at(-1),
    "THE ACTUAL ERROR: provider auth token expired",
  );
  assert.ok(result.stderr.length <= 64_000, "stderr must stay bounded");
});

test("an unterminated giant line is bounded instead of buffered forever", async () => {
  // One NDJSON line with no newline used to accumulate without any cap: the
  // review pushed 10 MB through and watched RSS grow ~142 MB, with nothing to
  // stop it at 100 MB either. The delta ceiling does not help, because it only
  // gates text after a complete line has already been parsed.
  const sizes: number[] = [];
  await defaultStreamRunner(
    process.execPath,
    nodeScript(
      "const c='y'.repeat(100000); for(let i=0;i<30;i++) process.stdout.write(c);",
    ),
    { timeout: 20_000 },
    (line) => sizes.push(line.length),
  );

  assert.ok(sizes.length > 0, "expected the bounded line to be handed over");
  const largest = Math.max(...sizes);
  assert.ok(
    largest <= 1_200_000,
    `a single handed-over line reached ${largest} bytes; the cap did not hold`,
  );
});

test("a line split across reads is reassembled exactly once", async () => {
  const lines: string[] = [];
  await defaultStreamRunner(
    process.execPath,
    nodeScript(
      "process.stdout.write('{\"a\":1');" +
        "setTimeout(()=>{process.stdout.write(',\"b\":2}\\n');process.exit(0);},50);",
    ),
    { timeout: 10_000 },
    (line) => lines.push(line),
  );

  assert.deepEqual(lines, ['{"a":1,"b":2}']);
});

test("a missing binary rejects rather than hanging", async () => {
  await assert.rejects(
    defaultStreamRunner(
      "definitely-not-a-real-binary-9f2a",
      [],
      { timeout: 5_000 },
      () => {},
    ),
    (error: unknown) => error instanceof Error,
  );
});
