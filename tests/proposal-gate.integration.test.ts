import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { OwnerCommandService } from "../src/operations/owner-commands.js";

// The gate Amendment 1 rests on, verified against this implementation rather
// than assumed from ADR-0002.
//
// Amendment 1 gave the assistant tools inside this repository. The claim that
// makes that acceptable is narrow and specific: it still cannot reach the
// factory's generation pipeline except through a proposal the owner approves.
// `scripts/propose.ts` is the assistant's only route into factory work, it was
// wired into the system prompt, and until now nobody had ever run it.

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl !== undefined) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const conversations = new PostgresConversationStore(pool);

  async function seedConversation(): Promise<{
    projectId: string;
    conversationId: string;
  }> {
    const secret = randomUUID() + randomUUID();
    const owner = new OwnerCommandService(
      new PostgresProjectFactory(pool),
      conversations,
      secret,
      new OrchestratorService(conversations),
    );
    const context = {
      authenticated: true as const,
      actorId: "proposal-gate-test",
      csrfToken: secret,
    };
    const idempotencyKey = randomUUID();
    const started = (await owner.startConversation(context, {
      title: "proposal gate drill",
      idempotencyKey,
      occurredAt: new Date().toISOString(),
    })) as { projectId: string; conversationId: string };

    const conversation = await conversations.conversation(
      started.projectId,
      started.conversationId,
    );
    assert.ok(conversation, "the drill conversation was not created");

    await owner.sendMessage(context, {
      projectId: started.projectId,
      conversationId: started.conversationId,
      content: "Build me a landing page for a dive shop, dark theme.",
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: conversation.version,
    });
    return started;
  }

  test("propose.ts stops at a proposal awaiting the owner, and generates nothing", async () => {
    const { conversationId } = await seedConversation();

    // The real script, run the way the system prompt tells the assistant to run
    // it -- not the service it wraps. The wiring is the part that was never
    // exercised.
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/propose.ts", conversationId],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    const result = JSON.parse(output) as { proposalId: string; state: string };

    // draft or owner_review -- either is "the owner has not approved this".
    // What must never appear is `approved` or `handed_off`.
    assert.ok(
      result.state === "draft" || result.state === "owner_review",
      `proposal landed in ${result.state}, which is past the gate`,
    );

    // The id must actually come back: the assistant is told to run this and
    // report to the owner, and a proposal nobody can reference is most of the
    // value gone. It printed `undefined` until M7, because the script read
    // `.id` from a service that returns `proposalId`.
    assert.match(result.proposalId, /^[a-f0-9-]{36}$/);

    const stored = await pool.query<{ state: string; approval_id: string }>(
      "SELECT state, approval_id FROM conversation_proposals WHERE id=$1",
      [result.proposalId],
    );
    assert.equal(stored.rows[0]?.state, result.state);
    // No approval exists, so nothing could have been approved.
    assert.equal(stored.rows[0]?.approval_id, null);

    // The gate is only worth anything if nothing downstream moved. A
    // translation task at this point would mean the proposal was paperwork
    // rather than a checkpoint.
    const handedOff = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM operation_task_specs
        WHERE driver='blueprint_translation'
          AND input->>'projectId'=(SELECT project_id::text FROM conversation_proposals WHERE id=$1)`,
      [result.proposalId],
    );
    assert.equal(handedOff.rows[0]?.count, "0");
  });

  test("propose.ts refuses a conversation that does not exist", async () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["--import", "tsx", "scripts/propose.ts", randomUUID()],
          {
            encoding: "utf8",
            stdio: "pipe",
            env: { ...process.env, DATABASE_URL: databaseUrl },
          },
        ),
      /Command failed/,
    );
  });

  test("propose.ts refuses an argument that is not a conversation id", async () => {
    // The id goes into a query. It is parameterised, but the shape is checked
    // before anything else runs, because an assistant composing this call from
    // a conversation is exactly the caller you do not want to trust.
    for (const argument of ["", "../../etc/passwd", "1; DROP TABLE tasks"])
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["--import", "tsx", "scripts/propose.ts", argument],
            {
              encoding: "utf8",
              stdio: "pipe",
              env: { ...process.env, DATABASE_URL: databaseUrl },
            },
          ),
        /Command failed/,
      );
  });

  after(() => pool.end());
}
