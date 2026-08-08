import { useEffect, useState } from "react";
import { Panel, StatusBadge } from "./components.js";
import {
  activatePolicyDraft,
  approvePolicyDraft,
  createPolicyDraft,
  loadActivePolicy,
  validatePolicyDraft,
} from "./api.js";

const stateTone: Record<string, "good" | "warning" | "neutral"> = {
  active: "good",
  approved: "warning",
  validated: "warning",
  draft: "neutral",
};

const defaultPolicyTemplate = JSON.stringify(
  {
    routesByTaskClass: {
      bulk_code: [
        {
          provider: "deepseek",
          requestedModelId: "deepseek-v4-flash",
          priority: 0,
        },
        {
          provider: "claude",
          requestedModelId: "claude-sonnet-5",
          priority: 1,
        },
      ],
      complex_backend: [
        {
          provider: "deepseek",
          requestedModelId: "deepseek-v4-pro",
          priority: 0,
        },
        {
          provider: "claude",
          requestedModelId: "claude-opus-4-8",
          priority: 1,
        },
      ],
      bounded_repair: [
        {
          provider: "deepseek",
          requestedModelId: "deepseek-v4-flash",
          priority: 0,
        },
        {
          provider: "claude",
          requestedModelId: "claude-sonnet-5",
          priority: 1,
        },
      ],
    },
    envelope: {
      softBudgetUsdMicros: 1_000_000,
      emergencyCostCeilingUsdMicros: 5_000_000,
      maxOutputTokens: 8_000,
      maxTurns: 10,
      timeoutMs: 300_000,
      concurrency: 4,
    },
  },
  null,
  2,
);

// The owner-adjustable draft/validate/approve/activate lifecycle for
// programming-task routing policy, wired to OwnerPolicyService
// (src/policy/owner-policy-service.ts) through the Control API's
// /api/v1/policy/** routes. Deliberately does not re-implement any
// routing/permission semantics here -- this page only issues commands and
// renders their state, matching ADR-0003 (queries and commands, not new
// authority in the client).
export function PolicyControlPage({ csrfToken }: { csrfToken: string }) {
  const [policyKey, setPolicyKey] = useState("bulk_code_default");
  const [policyJson, setPolicyJson] = useState(defaultPolicyTemplate);
  const [draft, setDraft] = useState<{
    id: string;
    version: number;
    state: string;
  }>();
  const [active, setActive] = useState<{
    id: string;
    version: number;
    state: string;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<
    "draft" | "validate" | "approve" | "activate"
  >();

  useEffect(() => {
    let cancelled = false;
    void loadActivePolicy(policyKey)
      .then((value) => {
        if (!cancelled) setActive(value);
      })
      .catch(() => {
        if (!cancelled) setActive(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [policyKey, draft?.state]);

  function run(
    step: typeof busy,
    action: () => Promise<{ id: string; version: number; state: string }>,
  ) {
    setBusy(step);
    setError(undefined);
    action()
      .then(setDraft)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Command failed."),
      )
      .finally(() => setBusy(undefined));
  }

  return (
    <div className="page">
      <header className="page-title">
        <p className="eyebrow">OWNER WORKSPACE</p>
        <h1>Orchestration Policy</h1>
        <p>
          Draft, validate, approve, and activate versioned routing policy for
          programming tasks. Nothing here bypasses the deepseek -&gt; codex
          -&gt; claude fallback chain or its verified-failure escalation gates.
        </p>
      </header>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <div className="dashboard-grid">
        <Panel
          title="Active policy"
          eyebrow="CURRENT"
          actions={
            active && (
              <StatusBadge
                label={active.state}
                tone={stateTone[active.state] ?? "neutral"}
              />
            )
          }
        >
          <dl className="facts">
            <div>
              <dt>Policy key</dt>
              <dd>
                <input
                  aria-label="Policy key"
                  value={policyKey}
                  onChange={(event) => setPolicyKey(event.target.value)}
                  pattern="[A-Za-z0-9_-]{1,120}"
                />
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{active?.version ?? "No active version"}</dd>
            </div>
          </dl>
        </Panel>
        <Panel
          title="Draft / validate / approve / activate"
          eyebrow="LIFECYCLE"
        >
          <form
            className="settings-grid"
            onSubmit={(event) => {
              event.preventDefault();
              let parsed: unknown;
              try {
                parsed = JSON.parse(policyJson);
              } catch {
                setError("Policy JSON is not valid.");
                return;
              }
              run("draft", () =>
                createPolicyDraft({ policyKey, policy: parsed }, csrfToken),
              );
            }}
          >
            <label>
              Policy document (JSON)
              <textarea
                aria-label="Policy document JSON"
                value={policyJson}
                onChange={(event) => setPolicyJson(event.target.value)}
                rows={12}
                required
              />
            </label>
            <div className="settings-actions">
              <button type="submit" disabled={busy !== undefined}>
                {busy === "draft" ? "Drafting…" : "Create draft"}
              </button>
              {draft && (
                <>
                  <button
                    type="button"
                    disabled={busy !== undefined || draft.state !== "draft"}
                    onClick={() =>
                      run("validate", () =>
                        validatePolicyDraft(
                          { id: draft.id, expectedVersion: draft.version },
                          csrfToken,
                        ),
                      )
                    }
                  >
                    {busy === "validate" ? "Validating…" : "Validate"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== undefined || draft.state !== "validated"}
                    onClick={() =>
                      run("approve", () =>
                        approvePolicyDraft(
                          { id: draft.id, expectedVersion: draft.version },
                          csrfToken,
                        ),
                      )
                    }
                  >
                    {busy === "approve" ? "Approving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== undefined || draft.state !== "approved"}
                    onClick={() =>
                      run("activate", () =>
                        activatePolicyDraft(
                          { id: draft.id, expectedVersion: draft.version },
                          csrfToken,
                        ),
                      )
                    }
                  >
                    {busy === "activate" ? "Activating…" : "Activate"}
                  </button>
                </>
              )}
            </div>
            {draft && (
              <output aria-live="polite">
                {draft.id} · version {draft.version} ·{" "}
                <StatusBadge
                  label={draft.state}
                  tone={stateTone[draft.state] ?? "neutral"}
                />
              </output>
            )}
          </form>
        </Panel>
      </div>
    </div>
  );
}
