import { randomUUID } from "node:crypto";
import pg from "pg";
import { OwnerCommandService } from "../src/operations/owner-commands.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { PostgresConversationStore } from "../src/orchestrator/postgres-store.js";
import { PostgresProjectFactory } from "../src/factory/postgres-repository.js";

// Turns the conversation the assistant is currently in into a proposal awaiting
// the owner's approval.
//
// This exists so the assistant can close the loop the factory is for: the owner
// describes what they want, they agree on it in conversation, and that
// agreement becomes work the factory performs -- rather than stopping at a
// document the assistant wrote by hand.
//
// It deliberately stops at "awaiting approval". Drafting a proposal is not
// authorising one: the owner still approves before anything is translated into
// a blueprint or generated. That gate is the reason the assistant having tools
// does not mean the factory builds whatever a chat suggests.
//
// Usage (the assistant is told its own conversation id):
//   node --import tsx scripts/propose.ts <conversationId>
async function main() {
  const conversationId = process.argv[2];
  if (conversationId === undefined || !/^[a-f0-9-]{36}$/.test(conversationId)) {
    console.error("usage: propose.ts <conversationId>");
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const found = await pool.query(
      "SELECT project_id FROM conversations WHERE id = $1",
      [conversationId],
    );
    const row = found.rows[0] as { project_id: string } | undefined;
    if (row === undefined) {
      console.error(`no conversation ${conversationId}`);
      process.exitCode = 1;
      return;
    }

    const conversations = new PostgresConversationStore(pool);
    // The CSRF token is a browser-form defence and this is not a browser. It is
    // generated locally and handed to both sides so OwnerCommandService's
    // authorize() is satisfied structurally -- the same reasoning recorded in
    // sequence-main.ts. Reaching past the service to the store instead would
    // build a second, weaker door.
    const secret = randomUUID() + randomUUID();
    const owner = new OwnerCommandService(
      new PostgresProjectFactory(pool),
      conversations,
      secret,
      new OrchestratorService(conversations),
    );

    const proposal = await owner.draftProposal(
      { authenticated: true, actorId: "assistant-proposal", csrfToken: secret },
      {
        projectId: row.project_id,
        conversationId,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
      },
    );

    console.log(
      JSON.stringify(
        {
          // draftProposal() returns `proposalId`, not `id`. Reading `id` here
          // printed `undefined` on every run -- found the first time this
          // script was ever executed, at M7. The assistant is told to run it
          // and report back, so a proposal the owner cannot reference by id is
          // most of the value gone.
          proposalId: (proposal as { proposalId?: string }).proposalId,
          state: (proposal as { state?: string }).state,
          note: "Awaiting the owner's approval. Nothing is generated until they approve.",
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void main();
