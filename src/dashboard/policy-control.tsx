import { useEffect, useState } from "react";
import { Panel, StatusBadge } from "./components.js";
import {
  activatePolicyDraft,
  approvePolicyDraft,
  createCodexOverride,
  createPolicyDraft,
  loadActivePolicy,
  rollbackPolicy,
  validatePolicyDraft,
} from "./api.js";
import { PROGRAMMING_POLICY_KEY } from "../policy/types.js";

const stateTone: Record<string, "good" | "warning" | "neutral"> = {
  active: "good",
  approved: "warning",
  validated: "warning",
  draft: "neutral",
};

const defaultRoutesTemplate = JSON.stringify(
  {
    bulk_code: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      {
        provider: "claude",
        requestedModelId: "claude-sonnet-4-6",
        priority: 1,
      },
    ],
    complex_backend: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-pro",
        priority: 0,
      },
      { provider: "claude", requestedModelId: "claude-opus-4-8", priority: 1 },
    ],
    bounded_repair: [
      {
        provider: "deepseek",
        requestedModelId: "deepseek-v4-flash",
        priority: 0,
      },
      {
        provider: "claude",
        requestedModelId: "claude-sonnet-4-6",
        priority: 1,
      },
    ],
  },
  null,
  2,
);

// ExecutionEnvelope (src/policy/types.ts) is a flat scalar record --
// CONTRACT-013 scope calls for dedicated fields here instead of asking the
// owner to hand-edit JSON for these six numbers, while routesByTaskClass
// (inherently a nested per-task-class list) stays JSON.
const defaultEnvelope = {
  softBudgetUsdMicros: 1_000_000,
  emergencyCostCeilingUsdMicros: 5_000_000,
  maxOutputTokens: 8_000,
  maxTurns: 10,
  timeoutMs: 300_000,
  concurrency: 4,
};
type EnvelopeField = keyof typeof defaultEnvelope;
const envelopeFields: Array<{ key: EnvelopeField; label: string }> = [
  { key: "softBudgetUsdMicros", label: "Soft budget (USD micros)" },
  {
    key: "emergencyCostCeilingUsdMicros",
    label: "Emergency cost ceiling (USD micros)",
  },
  { key: "maxOutputTokens", label: "Max output tokens" },
  { key: "maxTurns", label: "Max turns" },
  { key: "timeoutMs", label: "Timeout (ms)" },
  { key: "concurrency", label: "Concurrency" },
];

