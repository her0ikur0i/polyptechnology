import type { DashboardSnapshot, ModelAttempt } from "./types.js";
import { Panel, Observation, StatusBadge, OutcomeIcon } from "./components.js";

function formatCostUsdMicros(costUsdMicros: number): string {
  const dollars = costUsdMicros / 1_000_000;
  return `$${dollars.toFixed(6)}`;
}

export function RunsPage({ snapshot }: { snapshot: DashboardSnapshot }) {
  const contracts = snapshot.contracts.data;
  const attempts = snapshot.attempts.data;

  const totalContracts = contracts.length;
  const totalAttempts = attempts.length;
  const verifiedAttempts = attempts.filter((a) => a.verified).length;
  const totalLedgerCost = attempts.reduce((sum, a) => sum + a.costUsdMicros, 0);

  return (
    <main className="runs-page">
      <h1>Runs</h1>

      <section className="runs-metrics" aria-label="Aggregate run metrics">
        <div className="runs-metric">
          <span className="runs-metric__label">Contracts</span>
          <span className="runs-metric__value">{totalContracts}</span>
        </div>
        <div className="runs-metric">
          <span className="runs-metric__label">Attempts</span>
          <span className="runs-metric__value">{totalAttempts}</span>
        </div>
        <div className="runs-metric">
          <span className="runs-metric__label">Verified attempts</span>
          <span className="runs-metric__value">{verifiedAttempts}</span>
        </div>
        <div className="runs-metric">
          <span className="runs-metric__label">Total ledger cost</span>
          <span className="runs-metric__value">
            {formatCostUsdMicros(totalLedgerCost)}
          </span>
        </div>
      </section>

      <Observation value={snapshot.contracts} empty={contracts.length === 0}>
        {(contractData) => (
          <section className="runs-contracts" aria-label="Contract runs">
            {contractData.map((contract) => {
              const relatedAttempts = attempts.filter((attempt) =>
                contract.taskIds?.includes(attempt.taskId ?? ""),
              );
              const contractCost = relatedAttempts.reduce(
                (sum, a) => sum + a.costUsdMicros,
                0,
              );

              return (
                <Panel key={contract.id} eyebrow="Contract" title={contract.id}>
                  <div className="contract-details">
                    <p>
                      <strong>Milestone:</strong> {contract.milestone}
                    </p>
                    <p>
                      <strong>State:</strong>{" "}
                      <StatusBadge
                        label={contract.state}
                        tone={
                          contract.state === "active" ||
                          contract.state === "provisioned"
                            ? "good"
                            : contract.state === "failed"
                              ? "danger"
                              : "neutral"
                        }
                      />
                    </p>
                    <p>
                      <strong>Gate:</strong>{" "}
                      <StatusBadge
                        label={contract.gateStatus}
                        tone={
                          contract.gateStatus === "open" ||
                          contract.gateStatus === "passed"
                            ? "good"
                            : contract.gateStatus === "blocked" ||
                                contract.gateStatus === "failed"
                              ? "danger"
                              : "neutral"
                        }
                      />
                    </p>
                    {contract.publishedSha && (
                      <p>
                        <strong>Published SHA:</strong>{" "}
                        <code>{contract.publishedSha}</code>
                      </p>
                    )}
                    {contract.taskIds && contract.taskIds.length > 0 && (
                      <p>
                        <strong>Tasks:</strong> {contract.taskIds.join(", ")}
                      </p>
                    )}
                    <p>
                      <strong>Total cost:</strong>{" "}
                      {formatCostUsdMicros(contractCost)}
                    </p>
                  </div>

                  <h3 className="attempts-title">Related attempts</h3>
                  {relatedAttempts.length === 0 ? (
                    <div className="empty">
                      <p>No related attempts for this contract.</p>
                    </div>
                  ) : (
                    <ul className="attempt-list">
                      {relatedAttempts.map((attempt: ModelAttempt) => (
                        <li key={attempt.id} className="attempt-item">
                          <div className="attempt-item__header">
                            <span className="attempt-item__id">
                              {attempt.id}
                            </span>
                            <OutcomeIcon verified={attempt.verified} />
                            <StatusBadge
                              label={
                                attempt.verified ? "Verified" : "Not verified"
                              }
                              tone={attempt.verified ? "good" : "warning"}
                            />
                          </div>
                          <dl className="attempt-item__details">
                            <div>
                              <dt>Provider</dt>
                              <dd>{attempt.provider}</dd>
                            </div>
                            <div>
                              <dt>Requested model</dt>
                              <dd>{attempt.requestedModelId}</dd>
                            </div>
                            <div>
                              <dt>Resolved model</dt>
                              <dd>{attempt.resolvedModelId ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>Outcome</dt>
                              <dd>{attempt.outcome}</dd>
                            </div>
                            {attempt.failureCode && (
                              <div>
                                <dt>Failure code</dt>
                                <dd>
                                  <code>{attempt.failureCode}</code>
                                </dd>
                              </div>
                            )}
                            {attempt.artifactSha256 && (
                              <div>
                                <dt>Artifact SHA256</dt>
                                <dd>
                                  <code>{attempt.artifactSha256}</code>
                                </dd>
                              </div>
                            )}
                            <div>
                              <dt>Cost</dt>
                              <dd>
                                {formatCostUsdMicros(attempt.costUsdMicros)}
                              </dd>
                            </div>
                          </dl>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              );
            })}
          </section>
        )}
      </Observation>
    </main>
  );
}
