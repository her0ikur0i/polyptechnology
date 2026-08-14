import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deterministicUuid } from "../deterministic-id.js";
import type { OwnerCommandService } from "../operations/owner-commands.js";
import type { ConversationStore } from "../orchestrator/types.js";
import { acceptAttachmentUpload } from "../control-api/attachment-upload.js";
import type { TelegramFileDownloader, TelegramRequester } from "./gateway.js";
import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";

// Every Telegram message lands in one long-running conversation per chat rather
// than a new one each time, because that is what a chat *is*. The key is stable
// so startConversation()'s idempotency returns the same conversation and
// project on every call -- no extra table, and no risk of the id drifting from
// whatever the notifier is watching for.
// The system prompt's fingerprint used to be part of this key, so that
// changing the prompt started a whole new thread. That was a workaround for
// whole-transcript replay: the model read its own past turns claiming it had
// no tools and stayed consistent with them, answering a question correctly and
// recanting it nine seconds later.
//
// CONTRACT-017A removes the cause. A resumed turn sends only the new message,
// so there is no transcript to contradict anything, and the owner keeps their
// thread across a prompt change instead of losing it. The precedence sentence
// in SYSTEM_PROMPT covers the remaining case — a cold start with no session,
// which still replays history.
export const telegramConversationKey = (chatId: string) =>
  deterministicUuid(`telegram:conversation:${chatId}`);

// The actor recorded against everything that arrives this way. Distinct from a
// dashboard session on purpose: the audit trail should say where a message came
// from.
export const TELEGRAM_ACTOR = "owner-telegram";

export interface TelegramConversationDeps {
  owner: OwnerCommandService;
  conversations: ConversationStore;
  requester: TelegramRequester;
  csrfSecret: string;
  // File upload support. Both optional so the handler keeps working where
  // neither is configured, degrading to a text-only surface.
  downloader?: TelegramFileDownloader;
  attachmentStorageRoot?: string;
}

// Turns a Telegram message into a real conversation turn.
//
// The authority boundary this must not bend: a message arriving here gains
// exactly the authority the same message typed into the dashboard would gain,
// and not one step more. It becomes an ordinary conversation message,
// classified and stored the same way, and the reply is queued as a background
// task through the same queueConversationReply() path.
//
// That authority is no longer "none". Since CONTRACT-017 Amendment 1 the
// assistant answering these messages has tools and a working directory, at the
// owner's instruction -- so the equivalence above is the whole guarantee, not a
// footnote to a stronger one. The factory's generation pipeline still requires
// the draft -> owner_review -> approved -> handed_off proposal gate; a chat
// cannot reach it.
//
// What follows from that: the poller's identity check is the security boundary
// for this path, and it runs before anything here is called.
//
// It routes through OwnerCommandService rather than the stores directly, so the
// same authorize() and the same validation run. Reaching past it "because we
// already checked identity in the poller" is how a second, weaker door gets
// built.
export class TelegramConversationHandler implements TelegramUpdateHandler {
  constructor(private readonly deps: TelegramConversationDeps) {}

  async handle(update: unknown, origin: UpdateOrigin): Promise<void> {
    if (origin.chatId === undefined) return;
    const text = messageTextOf(update);
    const file = fileOf(update);
    if (text === undefined && file === undefined) return;

    // Commands belong to M6's closed set. Handing "/status" to the interviewer
    // as conversation would be a confusing non-answer.
    if (text !== undefined && text.startsWith("/")) return;

    const context = {
      authenticated: true as const,
      actorId: TELEGRAM_ACTOR,
      csrfToken: this.deps.csrfSecret,
    };
    const idempotencyKey = telegramConversationKey(origin.chatId);
    const projectId = deterministicUuid(
      `${TELEGRAM_ACTOR}:${idempotencyKey}:project`,
    );
    const conversationId = deterministicUuid(
      `${TELEGRAM_ACTOR}:${idempotencyKey}:conversation`,
    );

    // Look first, create only if absent.
    //
    // Calling startConversation() on every message looked idempotent because
    // the key is stable, and it is not: the store compares the whole *intent*,
    // and `occurredAt` changes every call. So the first Telegram message
    // created the conversation and every message after it was rejected with
    // "idempotency intent mismatch" before anything else could run -- no
    // reply, and no acknowledgement either, because the throw happened first.
    //
    // The ids are derived the same way OwnerCommandService derives them, which
    // is what makes the lookup possible without storing a mapping anywhere.
    let conversation = await this.deps.conversations.conversation(
      projectId,
      conversationId,
    );
    if (conversation === undefined) {
      await this.deps.owner.startConversation(context, {
        title: "Telegram",
        idempotencyKey,
        occurredAt: new Date().toISOString(),
      });
      conversation = await this.deps.conversations.conversation(
        projectId,
        conversationId,
      );
      if (conversation === undefined) return;
    }

    const started = { projectId, conversationId };

    // A file arrives as a project reference: download it, store it as a
    // conversation attachment, and note it. The caption, if any, is still
    // stored as an ordinary message.
    if (file !== undefined) await this.ingestFile(origin.chatId, started, file);
    if (text !== undefined)
      await this.deps.owner.sendMessage(context, {
        conversationId: started.conversationId,
        projectId: started.projectId,
        content: text,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        expectedVersion: conversation.version,
      });

    // The reply is a background task and will not be immediate. Saying so beats
    // leaving the owner watching an empty chat wondering whether it arrived.
    await this.acknowledge(origin.chatId);
  }

