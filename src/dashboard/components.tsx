import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock3, DatabaseZap } from "lucide-react";
import type { Freshness, Observed } from "./types.js";
export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "good" | "warning" | "danger" | "neutral";
}) {
  return (
    <span className={`status status--${tone}`}>
      <span aria-hidden="true" className="status__dot" />
      {label}
    </span>
  );
}
export function Panel({
  title,
  eyebrow,
  children,
  actions,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
const freshnessLabel: Record<Freshness, string> = {
  fresh: "Current",
  stale: "Stale",
  partial: "Partial",
};
export function Observation<T>({
  value,
  empty,
  children,
}: {
  value: Observed<T>;
  empty: boolean;
  children: (data: T) => ReactNode;
}) {
  return (
    <div>
      {value.freshness !== "fresh" && (
        <div className="notice" role="status">
          <Clock3 size={16} />
          <span>
            {freshnessLabel[value.freshness]} data observed{" "}
            {new Date(value.observedAt).toLocaleString()}.{" "}
            {value.issues.join(" ")}
          </span>
        </div>
      )}
      {empty ? (
        <div className="empty">
          <DatabaseZap />
          <p>No records reported by {value.source}.</p>
        </div>
      ) : (
        children(value.data)
      )}
    </div>
  );
}
export function StatePage({
  kind,
  message,
}: {
  kind: "loading" | "unauthorized" | "error";
  message?: string;
}) {
  if (kind === "loading")
    return (
      <main id="main-content" className="state-page" aria-busy="true">
        <div className="skeleton" />
        <p>Loading verified control-plane state…</p>
      </main>
    );
  const unauthorized = kind === "unauthorized";
  return (
    <main id="main-content" className="state-page" role="alert">
      {unauthorized ? <AlertTriangle /> : <AlertTriangle />}
      <h1>
        {unauthorized ? "Owner access required" : "Dashboard unavailable"}
      </h1>
      <p>
        {message ??
          "Authenticate through the configured access gateway, then reload."}
      </p>
    </main>
  );
}
export function OutcomeIcon({ verified }: { verified: boolean }) {
  return verified ? (
    <CheckCircle2 aria-label="Verified" size={17} />
  ) : (
    <AlertTriangle aria-label="Unverified" size={17} />
  );
}
