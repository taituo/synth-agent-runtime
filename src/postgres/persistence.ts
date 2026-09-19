import type { AgentId, ArtifactId, ProjectId, TaskId, WorkspaceId } from "../core/ids.js";
import type { AgentSnapshot, Artifact, Relation, RuntimeEvent, TaskSpec } from "../core/types.js";
import type { AgentWriteFence, DurabilityProvider, EventCursor, EventReadOptions, SequencedRuntimeEvent } from "../durability/types.js";
import type {
  ClaimResult,
  DurableCommandRecord,
  DurableEffectRecord,
  DurableTurnRecord,
  DurableWorkspaceCheckpoint,
  RuntimeStateStore,
  TurnStatus,
} from "../durability/runtime-state.js";
import type { ArtifactCasResult, ProjectProjection, ProjectSpec, TaskCasResult, WorldCasResult, WorldStore } from "../world/types.js";
import type { PgExecutor } from "./types.js";

interface BodyRow { body: unknown }

/**
 * One Postgres-backed implementation for runtime durability, transactional
 * receipts, and the canonical project/spec world.
 *
 * It deliberately uses simple UPSERTs + JSONB so schema evolution of agent
 * records is decoupled from SQL migrations. Identity/status columns remain
 * relational for atomic claims and recovery scans.
 */
export class PostgresPersistence implements DurabilityProvider, RuntimeStateStore, WorldStore {
  constructor(readonly db: PgExecutor) {}