  private async ingestFile(
    chatId: string,
    started: { projectId: string; conversationId: string },
    file: IncomingFile,
  ) {
    const { downloader, attachmentStorageRoot } = this.deps;
    if (downloader === undefined || attachmentStorageRoot === undefined) {
      await this.note(
        chatId,
        "File diterima, tapi upload file belum aktif di server ini.",
      );
      return;
    }
    try {
      const info = (await this.deps.requester.call("getFile", {
        file_id: file.fileId,
      })) as { result?: { file_path?: string } };
      const filePath = info?.result?.file_path;
      if (filePath === undefined) throw new Error("getFile missing file_path");
      const bytes = await downloader.downloadFile(filePath);
      await mkdir(attachmentStorageRoot, { recursive: true });
      const storedFilename = randomUUID();
      const storedPath = join(attachmentStorageRoot, storedFilename);
      await writeFile(storedPath, bytes);
      await acceptAttachmentUpload(this.deps.conversations, {
        conversationId: started.conversationId,
        projectId: started.projectId,
        storedPath,
        storedFilename,
        displayName: file.displayName,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes > 0 ? file.sizeBytes : bytes.length,
      });
      await this.note(chatId, `File diterima: ${file.displayName}`);
    } catch (error) {
      // The owner sent a real file; failing to store it must not crash the
      // poller. Logged, and the owner is told rather than left guessing.
      console.error(
        JSON.stringify({
          event: "telegram.file.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
      await this.note(chatId, "File gagal diproses, coba lagi ya Bos.");
    }
  }

  private async note(chatId: string, text: string) {
    try {
      await this.deps.requester.call("sendMessage", { chat_id: chatId, text });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "telegram.note.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  private async acknowledge(chatId: string) {
    try {
      // The native "typing…" indicator, not a message. It animates on its own
      // and disappears by itself the moment the reply arrives -- exactly what a
      // persistent "⏳ Siap Bos, diproses dulu…" text could not do (that line
      // stayed in the chat forever next to the answer).
      await this.deps.requester.call("sendChatAction", {
        chat_id: chatId,
        action: "typing",
      });
    } catch (error) {
      // The message is already stored and the reply already queued. Failing to
      // say "working on it" must not undo that, but it is logged rather than
      // swallowed -- silence here is what hid the approval-button bug.
      console.error(
        JSON.stringify({
          event: "telegram.acknowledge.failed",
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

// Plain text only. Photos, stickers and edits carry no text this system can
// treat as a conversation turn, and guessing at them would put unpredictable
// content into an authority-bearing channel.
function messageTextOf(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const message = (update as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const text = message?.text;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  // The upper bound matches OwnerCommandService.sendMessage()'s own limit, so
  // an oversized message is refused here with a clear reason rather than
  // throwing out of the command service.
  return trimmed.length > 0 && trimmed.length <= 20_000 ? trimmed : undefined;
}

interface IncomingFile {
  fileId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

// Extracts a document or photo the owner sent, for storage as a project
// reference. A photo resolves to its largest resolution, which Telegram lists
// last in the array.
function fileOf(update: unknown): IncomingFile | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const message = (update as Record<string, unknown>).message as
    Record<string, unknown> | undefined;
  const document = message?.document as Record<string, unknown> | undefined;
  if (document !== undefined && typeof document.file_id === "string") {
    return {
      fileId: document.file_id,
      displayName:
        typeof document.file_name === "string"
          ? document.file_name
          : "document",
      mediaType:
        typeof document.mime_type === "string"
          ? document.mime_type
          : "application/octet-stream",
      sizeBytes:
        typeof document.file_size === "number" ? document.file_size : 0,
    };
  }
  const photo = message?.photo;
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = photo[photo.length - 1] as Record<string, unknown>;
    if (largest !== undefined && typeof largest.file_id === "string") {
      return {
        fileId: largest.file_id,
        displayName: "photo.jpg",
        mediaType: "image/jpeg",
        sizeBytes:
          typeof largest.file_size === "number" ? largest.file_size : 0,
      };
    }
  }
  return undefined;
}
