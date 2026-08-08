import { randomUUID, timingSafeEqual } from "node:crypto";
import type { OwnerContext } from "../operations/owner-commands.js";
import { PostgresPolicyStore } from "./postgres-policy-store.js";
import type {
  RuntimePolicy,
  SimulationResult,
  OwnerOverride,
} from "./types.js";
import { simulateProgrammingRoute } from "./simulate-route.js";

const UUID_PATTERN = /^[a-f0-9-]{36}$/;
const MAX_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 2000;
const MAX_OVERRIDE_HOURS = 24;

interface PolicyCommandBase {
  occurredAt: string;
}

interface CreateDraftCommand extends PolicyCommandBase {
  policyKey: string;
  policy: unknown;
}

interface ValidateDraftCommand extends PolicyCommandBase {
  id: string;
  expectedVersion: number;
}

interface ApproveCommand extends PolicyCommandBase {
  id: string;
  expectedVersion: number;
}

interface ActivateCommand extends PolicyCommandBase {
  id: string;
  expectedVersion: number;
}

interface RollbackCommand extends PolicyCommandBase {
  policyKey: string;
  targetVersion: number;
}

interface SimulateCommand extends PolicyCommandBase {
  policyKey: string;
  taskClass: string;
  taskId: string;
  availableModelKeys: ReadonlyArray<string>;
  failures: ReadonlyArray<{
    taskId: string;
    provider: "deepseek" | "codex";
    outcome: "failed";
    code: string;
    verified: true;
  }>;
}

interface CreateOverrideCommand extends PolicyCommandBase {
  taskId: string;
  reason: string;
  expiresAt: string;
}

function parseTime(iso: string): Date {
  if (!Number.isFinite(Date.parse(iso))) {
    throw new Error("Invalid occurredAt timestamp");
  }
  return new Date(iso);
}

function assertKey(value: string): void {
  if (!value.trim() || value.trim().length > MAX_KEY_LENGTH) {
    throw new Error("Policy key must be bounded nonblank");
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid UUID`);
  }
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Version must be a positive safe integer");
  }
}

export class OwnerPolicyService {
  private readonly store: PostgresPolicyStore;
  private readonly expectedCsrfToken: string;

  constructor(store: PostgresPolicyStore, csrfSecret: string) {
    if (csrfSecret.length < 32) {
      throw new Error("CSRF secret must be at least 32 characters");
    }
    this.store = store;
    this.expectedCsrfToken = csrfSecret;
  }

  async createDraft(
    context: OwnerContext,
    command: CreateDraftCommand,
  ): Promise<{ id: string; version: number; state: string }> {
    this.authorize(context);
    assertKey(command.policyKey);
    const occurredAt = parseTime(command.occurredAt);
    const created = await this.store.createDraft(
      command.policyKey.trim(),
      command.policy,
      context.actorId,
      occurredAt,
    );
    return { id: created.id, version: created.version, state: created.state };
  }

  async validateDraft(
    context: OwnerContext,
    command: ValidateDraftCommand,
  ): Promise<{ id: string; version: number; state: string }> {
    this.authorize(context);
    assertUuid(command.id, "Policy id");
    assertVersion(command.expectedVersion);
    const occurredAt = parseTime(command.occurredAt);
    const updated = await this.store.validate(
      command.id,
      command.expectedVersion,
      context.actorId,
      occurredAt,
    );
    return { id: updated.id, version: updated.version, state: updated.state };
  }

  async approve(
    context: OwnerContext,
    command: ApproveCommand,
  ): Promise<{ id: string; version: number; state: string }> {
    this.authorize(context);
    assertUuid(command.id, "Policy id");
    assertVersion(command.expectedVersion);
    const occurredAt = parseTime(command.occurredAt);
    const updated = await this.store.approve(
      command.id,
      command.expectedVersion,
      context.actorId,
      occurredAt,
    );
    return { id: updated.id, version: updated.version, state: updated.state };
  }

  async activate(
    context: OwnerContext,
    command: ActivateCommand,
  ): Promise<{ id: string; version: number; state: string }> {
    this.authorize(context);
    assertUuid(command.id, "Policy id");
    assertVersion(command.expectedVersion);
    const occurredAt = parseTime(command.occurredAt);
    const updated = await this.store.activate(
      command.id,
      command.expectedVersion,
      context.actorId,
      occurredAt,
    );
    return { id: updated.id, version: updated.version, state: updated.state };
  }

  async rollback(
    context: OwnerContext,
    command: RollbackCommand,
  ): Promise<{ id: string; version: number; state: string }> {
    this.authorize(context);
    assertKey(command.policyKey);
    assertVersion(command.targetVersion);
    const occurredAt = parseTime(command.occurredAt);
    const updated = await this.store.rollback(
      command.policyKey.trim(),
      command.targetVersion,
      context.actorId,
      occurredAt,
    );
    return { id: updated.id, version: updated.version, state: updated.state };
  }

  async simulate(
    context: OwnerContext,
    command: SimulateCommand,
  ): Promise<SimulationResult> {
    this.authorize(context);
    assertKey(command.policyKey);
    assertUuid(command.taskId, "Task id");
    if (!command.availableModelKeys.length) {
      throw new Error("At least one model key required");
    }
    const occurredAt = parseTime(command.occurredAt);

    const active = await this.store.active(command.policyKey.trim());

    const runtimePolicy = active.policy as RuntimePolicy;
    const override = await this.findActiveOverride(command.taskId);

    return simulateProgrammingRoute(
      command.taskClass as "bulk_code" | "complex_backend" | "bounded_repair",
      command.taskId,
      runtimePolicy,
      new Set(command.availableModelKeys),
      occurredAt,
      command.failures,
      override,
    );
  }

  async createCodexOverride(
    context: OwnerContext,
    command: CreateOverrideCommand,
  ): Promise<{ id: string; taskId: string; expiresAt: Date }> {
    this.authorize(context);
    assertUuid(command.taskId, "Task id");
    if (
      !command.reason.trim() ||
      command.reason.trim().length > MAX_REASON_LENGTH
    ) {
      throw new Error("Reason must be nonblank and bounded");
    }
    const expiresAt = new Date(command.expiresAt);
    const now = new Date();
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt.getTime() - now.getTime() > MAX_OVERRIDE_HOURS * 60 * 60 * 1000
    ) {
      throw new Error("Expiry must be in future and within 24 hours");
    }

    const id = randomUUID();
    // NOTE: persisting task_role_overrides rows is not yet implemented on
    // PostgresPolicyStore -- this call is the intended shape for when that
    // lands; until then createCodexOverride is not wired to storage.
    return { id, taskId: command.taskId, expiresAt };
  }

  private authorize(context: OwnerContext): void {
    const expected = Buffer.from(this.expectedCsrfToken);
    const actual = Buffer.from(context.csrfToken);
    if (
      !context.authenticated ||
      context.actorId.length < 3 ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error("Owner authorization required");
    }
  }

  private async findActiveOverride(
    _taskId: string,
  ): Promise<OwnerOverride | undefined> {
    // NOTE: task_role_overrides lookup is not yet implemented on
    // PostgresPolicyStore -- returns undefined (no override) until that
    // storage method exists.
    return undefined;
  }
}