  async createAgent(snapshot: AgentSnapshot): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO synth_agents(id,body,fencing_token,updated_at) VALUES ($1,$2::jsonb,0,now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [snapshot.id, encode(snapshot)],
    );
    return result.rows.length > 0;
  }

  async putAgent(snapshot: AgentSnapshot): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO synth_agents(id,body,fencing_token,updated_at) VALUES ($1,$2::jsonb,0,now())
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()
       WHERE synth_agents.fencing_token=0
       RETURNING id`,
      [snapshot.id, encode(snapshot)],
    );
    if (!result.rows.length) throw new Error(`AGENT_FENCE_REQUIRED:${snapshot.id}`);
  }

  async putAgentFenced(snapshot: AgentSnapshot, fence: AgentWriteFence): Promise<boolean> {
    if (fence.resourceId !== `agent:${snapshot.id}`) return false;
    const result = await this.db.query<{ id: string }>(
      `WITH db_clock AS (
         SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
       )
       INSERT INTO synth_agents(id,body,fencing_token,updated_at)
       SELECT $1,$2::jsonb,$5,now()
       FROM synth_leases, db_clock
       WHERE synth_leases.resource_id=$3
         AND synth_leases.owner_id=$4
         AND synth_leases.fencing_token=$5
         AND synth_leases.expires_at_ms>db_clock.now_ms
       ON CONFLICT (id) DO UPDATE SET
         body=EXCLUDED.body, fencing_token=EXCLUDED.fencing_token, updated_at=now()
       WHERE synth_agents.fencing_token<=EXCLUDED.fencing_token
       RETURNING id`,
      [snapshot.id, encode(snapshot), fence.resourceId, fence.ownerId, fence.fencingToken],
    );
    return result.rows.length > 0;
  }
  async getAgent(id: AgentId): Promise<AgentSnapshot | undefined> {
    return this.getBody<AgentSnapshot>("synth_agents", "id", id);
  }
  async listAgents(): Promise<AgentSnapshot[]> {
    return this.listBodies<AgentSnapshot>("synth_agents", "id");
  }

  async putTask(task: TaskSpec): Promise<void> {
    await upsertBody(this.db, "synth_tasks", "id", task.id, task);
  }
  async compareAndSwapTask(task: TaskSpec, expectedRevision: number): Promise<TaskCasResult> {
    const next: TaskSpec = { ...task, revision: expectedRevision + 1 };
    const result = await this.db.query<BodyRow>(
      `UPDATE synth_tasks SET body=$2::jsonb, updated_at=now()
       WHERE id=$1 AND COALESCE((body->>'revision')::bigint,0)=$3
       RETURNING body`,
      [task.id, encode(next), expectedRevision],
    );
    if (result.rows.length) return { swapped: true, task: decode<TaskSpec>(result.rows[0]!.body) };
    const current = await this.getTask(task.id);
    if (!current) throw new Error(`Unknown task ${task.id}`);
    return { swapped: false, task: current };
  }
  async getTask(id: TaskId): Promise<TaskSpec | undefined> {
    return this.getBody<TaskSpec>("synth_tasks", "id", id);
  }

  async putRelation(relation: Relation): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_relations(from_id,to_id,kind,body,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (from_id,to_id,kind) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`,
      [relation.from, relation.to, relation.kind, encode(relation)],
    );
  }
  async listRelations(): Promise<Relation[]> {
    const result = await this.db.query<BodyRow>(
      `SELECT body FROM synth_relations ORDER BY from_id,to_id,kind`,
    );
    return result.rows.map((row) => decode<Relation>(row.body));
  }

  async appendEvent(event: RuntimeEvent): Promise<void> {
    await this.db.query(`INSERT INTO synth_events(body) VALUES ($1::jsonb)`, [encode(event)]);
  }
  async listEvents(): Promise<RuntimeEvent[]> {
    const result = await this.db.query<BodyRow>(`SELECT body FROM synth_events ORDER BY seq`);
    return result.rows.map((row) => decode<RuntimeEvent>(row.body));
  }
  async readEvents(options: EventReadOptions = {}): Promise<SequencedRuntimeEvent[]> {
    const after = options.afterSeq ?? 0;
    const limit = Math.max(0, options.limit ?? 1000);
    const result = await this.db.query<{ seq: string | number; body: unknown }>(
      `SELECT seq,body FROM synth_events WHERE seq>$1 ORDER BY seq LIMIT $2`,
      [after, limit],
    );
    return result.rows.map((row) => ({ seq: Number(row.seq), event: decode<RuntimeEvent>(row.body) }));
  }
  async pruneEvents(throughSeq: number): Promise<number> {
    const result = await this.db.query<{ seq: string | number }>(`DELETE FROM synth_events WHERE seq<=$1 RETURNING seq`, [throughSeq]);
    return result.rows.length;
  }
  async ackEvent(consumerId: string, throughSeq: number): Promise<EventCursor> {
    // Clamp to the current max seq and keep the ack monotonic, mirroring
    // ackMailbox. GREATEST on the stored value makes a regressing ack a no-op.
    const result = await this.db.query<{ ack_seq: string | number; updated_at_ms: string | number }>(
      `WITH max_seq AS (SELECT COALESCE(MAX(seq),0) AS seq FROM synth_events)
       INSERT INTO synth_event_cursors(consumer_id,ack_seq,updated_at_ms)
       SELECT $1, LEAST($2::bigint, max_seq.seq), $3 FROM max_seq
       ON CONFLICT (consumer_id) DO UPDATE SET
         ack_seq=GREATEST(synth_event_cursors.ack_seq, EXCLUDED.ack_seq),
         updated_at_ms=EXCLUDED.updated_at_ms
       RETURNING ack_seq, updated_at_ms`,
      [consumerId, throughSeq, Date.now()],
    );
    const row = result.rows[0]!;
    return { consumerId, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) };
  }
  async getEventCursor(consumerId: string): Promise<EventCursor | undefined> {
    const result = await this.db.query<{ consumer_id: string; ack_seq: string | number; updated_at_ms: string | number }>(
      `SELECT consumer_id,ack_seq,updated_at_ms FROM synth_event_cursors WHERE consumer_id=$1`,
      [consumerId],
    );
    const row = result.rows[0];
    return row ? { consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) } : undefined;
  }
  async listEventCursors(): Promise<EventCursor[]> {
    const result = await this.db.query<{ consumer_id: string; ack_seq: string | number; updated_at_ms: string | number }>(
      `SELECT consumer_id,ack_seq,updated_at_ms FROM synth_event_cursors`,
    );
    return result.rows.map((row) => ({ consumerId: row.consumer_id, ackSeq: Number(row.ack_seq), updatedAt: Number(row.updated_at_ms) }));
  }
  async forgetEventConsumer(consumerId: string): Promise<boolean> {
    const result = await this.db.query<{ consumer_id: string }>(
      `DELETE FROM synth_event_cursors WHERE consumer_id=$1 RETURNING consumer_id`,
      [consumerId],
    );
    return result.rows.length > 0;
  }
  async safeEventWatermark(): Promise<number> {
    const result = await this.db.query<{ watermark: string | number | null }>(
      `SELECT COALESCE(MIN(ack_seq),0) AS watermark FROM synth_event_cursors`,
    );
    return Number(result.rows[0]?.watermark ?? 0);
  }
  async pruneEventsSafe(): Promise<number> {
    const watermark = await this.safeEventWatermark();
    return watermark <= 0 ? 0 : this.pruneEvents(watermark);
  }

  async putCommand(record: DurableCommandRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_commands(id,status,body,updated_at) VALUES ($1,$2,$3::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, body=EXCLUDED.body, updated_at=now()
       WHERE
         COALESCE((synth_commands.body->>'fencingToken')::bigint,0) <= COALESCE((EXCLUDED.body->>'fencingToken')::bigint,0)
         AND NOT (synth_commands.status='committed' AND EXCLUDED.status<>'committed')`,
      [record.id, record.status, encode(record)],
    );
  }
  async getCommand(id: string): Promise<DurableCommandRecord | undefined> {
    return this.getBody<DurableCommandRecord>("synth_commands", "id", id);
  }
  async claimCommand(record: DurableCommandRecord): Promise<ClaimResult<DurableCommandRecord>> {
    const claimed = await this.db.query<BodyRow>(
      `INSERT INTO synth_commands(id,status,body,updated_at) VALUES ($1,$2,$3::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, body=EXCLUDED.body, updated_at=now()
       WHERE synth_commands.status = 'failed'
       RETURNING body`,
      [record.id, record.status, encode(record)],
    );
    if (claimed.rows.length) return { claimed: true, record: decode<DurableCommandRecord>(claimed.rows[0]!.body) };
    const existing = await this.getCommand(record.id);
    if (!existing) throw new Error(`Command claim lost without visible record: ${record.id}`);
    return { claimed: false, record: existing };
  }

  async putWorkspaceCheckpoint(checkpoint: DurableWorkspaceCheckpoint): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_workspace_checkpoints(workspace_id,body,created_at) VALUES ($1,$2::jsonb,now())
       ON CONFLICT (workspace_id) DO UPDATE SET body=EXCLUDED.body, created_at=now()`,
      [checkpoint.workspaceId, encode(checkpoint)],
    );
  }
  async getWorkspaceCheckpoint(workspaceId: WorkspaceId): Promise<DurableWorkspaceCheckpoint | undefined> {
    return this.getBody<DurableWorkspaceCheckpoint>("synth_workspace_checkpoints", "workspace_id", workspaceId);
  }

  async putTurn(record: DurableTurnRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO synth_turns(id,status,workspace_id,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, workspace_id=EXCLUDED.workspace_id, body=EXCLUDED.body, updated_at=now()`,
      [record.id, record.status, record.workspaceId, encode(record)],
    );
  }
  async getTurn(id: string): Promise<DurableTurnRecord | undefined> {
    return this.getBody<DurableTurnRecord>("synth_turns", "id", id);
  }
  async listTurns(status?: TurnStatus): Promise<DurableTurnRecord[]> {
    const result = status === undefined
      ? await this.db.query<BodyRow>(`SELECT body FROM synth_turns ORDER BY updated_at,id`)
      : await this.db.query<BodyRow>(`SELECT body FROM synth_turns WHERE status=$1 ORDER BY updated_at,id`, [status]);
    return result.rows.map((row) => decode<DurableTurnRecord>(row.body));
  }

  async putEffect(record: DurableEffectRecord): Promise<void> {
    // Mirrors canReplaceEffect: a committed receipt may only be replaced by
    // another committed receipt, and a failed receipt cannot be regressed to
    // started by a stale/uncertain writer.
    await this.db.query(
      `INSERT INTO synth_effects(id,status,kind,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, kind=EXCLUDED.kind, body=EXCLUDED.body, updated_at=now()
       WHERE NOT (synth_effects.status='committed' AND EXCLUDED.status<>'committed')
         AND NOT (synth_effects.status='failed' AND EXCLUDED.status='started')`,
      [record.id, record.status, record.kind, encode(record)],
    );
  }
  async getEffect(id: string): Promise<DurableEffectRecord | undefined> {
    return this.getBody<DurableEffectRecord>("synth_effects", "id", id);
  }
  async claimEffect(record: DurableEffectRecord): Promise<ClaimResult<DurableEffectRecord>> {
    const claimed = await this.db.query<BodyRow>(
      `INSERT INTO synth_effects(id,status,kind,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO NOTHING
       RETURNING body`,
      [record.id, record.status, record.kind, encode(record)],
    );
    if (claimed.rows.length) return { claimed: true, record: decode<DurableEffectRecord>(claimed.rows[0]!.body) };
    const existing = await this.getEffect(record.id);
    if (!existing) throw new Error(`Effect claim lost without visible record: ${record.id}`);
    return { claimed: false, record: existing };
  }

  async putProject(project: ProjectSpec): Promise<void> {
    const next = { ...project, revision: project.revision ?? 0 };
    const result = await this.db.query<BodyRow>(
      `INSERT INTO synth_projects(id,body,updated_at) VALUES ($1,$2::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body,updated_at=now()
       WHERE COALESCE((EXCLUDED.body->>'revision')::bigint,0) > COALESCE((synth_projects.body->>'revision')::bigint,0)
       RETURNING body`,
      [project.id, encode(next)],
    );
    if (!result.rows.length) {
      const current = await this.getProject(project.id);
      if (current) throw new Error(`WORLD_PUT_REQUIRES_NEWER_REVISION:${project.id}:${current.revision}`);
    }
  }
  async compareAndSwapProject(project: ProjectSpec, expectedRevision: number): Promise<WorldCasResult> {
    const next: ProjectSpec = { ...project, revision: expectedRevision + 1, updatedAt: Date.now() };
    const result = await this.db.query<BodyRow>(
      `UPDATE synth_projects SET body=$2::jsonb, updated_at=now()
       WHERE id=$1 AND COALESCE((body->>'revision')::bigint,0)=$3
       RETURNING body`,
      [project.id, encode(next), expectedRevision],
    );
    if (result.rows.length) return { swapped: true, project: decode<ProjectSpec>(result.rows[0]!.body) };
    const current = await this.getProject(project.id);
    if (!current) throw new Error(`Unknown project ${project.id}`);
    return { swapped: false, project: current };
  }
  async getProject(id: ProjectId): Promise<ProjectSpec | undefined> {
    const project = await this.getBody<ProjectSpec>("synth_projects", "id", id);
    return project ? { ...project, revision: project.revision ?? 0 } : undefined;
  }
  async listProjects(): Promise<ProjectSpec[]> {
    return (await this.listBodies<ProjectSpec>("synth_projects", "id")).map((project) => ({ ...project, revision: project.revision ?? 0 }));
  }
  async putArtifact(artifact: Artifact): Promise<void> {
    await upsertBody(this.db, "synth_artifacts", "id", artifact.id, artifact);
  }
  async compareAndSwapArtifact(artifact: Artifact, expectedRevision: number): Promise<ArtifactCasResult> {
    const next: Artifact = { ...artifact, revision: expectedRevision + 1 };
    const result = await this.db.query<BodyRow>(
      `UPDATE synth_artifacts SET body=$2::jsonb, updated_at=now()
       WHERE id=$1 AND COALESCE((body->>'revision')::bigint,0)=$3
       RETURNING body`,
      [artifact.id, encode(next), expectedRevision],
    );
    if (result.rows.length) return { swapped: true, artifact: decode<Artifact>(result.rows[0]!.body) };
    const current = await this.getArtifact(artifact.id);
    if (!current) throw new Error(`Unknown artifact ${artifact.id}`);
    return { swapped: false, artifact: current };
  }
  async getArtifact(id: ArtifactId): Promise<Artifact | undefined> {
    return this.getBody<Artifact>("synth_artifacts", "id", id);
  }

  async projection(projectId: ProjectId): Promise<ProjectProjection | undefined> {
    const project = await this.getProject(projectId);
    if (!project) return undefined;
    const tasks = (await Promise.all(project.taskIds.map((id) => this.getTask(id)))).filter((v): v is TaskSpec => Boolean(v));
    const artifacts = (await Promise.all(project.artifactIds.map((id) => this.getArtifact(id)))).filter((v): v is Artifact => Boolean(v));
    const constraints = project.constraints.filter((c) => c.active).map((c) => `- ${c.text}`);
    const decisions = project.decisions.filter((d) => d.status === "accepted").map((d) => `- ${d.title}: ${d.rationale}`);
    const taskLines = tasks.map((task) => `- [${task.status}] ${task.title}: ${task.objective}`);
    const contextText = [
      `# Project: ${project.name}`,
      project.objective,
      constraints.length ? `\n## Constraints\n${constraints.join("\n")}` : "",
      decisions.length ? `\n## Accepted decisions\n${decisions.join("\n")}` : "",
      taskLines.length ? `\n## Tasks\n${taskLines.join("\n")}` : "",
    ].filter(Boolean).join("\n");
    return { project, tasks, artifacts, contextText };
  }

  private async getBody<T>(table: string, key: string, value: string): Promise<T | undefined> {
    identifier(table); identifier(key);
    const result = await this.db.query<BodyRow>(`SELECT body FROM ${table} WHERE ${key}=$1`, [value]);
    const row = result.rows[0];
    return row ? decode<T>(row.body) : undefined;
  }

  private async listBodies<T>(table: string, orderBy: string): Promise<T[]> {
    identifier(table); identifier(orderBy);
    const result = await this.db.query<BodyRow>(`SELECT body FROM ${table} ORDER BY ${orderBy}`);
    return result.rows.map((row) => decode<T>(row.body));
  }
}

async function upsertBody(db: PgExecutor, table: string, key: string, value: string, body: unknown): Promise<void> {
  identifier(table); identifier(key);
  await db.query(
    `INSERT INTO ${table}(${key},body,updated_at) VALUES ($1,$2::jsonb,now())
     ON CONFLICT (${key}) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`,
    [value, encode(body)],
  );
}

function identifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: unknown): T {
  return structuredClone((typeof value === "string" ? JSON.parse(value) : value) as T);
}
