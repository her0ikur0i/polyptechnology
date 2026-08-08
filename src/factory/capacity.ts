import type {
  CapacityLease,
  CapacityLimits,
  CapacityObservation,
  CapacityRequest,
} from "./types.js";

export function rankEligible(
  requests: ReadonlyArray<CapacityRequest>,
  observation: CapacityObservation,
  limits: CapacityLimits,
  nowMs: number,
) {
  if (observation.freeDiskMiB < limits.minimumFreeDiskMiB) return [];
  return requests
    .filter((request) => eligible(request, observation, limits))
    .sort(
      (a, b) =>
        score(b, nowMs) - score(a, nowMs) ||
        a.queuedAtMs - b.queuedAtMs ||
        a.id.localeCompare(b.id),
    );
}
function eligible(
  request: CapacityRequest,
  observation: CapacityObservation,
  limits: CapacityLimits,
) {
  if (
    !request.budgetAvailable ||
    observation.active.length >= limits.globalConcurrency
  )
    return false;
  const provider = observation.active.filter(
      (item) => item.providerId === request.providerId,
    ),
    project = observation.active.filter(
      (item) => item.projectId === request.projectId,
    ),
    total = (key: "cpuMillis" | "memoryMiB" | "diskMiB" | "maxProcesses") =>
      observation.active.reduce((sum, item) => sum + item.resources[key], 0) +
      request.resources[key];
  return (
    provider.length < limits.providerConcurrency &&
    project.length < limits.projectConcurrency &&
    total("cpuMillis") <= limits.cpuMillis &&
    total("memoryMiB") <= limits.memoryMiB &&
    total("diskMiB") <= limits.diskMiB &&
    total("maxProcesses") <= limits.maxProcesses
  );
}
function score(request: CapacityRequest, nowMs: number) {
  const ageMinutes = Math.max(0, nowMs - request.queuedAtMs) / 60_000;
  return (
    Math.max(0, Math.min(100, request.priority)) +
    Math.min(25, ageMinutes) +
    (request.interactive ? 10 : 0)
  );
}
export class CapacityReservations {
  private fence = 0;
  private readonly leases = new Map<string, CapacityLease>();
  claim(request: CapacityRequest, nowMs: number, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("invalid reservation ttl");
    const current = this.leases.get(request.id);
    if (current && current.expiresAtMs > nowMs)
      throw new Error("capacity already reserved");
    const lease = { request, fence: ++this.fence, expiresAtMs: nowMs + ttlMs };
    this.leases.set(request.id, lease);
    return lease;
  }
  release(requestId: string, fence: number) {
    const lease = this.leases.get(requestId);
    if (!lease || lease.fence !== fence)
      throw new Error("stale capacity fence");
    this.leases.delete(requestId);
  }
}
