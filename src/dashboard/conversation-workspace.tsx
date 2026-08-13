import { useEffect, useRef, useState } from "react";
import { Panel, StatusBadge } from "./components.js";
import { MessageContent } from "./message-renderer.js";
import {
  startConversation,
  sendConversationMessage,
  listConversationMessages,
  listProjectConversations,
  getReplyTaskStatus,
  subscribeReplyStream,
  cancelReplyTask,
  uploadConversationAttachment,
  listConversationAttachments,
  draftProposal,
  approveProposal,
  rejectProposal,
  translateProposal,
  generateProject,
  renameConversation,
  setConversationArchived,
} from "./api.js";
import type {
  ConversationMessage,
  ConversationSummary,
  ConversationAttachment,
  ConversationProposal,
  ReplyStreamSubscription,
} from "./api.js";
import type { ProjectSummary } from "./types.js";

const REPLY_POLL_INTERVAL_MS = 1500;
const REPLY_POLL_MAX_ATTEMPTS = 60; // ~90s before giving up and letting the owner refresh by hand
const REPLY_STREAM_RECONNECT_DELAY_MS = 700;
const REPLY_STREAM_MAX_RECONNECTS = 8;
const THREAD_VIRTUALIZE_AFTER = 80;
const THREAD_ROW_ESTIMATE_PX = 116;
const THREAD_OVERSCAN_ROWS = 8;
const conversationModes = {
  auto: {
    label: "Auto",
    prefix: "",
    route:
      "Route: orchestration policy chooses DeepSeek Pro first, then governed fallback if verified failure requires it.",
    placeholder: "Ask for help, decisions, or implementation work.",
  },
  clarify_goals: {
    label: "Clarify goals",
    prefix:
      "Clarify goals mode: ask focused questions first. Do not draft a proposal or start implementation until the objective, users, scope, constraints, success criteria, and unknowns are clear.\n\n",
    route:
      "Route: clarify-goals uses the orchestration policy, starting with DeepSeek Pro. Fallback remains policy-gated; this mode does not bypass model controls.",
    placeholder:
      "Describe the outcome, users, constraints, and what is still uncertain.",
  },
} as const;
type ConversationMode = keyof typeof conversationModes;
const terminalReplyStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_blocked",
]);

function formatCost(costUsdMicros: number) {
  return `$${(costUsdMicros / 1_000_000).toFixed(6)}`;
}

function modelLabel(message: ConversationMessage) {
  const attribution = message.modelAttribution;
  if (attribution === undefined) return undefined;
  const model = attribution.resolvedModelId ?? attribution.requestedModelId;
  return `${attribution.provider} · ${model} · ${formatCost(attribution.costUsdMicros)}`;
}

function virtualWindowFor(
  scrollTop: number,
  viewportHeight: number,
  messageCount: number,
) {
  const visibleRows = Math.ceil(viewportHeight / THREAD_ROW_ESTIMATE_PX);
  const start = Math.max(
    0,
    Math.floor(scrollTop / THREAD_ROW_ESTIMATE_PX) - THREAD_OVERSCAN_ROWS,
  );
  const end = Math.min(
    messageCount,
    start + visibleRows + THREAD_OVERSCAN_ROWS * 2,
  );
  return { start, end };
}

function isThreadNearBottom(thread: HTMLDivElement) {
  return (
    thread.scrollHeight - thread.scrollTop - thread.clientHeight <
    THREAD_ROW_ESTIMATE_PX
  );
}

function applyConversationMode(draft: string, mode: ConversationMode) {
  const trimmed = draft.trim();
  const prefix = conversationModes[mode].prefix;
  if (prefix.length === 0 || trimmed.startsWith(prefix.trim())) return trimmed;
  return `${prefix}${trimmed}`.trim();
}

