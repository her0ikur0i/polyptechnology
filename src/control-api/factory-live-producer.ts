import type { Pool } from "pg";

// Builds the Factory Live topology from the real database: the factory root,
// one node per generated project, and one node per task (linked to its project
// through the gateway attempt's attribution, which is the only place the
// task -> project edge exists). This is the first real producer -- before it,
// Factory Live's client had no server at all (the routes did not exist).

export const FACTORY_LIVE_STREAM_ID = "polyp-factory";

export type LiveNodeKind =
  | "factory"
  | "project"
  | "contract"
  | "milestone"
  | "agent"
  | "task"
  | "artifact";
export type LiveState =
  "idle" | "busy" | "approval" | "success" | "failure" | "stale";

export interface LiveNode {
  id: string;
  parentId?: string;
  projectId?: string;
  kind: LiveNodeKind;
  label: string;
  state: LiveState;
  sourceHref: string;
}

export interface LiveEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: "contains" | "delegates" | "returns";
}

export interface LiveSnapshot {
  streamId: string;
  structureVersion: number;
  sequence: number;
  observedAt: string;
  scopeProjectIds: ReadonlyArray<string>;
  nodes: ReadonlyArray<LiveNode>;
  edges: ReadonlyArray<LiveEdge>;
}

function projectState(state: string): LiveState {
  switch (state) {
    case "idea":
    case "blueprint":
      return "idle";
    case "provisioned":
    case "development":
      return "busy";
    case "demo":
    case "approved":
      return "approval";
    case "production":
    case "maintained":
      return "success";
    case "archived":
    case "exported":
    case "deleted":
      return "stale";
    default:
      return "idle";
  }
}

function taskState(state: string): LiveState {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "failure";
    case "needs_approval":
      return "approval";
    case "cancelled":
    case "budget_blocked":
      return "stale";
    default:
      // draft, queued, leased, running, verifying, retry_wait
      return "busy";
  }
}

export async function buildLiveSnapshot(pool: Pool): Promise<LiveSnapshot> {
  const projects = await pool.query<{
    id: string;
    display_name: string;
    state: string;
  }>(
    "SELECT id::text, display_name, state FROM generated_projects ORDER BY created_at DESC LIMIT 50",
  );
  const tasks = await pool.query<{
    id: string;
    state: string;
    project_id: string | null;
  }>(
    `SELECT t.id::text, t.state,
            (SELECT a.attribution->>'projectId'
               FROM ai_gateway_attempts a
              WHERE a.attribution->>'taskId' = t.id::text
              LIMIT 1) AS project_id
       FROM tasks t
      ORDER BY t.id DESC
      LIMIT 400`,
  );

  const scopeProjectIds = projects.rows.map((row) => row.id);
  const projectIds = new Set(scopeProjectIds);

  const nodes: LiveNode[] = [
    {
      id: "factory",
      kind: "factory",
      label: "Polyp Factory",
      state: "busy",
      sourceHref: "/overview",
    },
  ];
  const edges: LiveEdge[] = [];

  for (const row of projects.rows) {
    nodes.push({
      id: `project:${row.id}`,
      parentId: "factory",
      projectId: row.id,
      kind: "project",
      label: row.display_name,
      state: projectState(row.state),
      sourceHref: "/projects",
    });
    edges.push({
      id: `e:factory:project:${row.id}`,
      sourceId: "factory",
      targetId: `project:${row.id}`,
      relation: "contains",
    });
  }

  for (const row of tasks.rows) {
    const projectId = row.project_id;
    if (projectId === null || !projectIds.has(projectId)) continue;
    const parentId = `project:${projectId}`;
    nodes.push({
      id: `task:${row.id}`,
      parentId,
      projectId,
      kind: "task",
      label: `task ${row.id.slice(0, 8)}`,
      state: taskState(row.state),
      sourceHref: "/runs",
    });
    edges.push({
      id: `e:project:task:${row.id}`,
      sourceId: parentId,
      targetId: `task:${row.id}`,
      relation: "contains",
    });
  }

  // structureVersion changes whenever the set of nodes/edges changes; a hash of
  // the ordered ids is stable across identical structures and cheap to compute.
  const structureVersion = hash(
    nodes.map((node) => node.id).join("|") +
      "::" +
      edges.map((edge) => edge.id).join("|"),
  );

  return {
    streamId: FACTORY_LIVE_STREAM_ID,
    structureVersion,
    sequence: 0,
    observedAt: new Date().toISOString(),
    scopeProjectIds,
    nodes,
    edges,
  };
}

function hash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
