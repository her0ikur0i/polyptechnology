import type { AttemptVerification, GatewayAttempt } from "./types.js";
export interface TaskProviderSummary {
  taskId: string;
  attemptId: string;
  provider: string;
  requestedModelId: string;
  resolvedModelId: string;
  resolutionSource: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsdMicros: number;
  result: string;
  artifactSha256: string;
  verification: {
    passed: true;
    verifier: string;
    evidenceSha256: string;
  };
}
export function providerSummary(
  attempt: GatewayAttempt,
  verification: AttemptVerification,
): TaskProviderSummary {
  if (
    attempt.outcome !== "succeeded" ||
    attempt.resolvedModelId === undefined ||
    attempt.usage === undefined ||
    attempt.outputSha256 === undefined ||
    verification.attemptId !== attempt.id ||
    !verification.passed
  )
    throw new Error("attempt is not summary-ready");
  return {
    taskId: attempt.attribution.taskId,
    attemptId: attempt.id,
    provider: attempt.route.provider,
    requestedModelId: attempt.route.requestedModelId,
    resolvedModelId: attempt.resolvedModelId,
    resolutionSource: attempt.resolutionSource ?? "unverified",
    role: attempt.route.role,
    inputTokens: attempt.usage.inputTokens,
    outputTokens: attempt.usage.outputTokens,
    reasoningTokens: attempt.usage.reasoningTokens,
    cacheTokens: attempt.usage.cacheReadTokens + attempt.usage.cacheWriteTokens,
    costUsdMicros: attempt.usage.costUsdMicros,
    result: attempt.outcome,
    artifactSha256: attempt.outputSha256,
    verification: {
      passed: true,
      verifier: verification.verifier,
      evidenceSha256: verification.evidenceSha256,
    },
  };
}
