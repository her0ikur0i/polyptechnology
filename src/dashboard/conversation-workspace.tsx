import { useEffect, useRef, useState } from "react";
import { Panel, StatusBadge } from "./components.js";
import {
  startConversation,
  sendConversationMessage,
  listConversationMessages,
  listProjectConversations,
  getReplyTaskStatus,
  subscribeReplyStream,
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
const terminalReplyStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_blocked",
]);

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
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [proposal, setProposal] = useState<ConversationProposal>();
  const [proposalBusy, setProposalBusy] = useState<
    "draft" | "approve" | "reject"
  >();
  const [translationState, setTranslationState] = useState<
    "idle" | "translating" | "succeeded" | "failed"
  >("idle");
  const [generating, setGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<string>();
  const threadEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeReplyStreamRef = useRef<ReplyStreamSubscription>();

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, awaitingReply]);

  useEffect(
    () => () => {
      activeReplyStreamRef.current?.close();
    },
    [],
  );

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
    setError(
      "Still waiting on the assistant -- refresh the page in a moment to check for a reply.",
    );
  }

  function followReplyStream(
    taskId: string,
    conversationId: string,
    projectId: string,
  ) {
    activeReplyStreamRef.current?.close();
    setAwaitingReply(true);
    setStreamingReply("");
    let settled = false;
    let lastOrdinal = 0;
    try {
      activeReplyStreamRef.current = subscribeReplyStream(taskId, {
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
            if (done.state !== "succeeded")
              setError(
                `The assistant could not reply (task ${done.state}). Your message is saved -- try sending another.`,
              );
          });
        },
        onError: () => {
          if (settled) return;
          settled = true;
          activeReplyStreamRef.current = undefined;
          void pollReply(taskId, conversationId, projectId);
        },
      });
    } catch {
      void pollReply(taskId, conversationId, projectId);
    }
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
      setMessages([]);
      setAttachments([]);
      setAwaitingReply(false);
      setStreamingReply("");
      setProposal(undefined);
      setTranslationState("idle");
      setGenerationResult(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!conversation || composerText.trim().length === 0) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await sendConversationMessage(
        conversation.id,
        {
          projectId: conversation.projectId,
          content: composerText,
          expectedVersion: messages.length,
        },
        csrfToken,
      );
      setComposerText("");
      await refreshMessages(conversation.id, conversation.projectId);
      followReplyStream(
        result.replyTaskId,
        conversation.id,
        conversation.projectId,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Message was not sent.",
      );
    } finally {
      setSending(false);
    }
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
      setGenerationResult(`queued · task ${result.taskId}`);
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
    setProposal(undefined);
    setTranslationState("idle");
    setGenerationResult(undefined);
    activeReplyStreamRef.current?.close();
    activeReplyStreamRef.current = undefined;
    setAwaitingReply(false);
    setStreamingReply("");
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
            <div className="chat-thread">
              {messages.length === 0 && (
                <p className="empty">
                  Send the first message to start the interview.
                </p>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`chat-bubble chat-bubble--${message.role}`}
                >
                  <span className="chat-bubble__role">{message.role}</span>
                  <p>{message.content}</p>
                </div>
              ))}
              {awaitingReply && (
                <div
                  className="chat-bubble chat-bubble--assistant chat-bubble--pending"
                  aria-live="polite"
                >
                  <span className="chat-bubble__role">assistant</span>
                  <p>{streamingReply || "Thinking…"}</p>
                </div>
              )}
              <div ref={threadEndRef} />
            </div>
            <form
              className="settings-grid"
              onSubmit={(event) => void handleSend(event)}
            >
              <label>
                Message
                <textarea
                  aria-label="Message"
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  rows={3}
                  maxLength={20_000}
                  required
                />
              </label>
              <div className="settings-actions">
                <button
                  type="submit"
                  disabled={sending || composerText.trim().length === 0}
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
                            generating || generationResult !== undefined
                          }
                          onClick={() => void handleGenerate()}
                        >
                          {generating
                            ? "Queuing…"
                            : generationResult
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
                    {generationResult && (
                      <output aria-live="polite">{generationResult}</output>
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
