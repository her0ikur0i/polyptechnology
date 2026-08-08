export type RoadmapState =
  "running" | "owner_blocked" | "gate_failed" | "completed" | "stopped";
export interface SequenceCheckpoint {
  contractId: string;
  milestoneId: string;
  phase: string;
  evidenceIds: ReadonlyArray<string>;
}
export interface SupervisorLease {
  owner: string;
  fencingToken: number;
  expiresAt: Date;
}
export interface SequenceStore {
  claim(owner: string, ttlMs: number): Promise<SupervisorLease>;
  heartbeat(lease: SupervisorLease, ttlMs: number): Promise<SupervisorLease>;
  checkpoint(lease: SupervisorLease, value: SequenceCheckpoint): Promise<void>;
  release(lease: SupervisorLease): Promise<void>;
}
export interface SequenceStep {
  checkpoint: SequenceCheckpoint;
  terminal?: Exclude<RoadmapState, "running">;
}
export interface SequenceDriver {
  next(current: SequenceCheckpoint, signal: AbortSignal): Promise<SequenceStep>;
}
export class SequenceSupervisor {
  constructor(
    private readonly store: SequenceStore,
    private readonly driver: SequenceDriver,
    private readonly owner: string,
    private readonly ttlMs = 30_000,
  ) {}
  async cycle(
    current: SequenceCheckpoint,
    signal: AbortSignal,
  ): Promise<SequenceStep> {
    const lease = await this.store.claim(this.owner, this.ttlMs);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    let heartbeatFailure: unknown;
    let currentLease = lease;
    const heartbeat = setInterval(
      () => {
        void this.store
          .heartbeat(currentLease, this.ttlMs)
          .then((renewed) => {
            currentLease = renewed;
          })
          .catch((error: unknown) => {
            heartbeatFailure = error;
            controller.abort(error);
          });
      },
      Math.max(250, Math.floor(this.ttlMs / 3)),
    );
    heartbeat.unref();
    try {
      const step = await this.driver.next(current, controller.signal);
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      await this.store.checkpoint(currentLease, step.checkpoint);
      return step;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", forwardAbort);
      await this.store.release(currentLease);
    }
  }
}
