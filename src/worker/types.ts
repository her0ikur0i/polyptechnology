export type WorkerCapability = "process" | "network" | "secrets";
export interface WorkerJob {
  isolationRoot: string;
  workspaceRoot: string;
  image: string;
  command: string;
  args: ReadonlyArray<string>;
  ownedPaths: ReadonlyArray<string>;
  capabilities: ReadonlySet<WorkerCapability>;
  timeoutMs: number;
  outputByteLimit: number;
  memoryMb: number;
  cpuLimit: number;
  environment: Readonly<Record<string, string>>;
}
export interface WorkerCommand {
  executable: "docker";
  args: ReadonlyArray<string>;
  cwd: string;
  timeoutMs: number;
  outputByteLimit: number;
}
export interface WorkerProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputLimited: boolean;
}
export interface WorkerArtifact {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}
export interface WorkerRunResult {
  status: "succeeded" | "failed" | "timeout" | "output_limited";
  process: WorkerProcessResult;
  artifacts: ReadonlyArray<WorkerArtifact>;
}
export interface WorkerRunner {
  run(
    command: WorkerCommand,
    signal?: AbortSignal,
  ): Promise<WorkerProcessResult>;
}
