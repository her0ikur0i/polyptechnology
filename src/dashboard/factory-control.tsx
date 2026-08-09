import { useState } from "react";
import {
  createConversationProposal,
  createFactoryProject,
  generateProject,
} from "./api.js";
export function FactoryControlPage({ csrfToken }: { csrfToken: string }) {
  const [conversation, setConversation] = useState({
      projectId: "",
      title: "",
      objective: "",
    }),
    [project, setProject] = useState({
      slug: "",
      displayName: "",
      runtime: "node-22",
      framework: "react",
      database: "postgresql",
      requirements: "",
    }),
    [conversationResult, setConversationResult] = useState<string>(),
    [projectResult, setProjectResult] = useState<string>(),
    [createdProjectId, setCreatedProjectId] = useState<string>(),
    [generationResult, setGenerationResult] = useState<string>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState<"conversation" | "project" | "generate">();
  return (
    <div className="page">
      <header className="page-title">
        <p className="eyebrow">OWNER WORKSPACE</p>
        <h1>Orchestrator &amp; Project Factory</h1>
        <p>
          Create a reviewed contract proposal or an isolated dynamic project
          blueprint. Neither form grants production authority.
        </p>
      </header>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <div className="settings-grid factory-control-grid">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy("conversation");
            setError(undefined);
            void createConversationProposal(conversation, csrfToken)
              .then((value) =>
                setConversationResult(`${value.state} · ${value.proposalId}`),
              )
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error ? reason.message : "Proposal failed.",
                ),
              )
              .finally(() => setBusy(undefined));
          }}
        >
          <h2>Reviewed contract proposal</h2>
          <label>
            Project ID
            <input
              value={conversation.projectId}
              onChange={(event) =>
                setConversation({
                  ...conversation,
                  projectId: event.target.value,
                })
              }
              pattern="[a-f0-9-]{36}"
              required
            />
          </label>
          <label>
            Conversation title
            <input
              value={conversation.title}
              onChange={(event) =>
                setConversation({ ...conversation, title: event.target.value })
              }
              maxLength={200}
              required
            />
          </label>
          <label>
            Project objective
            <textarea
              value={conversation.objective}
              onChange={(event) =>
                setConversation({
                  ...conversation,
                  objective: event.target.value,
                })
              }
              maxLength={5000}
              required
            />
          </label>
          <p>
            Creates a draft for owner review. Execution remains disabled until
            the proposal passes policy and approval.
          </p>
          <button type="submit" disabled={busy !== undefined}>
            Create proposal
          </button>
          {conversationResult && (
            <output aria-live="polite">{conversationResult}</output>
          )}
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy("project");
            setError(undefined);
            void createFactoryProject(
              {
                ...project,
                requirements: project.requirements
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
              },
              csrfToken,
            )
              .then((value) => {
                setProjectResult(
                  `${value.state} · ${value.projectId} · ${value.repositoryRef}`,
                );
                setCreatedProjectId(value.projectId);
                setGenerationResult(undefined);
              })
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Project creation failed.",
                ),
              )
              .finally(() => setBusy(undefined));
          }}
        >
          <h2>Generate isolated project blueprint</h2>
          <label>
            Project name
            <input
              value={project.displayName}
              onChange={(event) =>
                setProject({ ...project, displayName: event.target.value })
              }
              maxLength={200}
              required
            />
          </label>
          <label>
            Slug
            <input
              value={project.slug}
              onChange={(event) =>
                setProject({
                  ...project,
                  slug: event.target.value.toLowerCase(),
                })
              }
              pattern="[a-z][a-z0-9-]{0,62}"
              required
            />
          </label>
          <label>
            Runtime
            <input
              value={project.runtime}
              onChange={(event) =>
                setProject({ ...project, runtime: event.target.value })
              }
              required
            />
          </label>
          <label>
            Framework
            <input
              value={project.framework}
              onChange={(event) =>
                setProject({ ...project, framework: event.target.value })
              }
              required
            />
          </label>
          <label>
            Database
            <input
              value={project.database}
              onChange={(event) =>
                setProject({ ...project, database: event.target.value })
              }
              required
            />
          </label>
          <label>
            Requirements, one per line
            <textarea
              value={project.requirements}
              onChange={(event) =>
                setProject({ ...project, requirements: event.target.value })
              }
              maxLength={10000}
              required
            />
          </label>
          <p>
            Creates versioned blueprint and project records with isolated
            repository, workspace, database, secret, and budget references.
          </p>
          <button type="submit" disabled={busy !== undefined}>
            Generate project blueprint
          </button>
          {projectResult && <output aria-live="polite">{projectResult}</output>}
        </form>
      </div>
      {createdProjectId && (
        <div className="settings-grid">
          <h2>Start code generation</h2>
          <p>
            Routes an initial scaffold through the DeepSeek -&gt; Codex -&gt;
            Claude execution engine (CONTRACT-011/CONTRACT-013). Runs
            asynchronously -- the task is queued for the supervisor, not
            executed inline here.
          </p>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => {
              setBusy("generate");
              setError(undefined);
              void generateProject(createdProjectId, csrfToken)
                .then((value) =>
                  setGenerationResult(`queued · task ${value.taskId}`),
                )
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Generation could not be queued.",
                  ),
                )
                .finally(() => setBusy(undefined));
            }}
          >
            {busy === "generate" ? "Queuing…" : "Start code generation"}
          </button>
          {generationResult && (
            <output aria-live="polite">{generationResult}</output>
          )}
        </div>
      )}
    </div>
  );
}
