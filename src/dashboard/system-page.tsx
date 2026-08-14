import { useEffect, useState } from "react";
import { Panel, StatePage, StatusBadge } from "./components.js";

interface SystemSnapshot {
  host: {
    uptimeSeconds: number;
    loadavg: number[];
    totalMemBytes: number;
    freeMemBytes: number;
    cpuCount: number;
    platform: string;
    arch: string;
  };
  process: {
    pid: number;
    nodeVersion: string;
    rssBytes: number;
  };
  database: {
    connectionCount: number;
    sizeBytes: number;
    tasksByState: Record<string, number>;
    attemptCount: number;
  };
  budget: Array<{
    scopeId: string;
    spentUsdMicros: number;
    reservedUsdMicros: number;
    maxCostUsdMicros: number;
  }>;
  collectedAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824)
    return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SystemPage() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; value: SystemSnapshot }
  >({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/system/snapshot", {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("system snapshot unavailable");
        setState({
          kind: "ready",
          value: (await response.json()) as SystemSnapshot,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "system snapshot failed",
        });
      }
    })();
    return () => controller.abort();
  }, []);

  if (state.kind !== "ready")
    return (
      <StatePage
        kind={state.kind === "loading" ? "loading" : "error"}
        message={state.kind === "error" ? state.message : undefined}
      />
    );

  const snapshot = state.value;
  const memoryUsed = snapshot.host.totalMemBytes - snapshot.host.freeMemBytes;
  const memoryPercent = Math.round(
    (memoryUsed / snapshot.host.totalMemBytes) * 100,
  );

  return (
    <div className="page">
      <header className="page-title">
        <p className="eyebrow">SYSTEM</p>
        <h1>System monitor</h1>
        <p>
          Host, process, database and budget telemetry collected from inside the
          control API's own sandbox. Collected{" "}
          {new Date(snapshot.collectedAt).toLocaleTimeString()}.
        </p>
      </header>

      <div className="metric-grid">
        <article className="metric">
          <p>Uptime</p>
          <strong>{formatUptime(snapshot.host.uptimeSeconds)}</strong>
          <small>{snapshot.host.platform}</small>
        </article>
        <article className="metric">
          <p>Memory</p>
          <strong>{memoryPercent}%</strong>
          <small>
            {formatBytes(memoryUsed)} /{" "}
            {formatBytes(snapshot.host.totalMemBytes)}
          </small>
        </article>
        <article className="metric">
          <p>Load average</p>
          <strong>{snapshot.host.loadavg[0]?.toFixed(2) ?? "—"}</strong>
          <small>{snapshot.host.cpuCount} CPUs</small>
        </article>
        <article className="metric">
          <p>DB connections</p>
          <strong>{snapshot.database.connectionCount}</strong>
          <small>{formatBytes(snapshot.database.sizeBytes)} on disk</small>
        </article>
      </div>

      <div className="dashboard-grid">
        <Panel title="Host & process" eyebrow="RUNTIME">
          <Facts
            rows={[
              ["Platform", `${snapshot.host.platform} (${snapshot.host.arch})`],
              ["Uptime", formatUptime(snapshot.host.uptimeSeconds)],
              [
                "Memory",
                `${formatBytes(memoryUsed)} of ${formatBytes(snapshot.host.totalMemBytes)} (${memoryPercent}%)`,
              ],
              [
                "Load average",
                snapshot.host.loadavg.map((v) => v.toFixed(2)).join(" · "),
              ],
              ["CPU count", String(snapshot.host.cpuCount)],
              ["Process pid", String(snapshot.process.pid)],
              ["Node version", snapshot.process.nodeVersion],
              ["Process RSS", formatBytes(snapshot.process.rssBytes)],
            ]}
          />
        </Panel>

        <Panel title="Database" eyebrow="POSTGRES">
          <Facts
            rows={[
              ["Connections", String(snapshot.database.connectionCount)],
              ["Size on disk", formatBytes(snapshot.database.sizeBytes)],
              ["Gateway attempts", String(snapshot.database.attemptCount)],
            ]}
          />
          <h3 style={{ margin: "0.6rem 0 0.3rem" }}>Tasks by state</h3>
          {Object.keys(snapshot.database.tasksByState).length === 0 ? (
            <p className="empty">No tasks recorded.</p>
          ) : (
            <ul className="compact-list">
              {Object.entries(snapshot.database.tasksByState)
                .sort((a, b) => b[1] - a[1])
                .map(([stateName, count]) => (
                  <li key={stateName}>
                    <StatusBadge label={stateName} tone="neutral" />{" "}
                    <strong>{count}</strong>
                  </li>
                ))}
            </ul>
          )}
        </Panel>

        <Panel title="Budget scopes" eyebrow="AI BUDGET">
          {snapshot.budget.length === 0 ? (
            <p className="empty">No budget scopes recorded.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Spent</th>
                    <th>Reserved</th>
                    <th>Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.budget.map((scope) => (
                    <tr key={scope.scopeId}>
                      <td>
                        <code>{scope.scopeId}</code>
                      </td>
                      <td>{formatUsd(scope.spentUsdMicros)}</td>
                      <td>{formatUsd(scope.reservedUsdMicros)}</td>
                      <td>{formatUsd(scope.maxCostUsdMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
