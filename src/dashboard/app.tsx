import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  BrainCircuit,
  ChevronRight,
  ClipboardCheck,
  Factory,
  FolderKanban,
  GitPullRequestArrow,
  Menu,
  Network,
  ServerCog,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import {
  Observation,
  OutcomeIcon,
  Panel,
  StatePage,
  StatusBadge,
} from "./components.js";
import type { DashboardSnapshot, ModelAttempt } from "./types.js";
import { useSnapshot } from "./use-snapshot.js";
import { saveTelegramSettings } from "./api.js";
import { FactoryLivePage } from "./factory-live/FactoryLive.js";
import { FactoryControlPage } from "./factory-control.js";
import { PolicyControlPage } from "./policy-control.js";
import "./styles.css";
const nav = [
  { to: "/", label: "Overview", icon: Factory },
  { to: "/orchestrator", label: "Orchestrator", icon: BrainCircuit },
  { to: "/policy", label: "Policy", icon: SlidersHorizontal },
  { to: "/factory-live", label: "Factory Live", icon: Activity },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/contracts", label: "Contracts / Runs", icon: GitPullRequestArrow },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/providers", label: "Providers & Models", icon: Network },
  { to: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { to: "/infrastructure", label: "Infrastructure", icon: ServerCog },
  { to: "/settings", label: "Settings", icon: Settings2 },
];
function Shell({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const menuRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const openNavigation = () => {
    setOpen(true);
    requestAnimationFrame(() => firstLinkRef.current?.focus());
  };
  const closeNavigation = () => {
    setOpen(false);
    requestAnimationFrame(() => menuRef.current?.focus());
  };
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside
        id="primary-sidebar"
        className={open ? "sidebar sidebar--open" : "sidebar"}
        inert={compact && !open}
        aria-hidden={compact && !open}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeNavigation();
        }}
      >
        <div className="brand">
          <span className="brand__mark">
            <Boxes />
          </span>
          <span>
            <strong>POLYP</strong>
            <small>AI FACTORY</small>
          </span>
        </div>
        <button
          className="nav-close"
          aria-label="Close navigation"
          onClick={closeNavigation}
        >
          <X />
        </button>
        <nav aria-label="Primary">
          {nav.map(({ to, label, icon: Icon }, index) => (
            <NavLink
              ref={index === 0 ? firstLinkRef : undefined}
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setOpen(false)}
            >
              <Icon size={18} />
              <span>{label}</span>
              <ChevronRight className="nav-chevron" size={15} />
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__foot">
          <StatusBadge
            label={snapshot.sequence.data.state}
            tone={
              snapshot.sequence.data.state === "running" ? "good" : "warning"
            }
          />
          <small>
            {snapshot.sequence.data.contractId ?? "No active contract"} ·{" "}
            {snapshot.sequence.data.milestoneId ?? "checkpoint idle"}
          </small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="menu"
            ref={menuRef}
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="primary-sidebar"
            onClick={openNavigation}
          >
            <Menu />
          </button>
          <div>
            <p className="eyebrow">CONTROL PLANE</p>
            <strong>Master Dashboard</strong>
          </div>
          <div className="topbar__status">
            <ShieldCheck />
            <span>Owner session</span>
          </div>
        </header>
        <main id="main-content">
          <Routes>
            <Route path="/" element={<Overview snapshot={snapshot} />} />
            <Route path="/factory-live" element={<FactoryLivePage />} />
            <Route
              path="/providers"
              element={<Providers snapshot={snapshot} />}
            />
            <Route
              path="/settings"
              element={<Settings snapshot={snapshot} />}
            />
            <Route
              path="/approvals"
              element={
                <RegistryPage
                  title="Approvals"
                  observation={snapshot.approvals}
                  columns={["action", "risk", "state", "expiresAt"]}
                />
              }
            />
            <Route
              path="/projects"
              element={
                <RegistryPage
                  title="Projects"
                  observation={snapshot.projects}
                  columns={["name", "lifecycle", "attention", "updatedAt"]}
                />
              }
            />
            <Route
              path="/contracts"
              element={
                <RegistryPage
                  title="Contracts / Runs"
                  observation={snapshot.contracts}
                  columns={["id", "milestone", "state", "gateStatus"]}
                />
              }
            />
            <Route
              path="/orchestrator"
              element={
                <FactoryControlPage
                  csrfToken={snapshot.commandPolicy.csrfToken}
                />
              }
            />
            <Route
              path="/policy"
              element={
                <PolicyControlPage
                  csrfToken={snapshot.commandPolicy.csrfToken}
                />
              }
            />
            <Route
              path="/agents"
              element={
                <Placeholder
                  title="Agents"
                  detail="Dynamic roles, permissions, workload and evaluation state."
                />
              }
            />
            <Route
              path="/infrastructure"
              element={
                <Placeholder
                  title="Infrastructure"
                  detail="Host, container, service, database and backup observations."
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
function Overview({ snapshot }: { snapshot: DashboardSnapshot }) {
  const sequence = snapshot.sequence.data;
  return (
    <div className="page">
      <header className="page-title">
        <p className="eyebrow">LIVE OPERATIONS</p>
        <h1>Factory overview</h1>
        <p>
          Verified control-plane signals, with stale and partial data called out
          explicitly.
        </p>
      </header>
      <div className="metric-grid">
        <Metric
          label="Sequence"
          value={sequence.state}
          detail={`${sequence.contractId ?? "No contract"} · ${sequence.milestoneId ?? "No milestone"}`}
        />
        <Metric
          label="Owner blockers"
          value={String(sequence.ownerBlockers)}
          detail="Aggregated durable blockers"
        />
        <Metric
          label="Pending approvals"
          value={String(
            snapshot.approvals.data.filter((item) => item.state === "pending")
              .length,
          )}
          detail={snapshot.approvals.freshness}
        />
        <Metric
          label="Tracked attempts"
          value={String(snapshot.attempts.data.length)}
          detail="Managed gateway ledger"
        />
      </div>
      <div className="dashboard-grid">
        <Panel title="Attention queue" eyebrow="ACTIONABLE">
          <Observation
            value={snapshot.attention}
            empty={snapshot.attention.data.length === 0}
          >
            {(items) => (
              <ul className="attention-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <StatusBadge
                      label={item.severity}
                      tone={
                        item.severity === "critical"
                          ? "danger"
                          : item.severity === "warning"
                            ? "warning"
                            : "neutral"
                      }
                    />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <a href={item.sourceHref}>Open source</a>
                  </li>
                ))}
              </ul>
            )}
          </Observation>
        </Panel>
        <Panel title="Sequence continuity" eyebrow="SUPERVISOR">
          <dl className="facts">
            <div>
              <dt>State</dt>
              <dd>{sequence.state}</dd>
            </div>
            <div>
              <dt>Checkpoint</dt>
              <dd>
                {sequence.contractId ?? "—"} / {sequence.milestoneId ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Heartbeat</dt>
              <dd>
                {sequence.heartbeatAt
                  ? new Date(sequence.heartbeatAt).toLocaleString()
                  : "Not reported"}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function Providers({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <div className="page">
      <PageHeader
        title="Providers & Models"
        detail="Concrete model resolution, normalized usage and verification."
      />
      <Panel title="Managed attempts" eyebrow="AI GATEWAY">
        <Observation
          value={snapshot.attempts}
          empty={snapshot.attempts.data.length === 0}
        >
          {(attempts) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Provider / role</th>
                    <th>Requested → resolved</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Outcome</th>
                    <th>Gate</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((attempt) => (
                    <AttemptRow key={attempt.id} value={attempt} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Observation>
      </Panel>
    </div>
  );
}
function AttemptRow({ value }: { value: ModelAttempt }) {
  return (
    <tr>
      <td>
        <strong>{value.provider}</strong>
        <small>{value.role}</small>
      </td>
      <td>
        <code>{value.requestedModelId}</code>
        <span className="model-arrow">→</span>
        <code>{value.resolvedModelId ?? "unresolved"}</code>
        <small>{value.resolutionSource ?? "no resolution evidence"}</small>
      </td>
      <td>
        {value.inputTokens.toLocaleString()} in ·{" "}
        {value.outputTokens.toLocaleString()} out
        <small>
          {value.reasoningTokens.toLocaleString()} reasoning ·{" "}
          {(value.cacheReadTokens + value.cacheWriteTokens).toLocaleString()}{" "}
          cache
        </small>
      </td>
      <td>${(value.costUsdMicros / 1_000_000).toFixed(6)}</td>
      <td>
        <StatusBadge
          label={value.outcome}
          tone={
            value.outcome === "succeeded"
              ? "good"
              : value.outcome === "failed"
                ? "danger"
                : "warning"
          }
        />
      </td>
      <td>
        <OutcomeIcon verified={value.verified} />
      </td>
    </tr>
  );
}
function Settings({ snapshot }: { snapshot: DashboardSnapshot }) {
  const value = snapshot.telegram.data;
  const [secretRef, setSecretRef] = useState(value.secretRef ?? "");
  const [chatIds, setChatIds] = useState(value.authorizedChatIds.join(", "));
  const [userIds, setUserIds] = useState(value.authorizedUserIds.join(", "));
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaveState("saving");
    setSaveError("");
    try {
      await saveTelegramSettings(
        {
          secretRef,
          authorizedChatIds: chatIds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          authorizedUserIds: userIds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
        snapshot.commandPolicy.csrfToken,
      );
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(
        error instanceof Error ? error.message : "Settings command failed.",
      );
    }
  }
  return (
    <div className="page">
      <PageHeader
        title="Settings"
        detail="References and policy state only. Secret values never enter this client."
      />
      <Panel
        title="Telegram approvals"
        eyebrow="REMOTE CHANNEL"
        actions={
          <StatusBadge
            label={
              value.configurationReady ? "Configuration ready" : "Not ready"
            }
            tone={value.configurationReady ? "good" : "warning"}
          />
        }
      >
        <Observation value={snapshot.telegram} empty={false}>
          {(telegram) => (
            <form
              className="settings-grid"
              onSubmit={(event) => void submit(event)}
            >
              <label>
                Bot secret reference
                <input
                  aria-label="Bot secret reference"
                  value={secretRef}
                  onChange={(event) => setSecretRef(event.currentTarget.value)}
                  placeholder="secret://…"
                  pattern="secret://[a-zA-Z0-9/_-]+"
                  required
                />
                <small>
                  Reference-only. Updates require an approved server command.
                </small>
              </label>
              <div>
                <h3>Authorized identities</h3>
                <label>
                  Chat IDs
                  <input
                    aria-label="Authorized chat IDs"
                    value={chatIds}
                    onChange={(event) => setChatIds(event.currentTarget.value)}
                    placeholder="-100…, …"
                  />
                </label>
                <label>
                  User IDs
                  <input
                    aria-label="Authorized user IDs"
                    value={userIds}
                    onChange={(event) => setUserIds(event.currentTarget.value)}
                    placeholder="123…, …"
                  />
                </label>
              </div>
              <div>
                <h3>Readiness</h3>
                <StatusBadge
                  label={
                    telegram.configurationReady
                      ? "Configuration checks pass"
                      : "Configuration incomplete"
                  }
                  tone={telegram.configurationReady ? "good" : "warning"}
                />
                <p>
                  Live inference/probe: {telegram.liveProbeState}.{" "}
                  {telegram.approvalRequiredForProbe
                    ? "Owner approval required before a paid probe."
                    : "No paid probe approval pending."}
                </p>
              </div>
              <div className="settings-actions">
                <button
                  type="submit"
                  disabled={
                    !snapshot.commandPolicy.canConfigureTelegram ||
                    saveState === "saving"
                  }
                >
                  {saveState === "saving"
                    ? "Saving…"
                    : "Save Telegram configuration"}
                </button>
                <span role="status">
                  {saveState === "saved"
                    ? "Settings command accepted."
                    : saveState === "error"
                      ? saveError
                      : ""}
                </span>
              </div>
            </form>
          )}
        </Observation>
      </Panel>
    </div>
  );
}
function RegistryPage<T extends object>({
  title,
  observation,
  columns,
}: {
  title: string;
  observation: import("./types.js").Observed<ReadonlyArray<T>>;
  columns: ReadonlyArray<keyof T & string>;
}) {
  return (
    <div className="page">
      <PageHeader
        title={title}
        detail="Dynamic registry state from the authenticated control plane."
      />
      <Panel title={`${title} registry`}>
        <Observation value={observation} empty={observation.data.length === 0}>
          {(rows) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={String((row as Record<string, unknown>).id ?? index)}
                    >
                      {columns.map((column) => (
                        <td key={column}>{String(row[column] ?? "—")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Observation>
      </Panel>
    </div>
  );
}
function Placeholder({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="page">
      <PageHeader title={title} detail={detail} />
      <div className="empty large">
        <Boxes />
        <p>No records were returned for this area.</p>
      </div>
    </div>
  );
}
function PageHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="page-title">
      <p className="eyebrow">OPERATIONS</p>
      <h1>{title}</h1>
      <p>{detail}</p>
    </header>
  );
}
export function DashboardApp({
  initialSnapshot,
}: {
  initialSnapshot?: DashboardSnapshot;
}) {
  const state = useSnapshot(initialSnapshot);
  if (state.kind !== "ready")
    return (
      <StatePage
        kind={state.kind}
        message={state.kind === "error" ? state.message : undefined}
      />
    );
  return (
    <BrowserRouter>
      <Shell snapshot={state.value} />
    </BrowserRouter>
  );
}
