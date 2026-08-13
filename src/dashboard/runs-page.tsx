import type { DashboardSnapshot, ModelAttempt } from "./types.js";

function formatCostUsdMicros(costUsdMicros: number): string {
  const dollars = costUsdMicros / 1_000_000;
  return `$${dollars.toFixed(6)}`;
}

export function RunsPage({ snapshot }: { snapshot: DashboardSnapshot }) {
  const contracts = snapshot.contracts.data;
  const attempts = snapshot.attempts.data;

  return (
    <div className="page runs-page">
      <h1>Runs</h1>

      <section className="runs-contracts" aria-label="Contract runs">
        {contracts.map((contract) => {
          const relatedAttempts = attempts.filter((attempt) =>
            contract.taskIds?.includes(attempt.taskId ?? ""),
          );
          const contractCost = relatedAttempts.reduce(
            (sum, a) => sum + a.costUsdMicros,
            0,
          );

          return (
            <section key={contract.id} className="contract-run">
              <h2>{contract.id}</h2>
              <dl className="contract-details">
                <div>
                  <dt>Milestone</dt>
                  <dd>{contract.milestone}</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{contract.state}</dd>
                </div>
                <div>
                  <dt>Gate</dt>
                  <dd>{contract.gateStatus}</dd>
                </div>
                {contract.publishedSha && (
                  <div>
                    <dt>Published SHA</dt>
                    <dd>
                      <code>{contract.publishedSha}</code>
                    </dd>
                  </div>
                )}
                {contract.taskIds && contract.taskIds.length > 0 && (
                  <div>
                    <dt>Tasks</dt>
                    <dd>{contract.taskIds.join(", ")}</dd>
                  </div>
                )}
                <div>
                  <dt>Total cost</dt>
                  <dd>{formatCostUsdMicros(contractCost)}</dd>
                </div>
              </dl>

              <h3>Related attempts</h3>
              {relatedAttempts.length === 0 ? (
                <p>No related attempts for this contract.</p>
              ) : (
                <ul className="attempt-list">
                  {relatedAttempts.map((attempt: ModelAttempt) => (
                    <li key={attempt.id} className="attempt-item">
                      <div className="attempt-item__header">
                        <span className="attempt-item__id">{attempt.id}</span>
                        <span>
                          {attempt.verified ? "Verified" : "Not verified"}
                        </span>
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
                          <dd>{formatCostUsdMicros(attempt.costUsdMicros)}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </section>
    </div>
  );
}

export default RunsPage;