function generationStepState(
  step: "conversation" | "proposal" | "approval" | "blueprint" | "generation",
  input: {
    messageCount: number;
    proposal?: ConversationProposal;
    translationState: "idle" | "translating" | "succeeded" | "failed";
    generationTaskId?: string;
  },
) {
  if (step === "conversation")
    return input.messageCount > 0 ? "complete" : "current";
  if (step === "proposal") {
    if (input.proposal === undefined) return "pending";
    return input.proposal.state === "owner_review" ? "current" : "complete";
  }
  if (step === "approval") {
    if (input.proposal?.state === "handed_off") return "complete";
    if (input.proposal?.state === "owner_review") return "current";
    return "pending";
  }
  if (step === "blueprint") {
    if (input.translationState === "succeeded") return "complete";
    if (
      input.proposal?.state === "handed_off" &&
      input.translationState !== "succeeded"
    )
      return "current";
    return "pending";
  }
  if (input.generationTaskId !== undefined) return "complete";
  return input.translationState === "succeeded" ? "current" : "pending";
}

// Replaces the old bare "Generate project blueprint" form entirely
// (confirmed decision, CONTRACT-014 scope): the interview happens through
// a real conversation instead. A conversation can start with no project at
// all -- src/operations/owner-commands.ts's startConversation() bootstraps
// a real project in "idea" lifecycle state behind it (M1). Sending a
// message queues a real assistant reply through AiGateway (M2); it does
// not arrive synchronously, so this page polls the reply task's status
// rather than blocking on it.
export function ConversationWorkspacePage({
  csrfToken,
  projects,
}: {
  csrfToken: string;
  projects: ReadonlyArray<ProjectSummary>;
}) {
  const [startTitle, setStartTitle] = useState("");
  const [startProjectId, setStartProjectId] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [historyBusy, setHistoryBusy] = useState<string>();
  const [conversation, setConversation] = useState<{
    id: string;
    projectId: string;
    title: string;
  }>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [composerText, setComposerText] = useState("");
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>("auto");
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [activeReplyTaskId, setActiveReplyTaskId] = useState<string>();
  const [proposal, setProposal] = useState<ConversationProposal>();
  const [proposalBusy, setProposalBusy] = useState<
    "draft" | "approve" | "reject"
  >();
  const [translationState, setTranslationState] = useState<
    "idle" | "translating" | "succeeded" | "failed"
  >("idle");
  const [translationTaskId, setTranslationTaskId] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [generationTaskId, setGenerationTaskId] = useState<string>();
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 0 });
  const threadRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeReplyStreamRef = useRef<ReplyStreamSubscription>();
  const replyReconnectTimerRef = useRef<number>();
  const threadStickToBottomRef = useRef(true);
  const virtualizedThread = messages.length > THREAD_VIRTUALIZE_AFTER;
  const visibleMessages = virtualizedThread
    ? messages.slice(virtualWindow.start, virtualWindow.end)
    : messages;
  const spacerBeforePx = virtualizedThread
    ? virtualWindow.start * THREAD_ROW_ESTIMATE_PX
    : 0;
  const spacerAfterPx = virtualizedThread
    ? Math.max(0, messages.length - virtualWindow.end) * THREAD_ROW_ESTIMATE_PX
    : 0;

  useEffect(() => {
    const thread = threadRef.current;
    if (virtualizedThread) {
      if (thread && !threadStickToBottomRef.current) {
        setVirtualWindow(
          virtualWindowFor(
            thread.scrollTop,
            thread.clientHeight,
            messages.length,
          ),
        );
      } else {
        const visibleRows =
          Math.ceil((thread?.clientHeight || 460) / THREAD_ROW_ESTIMATE_PX) +
          THREAD_OVERSCAN_ROWS * 2;
        setVirtualWindow({
          start: Math.max(0, messages.length - visibleRows),
          end: messages.length,
        });
      }
    } else {
      setVirtualWindow({ start: 0, end: messages.length });
    }
    if (threadStickToBottomRef.current)
      threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, awaitingReply, virtualizedThread]);

  function syncVirtualWindow() {
    if (!virtualizedThread) return;
    const thread = threadRef.current;
    if (!thread) return;
    threadStickToBottomRef.current = isThreadNearBottom(thread);
    setVirtualWindow(
      virtualWindowFor(thread.scrollTop, thread.clientHeight, messages.length),
    );
  }

  function renderMessage(message: ConversationMessage) {
    const attribution =
      message.role === "assistant" ? modelLabel(message) : undefined;
    return (
      <div
        key={message.id}
        className={`chat-bubble chat-bubble--${message.role}`}
      >
        <span className="chat-bubble__role">{message.role}</span>
        <MessageContent content={message.content} />
        {attribution && (
          <span className="chat-bubble__meta">{attribution}</span>
        )}
        {message.role === "owner" && (
          <button
            type="button"
            className="chat-bubble__action"
            onClick={() => editMessage(message)}
          >
            Edit
          </button>
        )}
      </div>
    );
  }

  useEffect(
    () => () => {
      cancelActiveReplyStream();
    },
    [],
  );

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 260)}px`;
  }, [composerText]);

  function cancelActiveReplyStream() {
    activeReplyStreamRef.current?.close();
    activeReplyStreamRef.current = undefined;
    if (replyReconnectTimerRef.current !== undefined) {
      window.clearTimeout(replyReconnectTimerRef.current);
      replyReconnectTimerRef.current = undefined;
    }
  }

  async function refreshMessages(conversationId: string, projectId: string) {
    const [nextMessages, nextAttachments] = await Promise.all([
      listConversationMessages(conversationId, projectId),
      listConversationAttachments(conversationId, projectId),
    ]);
    setMessages(nextMessages);
    setAttachments(nextAttachments);
  }

  async function pollReply(
    taskId: string,
    conversationId: string,
    projectId: string,
  ) {
    for (let attempt = 0; attempt < REPLY_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, REPLY_POLL_INTERVAL_MS),
      );
      try {
        const status = await getReplyTaskStatus(taskId);
        if (terminalReplyStates.has(status.state)) {
          await refreshMessages(conversationId, projectId);
          if (status.state !== "succeeded")
            setError(
              `The assistant could not reply (task ${status.state}). Your message is saved -- try sending another.`,
            );
          setAwaitingReply(false);
          setStreamingReply("");
          setActiveReplyTaskId(undefined);
          return;
        }
      } catch {
        // A transient status-check failure isn't fatal -- keep polling
        // until the attempt budget runs out rather than aborting on one
        // network blip.
      }
    }
    setAwaitingReply(false);
    setStreamingReply("");
    setActiveReplyTaskId(undefined);
    setError(
      "Still waiting on the assistant -- refresh the page in a moment to check for a reply.",
    );
  }

  function followReplyStream(
    taskId: string,
    conversationId: string,
    projectId: string,
  ) {
    cancelActiveReplyStream();
    setAwaitingReply(true);
    setStreamingReply("");
    setActiveReplyTaskId(taskId);
    let settled = false;
    let lastOrdinal = 0;
    let reconnects = 0;

    function connect(afterOrdinal: number) {
      if (settled) return;
      activeReplyStreamRef.current?.close();
      try {
        activeReplyStreamRef.current = subscribeReplyStream(
          taskId,
          {
            onChunk: (chunk) => {
              if (settled || chunk.ordinal <= lastOrdinal) return;
              lastOrdinal = chunk.ordinal;
              setStreamingReply((current) => `${current}${chunk.fragment}`);
            },
            onDone: (done) => {
              settled = true;
              activeReplyStreamRef.current = undefined;
              void refreshMessages(conversationId, projectId).finally(() => {
                setAwaitingReply(false);
                setStreamingReply("");
                setActiveReplyTaskId(undefined);
                if (done.state !== "succeeded")
                  setError(
                    `The assistant could not reply (task ${done.state}). Your message is saved -- try sending another.`,
                  );
              });
            },
            onRetry: (retry) => {
              reconnects = 0;
              replyReconnectTimerRef.current = window.setTimeout(
                () => connect(Math.max(lastOrdinal, retry.after)),
                REPLY_STREAM_RECONNECT_DELAY_MS,
              );
            },
            onError: () => {
              if (settled) return;
              activeReplyStreamRef.current = undefined;
              if (reconnects < REPLY_STREAM_MAX_RECONNECTS) {
                reconnects += 1;
                replyReconnectTimerRef.current = window.setTimeout(
                  () => connect(lastOrdinal),
                  REPLY_STREAM_RECONNECT_DELAY_MS,
                );
                return;
              }
              settled = true;
              void pollReply(taskId, conversationId, projectId);
            },
          },
          afterOrdinal,
        );
      } catch {
        settled = true;
        void pollReply(taskId, conversationId, projectId);
      }
    }

    connect(0);
  }

  async function handleStart(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(undefined);
    try {
      const started = await startConversation(
        {
          title: startTitle.trim(),
          ...(startProjectId ? { projectId: startProjectId } : {}),
        },
        csrfToken,
      );
      setConversation({
        id: started.conversationId,
        projectId: started.projectId,
        title: started.title,
      });
      threadStickToBottomRef.current = true;
      cancelActiveReplyStream();
      setMessages([]);
      setAttachments([]);
      setAwaitingReply(false);
      setStreamingReply("");
      setActiveReplyTaskId(undefined);
      setProposal(undefined);
      setTranslationState("idle");
      setTranslationTaskId(undefined);
      setGenerationTaskId(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    await sendDraft(composerText, { clearComposer: true });
  }

  async function sendDraft(draft: string, options: { clearComposer: boolean }) {
    if (!conversation || draft.trim().length === 0 || sending || awaitingReply)
      return;
    const content = applyConversationMode(draft, conversationMode);
    const expectedVersion = messages.length;
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    const optimisticMessage: ConversationMessage = {
      id: optimisticId,
      conversationId: conversation.id,
      projectId: conversation.projectId,
      ordinal: expectedVersion + 1,
      role: "owner",
      content,
      classification: "public",
      contentSha256: "pending",
      createdAt: new Date().toISOString(),
    };
    setSending(true);
    setError(undefined);
    setMessages((current) => [...current, optimisticMessage]);
    if (options.clearComposer) setComposerText("");
    try {
      const result = await sendConversationMessage(
        conversation.id,
        {
          projectId: conversation.projectId,
          content,
          expectedVersion,
        },
        csrfToken,
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticId ? result.message : message,
        ),
      );
      await refreshMessages(conversation.id, conversation.projectId);
      followReplyStream(
        result.replyTaskId,
        conversation.id,
        conversation.projectId,
      );
    } catch (reason) {
      setMessages((current) =>
        current.filter((message) => message.id !== optimisticId),
      );
      if (options.clearComposer) setComposerText(draft);
      setError(
        reason instanceof Error ? reason.message : "Message was not sent.",
      );
    } finally {
      setSending(false);
    }
  }

  async function handleStopReply() {
    if (!activeReplyTaskId) return;
    setError(undefined);
    const taskId = activeReplyTaskId;
    try {
      await cancelReplyTask(taskId, csrfToken);
      cancelActiveReplyStream();
      setAwaitingReply(false);
      setStreamingReply("");
      setActiveReplyTaskId(undefined);
      if (conversation)
        await refreshMessages(conversation.id, conversation.projectId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stop failed.");
    }
  }

  function lastOwnerMessage() {
    return [...messages].reverse().find((message) => message.role === "owner");
  }

  function editMessage(message: ConversationMessage) {
    setComposerText(message.content);
    composerRef.current?.focus();
  }

  async function handleRegenerate() {
    const message = lastOwnerMessage();
    if (!message) return;
    await sendDraft(message.content, { clearComposer: false });
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!conversation || !file) return;
    setUploading(true);
    setError(undefined);
    try {
      await uploadConversationAttachment(
        conversation.id,
        conversation.projectId,
        file,
        csrfToken,
      );
      await refreshMessages(conversation.id, conversation.projectId);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Upload was rejected.",
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDraftProposal() {
    if (!conversation) return;
    setProposalBusy("draft");
    setError(undefined);
    try {
      const result = await draftProposal(
        conversation.id,
        { projectId: conversation.projectId },
        csrfToken,
      );
      setProposal({
        id: result.proposalId,
        conversationId: result.conversationId,
        projectId: conversation.projectId,
        version: result.version,
        state: result.state,
        contractCandidate: result.contractCandidate,
        candidateSha256: "",
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not draft a proposal.",
      );
    } finally {
      setProposalBusy(undefined);
    }
  }

  async function handleApprove() {
    if (!conversation || !proposal) return;
    setProposalBusy("approve");
    setError(undefined);
    try {
      const result = await approveProposal(
        proposal.id,
        {
          projectId: conversation.projectId,
          expectedVersion: proposal.version,
        },
        csrfToken,
      );
      setProposal({
        id: result.proposalId,
        conversationId: result.conversationId,
        projectId: result.projectId,
        version: proposal.version + 1,
        state: "handed_off",
        contractCandidate: result.contractCandidate,
        candidateSha256: result.candidateSha256,
        approvalId: result.approvalId,
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Approval was not accepted.",
      );
    } finally {
      setProposalBusy(undefined);
    }
  }

  async function pollTranslation(taskId: string) {
    for (let attempt = 0; attempt < REPLY_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, REPLY_POLL_INTERVAL_MS),
      );
      try {
        const status = await getReplyTaskStatus(taskId);
        if (terminalReplyStates.has(status.state)) {
          setTranslationState(
            status.state === "succeeded" ? "succeeded" : "failed",
          );
          if (status.state !== "succeeded")
            setError(
              `Blueprint translation did not succeed (task ${status.state}). The approved proposal is unaffected -- try again.`,
            );
          return;
        }
      } catch {
        // Transient status-check failure -- keep polling within budget,
        // same tolerance as pollReply().
      }
    }
    setTranslationState("failed");
    setError(
      "Still translating -- refresh the page in a moment to check progress.",
    );
  }

  async function handleTranslate() {
    if (!conversation || !proposal) return;
    setTranslationState("translating");
    setError(undefined);
    try {
      const result = await translateProposal(
        proposal.id,
        { projectId: conversation.projectId },
        csrfToken,
      );
      setTranslationTaskId(result.taskId);
      void pollTranslation(result.taskId);
    } catch (reason) {
      setTranslationState("idle");
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not start translation.",
      );
    }
  }

  async function handleGenerate() {
    if (!conversation) return;
    setGenerating(true);
    setError(undefined);
    try {
      const result = await generateProject(conversation.projectId, csrfToken);
      setGenerationTaskId(result.taskId);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Generation could not be queued.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleReject() {
    if (!conversation || !proposal) return;
    setProposalBusy("reject");
    setError(undefined);
    try {
      const result = await rejectProposal(
        proposal.id,
        {
          projectId: conversation.projectId,
          expectedVersion: proposal.version,
        },
        csrfToken,
      );
      setProposal(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Rejection was not accepted.",
      );
    } finally {
      setProposalBusy(undefined);
    }
  }

  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    void listProjectConversations(conversation.projectId, {
      ...(historySearch.trim() ? { search: historySearch.trim() } : {}),
      includeArchived: showArchived,
    })
      .then((value) => {
        if (!cancelled) setHistory(value);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation, historySearch, showArchived]);

  async function refreshHistory() {
    if (!conversation) return;
    try {
      setHistory(
        await listProjectConversations(conversation.projectId, {
          ...(historySearch.trim() ? { search: historySearch.trim() } : {}),
          includeArchived: showArchived,
        }),
      );
    } catch {
      // Leave the current list showing rather than clearing it on a
      // transient refresh failure.
    }
  }

  async function handleRename(item: ConversationSummary) {
    if (!conversation || renameDraft.trim().length === 0) return;
    setHistoryBusy(item.id);
    setError(undefined);
    try {
      await renameConversation(
        item.id,
        {
          projectId: item.projectId,
          title: renameDraft.trim(),
          expectedVersion: item.version,
        },
        csrfToken,
      );
      setRenamingId(undefined);
      await refreshHistory();
      if (item.id === conversation.id)
        setConversation({ ...conversation, title: renameDraft.trim() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rename failed.");
    } finally {
      setHistoryBusy(undefined);
    }
  }

  async function handleToggleArchive(item: ConversationSummary) {
    setHistoryBusy(item.id);
    setError(undefined);
    try {
      await setConversationArchived(
        item.id,
        {
          projectId: item.projectId,
          archived: item.archivedAt === undefined,
          expectedVersion: item.version,
        },
        csrfToken,
      );
      await refreshHistory();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Archive change failed.",
      );
    } finally {
      setHistoryBusy(undefined);
    }
  }

  async function handleResume(item: ConversationSummary) {
    setConversation({
      id: item.id,
      projectId: item.projectId,
      title: item.title,
    });
    threadStickToBottomRef.current = true;
    setProposal(undefined);
    setTranslationState("idle");
    setTranslationTaskId(undefined);
    setGenerationTaskId(undefined);
    cancelActiveReplyStream();
    setAwaitingReply(false);
    setStreamingReply("");
    setActiveReplyTaskId(undefined);
    try {
      await refreshMessages(item.id, item.projectId);
    } catch {
      setMessages([]);
      setAttachments([]);
    }
  }

  return (
    <div className="page">
      <header className="page-title">
        <p className="eyebrow">OWNER WORKSPACE</p>
        <h1>Orchestrator</h1>
        <p>
          Chat through what you want to build. Nothing here executes anything --
          a conversation only ever produces context and, once you approve it, a
          reviewed proposal.
        </p>
      </header>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {!conversation ? (
        <Panel title="Start a conversation" eyebrow="NEW">
          <form
            className="settings-grid"
            onSubmit={(event) => void handleStart(event)}
          >
            <label>
              What are you working on?
              <input
                aria-label="Conversation title"
                value={startTitle}
                onChange={(event) => setStartTitle(event.target.value)}
                placeholder="e.g. Vendor invoice tracker"
                maxLength={200}
                required
              />
            </label>
            <label>
              Folder (existing project) -- leave blank to start a new one
              <select
                aria-label="Existing project folder"
                value={startProjectId}
                onChange={(event) => setStartProjectId(event.target.value)}
              >
                <option value="">New project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {project.lifecycle}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-actions">
              <button type="submit" disabled={starting}>
                {starting ? "Starting…" : "Start"}
              </button>
            </div>
          </form>
        </Panel>
      ) : (
        <div className="dashboard-grid">
          <Panel
            title={conversation.title}
            eyebrow="CONVERSATION"
            actions={
              <StatusBadge label={`v${messages.length}`} tone="neutral" />
            }
          >
            <div
              className="chat-thread"
              ref={threadRef}
              onScroll={syncVirtualWindow}
            >
              {messages.length === 0 && (
                <p className="empty">
                  Send the first message to start the interview.
                </p>
              )}
              {spacerBeforePx > 0 && (
                <div
                  className="chat-thread__spacer"
                  style={{ height: spacerBeforePx }}
                  aria-hidden="true"
                />
              )}
              {visibleMessages.map(renderMessage)}
              {awaitingReply && (
                <div
                  className="chat-bubble chat-bubble--assistant chat-bubble--pending"
                  aria-live="polite"
                >
                  <span className="chat-bubble__role">assistant</span>
                  <MessageContent content={streamingReply || "Thinking…"} />
                </div>
              )}
              {spacerAfterPx > 0 && (
                <div
                  className="chat-thread__spacer"
                  style={{ height: spacerAfterPx }}
                  aria-hidden="true"
                />
              )}
              <div ref={threadEndRef} />
            </div>
            <form
              ref={composerFormRef}
              className="composer"
              onSubmit={(event) => void handleSend(event)}
            >
              <div className="conversation-mode">
                <fieldset
                  className="mode-segments"
                  aria-label="Conversation mode"
                  disabled={sending || awaitingReply}
                >
                  <legend>Mode</legend>
                  {Object.entries(conversationModes).map(
                    ([value, modeDefinition]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="conversation-mode"
                          value={value}
                          checked={conversationMode === value}
                          onChange={() =>
                            setConversationMode(value as ConversationMode)
                          }
                        />
                        <span>{modeDefinition.label}</span>
                      </label>
                    ),
                  )}
                </fieldset>
                <p className="mode-route" aria-live="polite">
                  {conversationModes[conversationMode].route}
                </p>
              </div>
              <label>
                Message
                <textarea
                  ref={composerRef}
                  aria-label="Message"
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  placeholder={conversationModes[conversationMode].placeholder}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      composerFormRef.current?.requestSubmit();
                    }
                  }}
                  rows={1}
                  maxLength={20_000}
                  required
                />
              </label>
              <div className="settings-actions">
                {awaitingReply && (
                  <button type="button" onClick={() => void handleStopReply()}>
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleRegenerate()}
                  disabled={sending || awaitingReply || !lastOwnerMessage()}
                >
                  Regenerate
                </button>
                <button
                  type="submit"
                  disabled={
                    sending || awaitingReply || composerText.trim().length === 0
                  }
                >
                  {sending ? "Sending…" : "Send"}
                </button>
                <label className="attachment-upload">
                  {uploading ? "Uploading…" : "Attach a file"}
                  <input
                    ref={fileInputRef}
                    type="file"
                    aria-label="Attach a file"
                    onChange={(event) => void handleUpload(event)}
                    disabled={uploading}
                  />
                </label>
              </div>
            </form>
            {attachments.length > 0 && (
              <ul className="attachment-list">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    {attachment.displayName}{" "}
                    <StatusBadge
                      label={attachment.state}
                      tone={attachment.state === "scanned" ? "good" : "neutral"}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel
            title="Proposal"
            eyebrow="REVIEW"
            actions={
              proposal && (
                <StatusBadge
                  label={proposal.state}
                  tone={
                    proposal.state === "handed_off"
                      ? "good"
                      : proposal.state === "rejected"
                        ? "danger"
                        : "warning"
                  }
                />
              )
            }
          >
            <p>
              Drafting a proposal compiles the conversation so far into a brief.
              Nothing executes until you approve it here -- approving hands it
              off as the frozen basis for generation.
            </p>
            <ol
              className="generation-flow"
              aria-label="Project generation flow"
            >
              {[
                {
                  key: "conversation",
                  label: "Conversation",
                  detail:
                    messages.length > 0
                      ? `${messages.length} saved turn${messages.length === 1 ? "" : "s"}`
                      : "Waiting for the first message",
                },
                {
                  key: "proposal",
                  label: "Proposal",
                  detail: proposal?.id ?? "Not drafted",
                },
                {
                  key: "approval",
                  label: "Owner approval",
                  detail: proposal?.approvalId ?? proposal?.state ?? "Pending",
                },
                {
                  key: "blueprint",
                  label: "Blueprint translation",
                  detail:
                    translationTaskId ??
                    (translationState === "idle"
                      ? "Not queued"
                      : translationState),
                },
                {
                  key: "generation",
                  label: "Code generation",
                  detail: generationTaskId ?? "Not queued",
                },
              ].map((step) => (
                <li
                  key={step.key}
                  className={`generation-flow__step generation-flow__step--${generationStepState(
                    step.key as
                      | "conversation"
                      | "proposal"
                      | "approval"
                      | "blueprint"
                      | "generation",
                    {
                      messageCount: messages.length,
                      proposal,
                      translationState,
                      generationTaskId,
                    },
                  )}`}
                >
                  <span>{step.label}</span>
                  <small>{step.detail}</small>
                </li>
              ))}
            </ol>
            {!proposal ? (
              <div className="settings-actions">
                <button
                  type="button"
                  disabled={proposalBusy !== undefined || messages.length === 0}
                  onClick={() => void handleDraftProposal()}
                >
                  {proposalBusy === "draft" ? "Drafting…" : "Draft a proposal"}
                </button>
              </div>
            ) : (
              <>
                <pre className="proposal-candidate">
                  {proposal.contractCandidate}
                </pre>
                {proposal.state === "owner_review" && (
                  <div className="settings-actions">
                    <button
                      type="button"
                      disabled={proposalBusy !== undefined}
                      onClick={() => void handleApprove()}
                    >
                      {proposalBusy === "approve" ? "Approving…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={proposalBusy !== undefined}
                      onClick={() => void handleReject()}
                    >
                      {proposalBusy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  </div>
                )}
                {proposal.state === "handed_off" && proposal.approvalId && (
                  <>
                    <output aria-live="polite">
                      Approved · {proposal.approvalId}
                    </output>
                    <div className="settings-actions">
                      {translationState !== "succeeded" && (
                        <button
                          type="button"
                          disabled={translationState === "translating"}
                          onClick={() => void handleTranslate()}
                        >
                          {translationState === "translating"
                            ? "Translating…"
                            : translationState === "failed"
                              ? "Retry translation"
                              : "Translate to blueprint"}
                        </button>
                      )}
                      {translationState === "succeeded" && (
                        <button
                          type="button"
                          disabled={
                            generating || generationTaskId !== undefined
                          }
                          onClick={() => void handleGenerate()}
                        >
                          {generating
                            ? "Queuing…"
                            : generationTaskId
                              ? "Generation queued"
                              : "Start code generation"}
                        </button>
                      )}
                    </div>
                    {translationState === "succeeded" && (
                      <p>
                        <small>
                          Blueprint published -- the project moved from{" "}
                          <code>idea</code> to <code>blueprint</code>.
                        </small>
                      </p>
                    )}
                    {translationTaskId && (
                      <output aria-live="polite">
                        Translation task · {translationTaskId}
                      </output>
                    )}
                    {generationTaskId && (
                      <output aria-live="polite">
                        Generation queued · task {generationTaskId}
                      </output>
                    )}
                  </>
                )}
              </>
            )}
          </Panel>
          <Panel title="Conversations in this folder" eyebrow="HISTORY">
            <div className="settings-grid">
              <label>
                Search
                <input
                  aria-label="Search conversations"
                  value={historySearch}
                  onChange={(event) => setHistorySearch(event.target.value)}
                  placeholder="Filter by title…"
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />{" "}
                Show archived
              </label>
            </div>
            {history.length === 0 ? (
              <p className="empty">No conversations match.</p>
            ) : (
              <ul className="attachment-list">
                {history.map((item) => (
                  <li key={item.id}>
                    {renamingId === item.id ? (
                      <span className="history-rename">
                        <input
                          aria-label={`Rename ${item.title}`}
                          value={renameDraft}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          maxLength={200}
                        />
                        <button
                          type="button"
                          disabled={historyBusy === item.id}
                          onClick={() => void handleRename(item)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(undefined)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="history-title"
                          onClick={() => void handleResume(item)}
                        >
                          {item.title}
                        </button>{" "}
                        <small>
                          {new Date(item.createdAt).toLocaleString()}
                        </small>{" "}
                        {item.archivedAt && (
                          <StatusBadge label="archived" tone="neutral" />
                        )}
                        <button
                          type="button"
                          disabled={historyBusy === item.id}
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameDraft(item.title);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={historyBusy === item.id}
                          onClick={() => void handleToggleArchive(item)}
                        >
                          {item.archivedAt ? "Unarchive" : "Archive"}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