// The owner-adjustable draft/validate/approve/activate lifecycle for
// programming-task routing policy, wired to OwnerPolicyService
// (src/policy/owner-policy-service.ts) through the Control API's
// /api/v1/policy/** routes. Deliberately does not re-implement any
// routing/permission semantics here -- this page only issues commands and
// renders their state, matching ADR-0003 (queries and commands, not new
// authority in the client).
export function PolicyControlPage({ csrfToken }: { csrfToken: string }) {
  // The live executor only ever consults PROGRAMMING_POLICY_KEY
  // (src/operations/policy-route-resolver.ts) -- default here so an owner
  // who just clicks through the lifecycle activates something that
  // actually affects real routing, not a key nothing reads.
  const [policyKey, setPolicyKey] = useState(PROGRAMMING_POLICY_KEY);
  const [routesJson, setRoutesJson] = useState(defaultRoutesTemplate);
  const [envelope, setEnvelope] = useState(defaultEnvelope);
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
    "draft" | "validate" | "approve" | "activate" | "rollback" | "override"
  >();
  const [rollbackVersion, setRollbackVersion] = useState("");
  const [rollbackResult, setRollbackResult] = useState<{
    id: string;
    version: number;
    state: string;
  }>();
  const [overrideTaskId, setOverrideTaskId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideExpiresAt, setOverrideExpiresAt] = useState("");
  const [overrideResult, setOverrideResult] = useState<{
    id: string;
    taskId: string;
    expiresAt: string;
  }>();

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
              let routesByTaskClass: unknown;
              try {
                routesByTaskClass = JSON.parse(routesJson);
              } catch {
                setError("Routes JSON is not valid.");
                return;
              }
              run("draft", () =>
                createPolicyDraft(
                  {
                    policyKey,
                    policy: { routesByTaskClass, envelope },
                  },
                  csrfToken,
                ),
              );
            }}
          >
            <label>
              Routes by task class (JSON)
              <textarea
                aria-label="Routes by task class JSON"
                value={routesJson}
                onChange={(event) => setRoutesJson(event.target.value)}
                rows={12}
                required
              />
            </label>
            <fieldset className="settings-grid">
              <legend>Execution envelope</legend>
              {envelopeFields.map(({ key, label }) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    min={key === "concurrency" || key === "maxTurns" ? 1 : 0}
                    value={envelope[key]}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setEnvelope((current) => ({ ...current, [key]: value }));
                    }}
                    required
                  />
                </label>
              ))}
            </fieldset>
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
        <Panel title="Rollback to a prior version" eyebrow="ROLLBACK">
          <form
            className="settings-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const targetVersion = Number(rollbackVersion);
              if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) {
                setError("Target version must be a positive integer.");
                return;
              }
              setBusy("rollback");
              setError(undefined);
              rollbackPolicy({ policyKey, targetVersion }, csrfToken)
                .then((result) => {
                  setRollbackResult(result);
                  setActive(result);
                })
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Rollback failed.",
                  ),
                )
                .finally(() => setBusy(undefined));
            }}
          >
            <label>
              Target version
              <input
                aria-label="Rollback target version"
                value={rollbackVersion}
                onChange={(event) => setRollbackVersion(event.target.value)}
                inputMode="numeric"
                pattern="[0-9]+"
                required
              />
            </label>
            <div className="settings-actions">
              <button type="submit" disabled={busy !== undefined}>
                {busy === "rollback" ? "Rolling back…" : "Rollback"}
              </button>
            </div>
            {rollbackResult && (
              <output aria-live="polite">
                Reactivated version {rollbackResult.version} ·{" "}
                <StatusBadge
                  label={rollbackResult.state}
                  tone={stateTone[rollbackResult.state] ?? "neutral"}
                />
              </output>
            )}
          </form>
        </Panel>
        <Panel
          title="Codex technical-execution override"
          eyebrow="MANUAL ESCALATION"
        >
          <form
            className="settings-grid"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy("override");
              setError(undefined);
              createCodexOverride(
                {
                  taskId: overrideTaskId,
                  reason: overrideReason,
                  expiresAt: new Date(overrideExpiresAt).toISOString(),
                },
                csrfToken,
              )
                .then(setOverrideResult)
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Override failed.",
                  ),
                )
                .finally(() => setBusy(undefined));
            }}
          >
            <p>
              Grants Codex technical-execution permission on one already queued
              task, bypassing DeepSeek-first ordering for that task only.
              Bounded to 24 hours; never widens which tasks a provider may
              review.
            </p>
            <label>
              Task id
              <input
                aria-label="Override task id"
                value={overrideTaskId}
                onChange={(event) => setOverrideTaskId(event.target.value)}
                required
              />
            </label>
            <label>
              Reason
              <textarea
                aria-label="Override reason"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={3}
                required
              />
            </label>
            <label>
              Expires at
              <input
                aria-label="Override expiry"
                type="datetime-local"
                value={overrideExpiresAt}
                onChange={(event) => setOverrideExpiresAt(event.target.value)}
                required
              />
            </label>
            <div className="settings-actions">
              <button type="submit" disabled={busy !== undefined}>
                {busy === "override" ? "Granting…" : "Grant override"}
              </button>
            </div>
            {overrideResult && (
              <output aria-live="polite">
                Granted · expires {overrideResult.expiresAt}
              </output>
            )}
          </form>
        </Panel>
      </div>
    </div>
  );
}
