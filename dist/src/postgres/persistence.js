/**
 * One Postgres-backed implementation for runtime durability, transactional
 * receipts, and the canonical project/spec world.
 *
 * It deliberately uses simple UPSERTs + JSONB so schema evolution of agent
 * records is decoupled from SQL migrations. Identity/status columns remain
 * relational for atomic claims and recovery scans.
 */
export class PostgresPersistence {
    db;
    constructor(db) {
        this.db = db;
    }
    async createAgent(snapshot) {
        const result = await this.db.query(`INSERT INTO synth_agents(id,body,fencing_token,updated_at) VALUES ($1,$2::jsonb,0,now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`, [snapshot.id, encode(snapshot)]);
        return result.rows.length > 0;
    }
    async putAgent(snapshot) {
        const result = await this.db.query(`INSERT INTO synth_agents(id,body,fencing_token,updated_at) VALUES ($1,$2::jsonb,0,now())
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()
       WHERE synth_agents.fencing_token=0
       RETURNING id`, [snapshot.id, encode(snapshot)]);
        if (!result.rows.length)
            throw new Error(`AGENT_FENCE_REQUIRED:${snapshot.id}`);
    }
    async putAgentFenced(snapshot, fence) {
        if (fence.resourceId !== `agent:${snapshot.id}`)
            return false;
        const result = await this.db.query(`WITH db_clock AS (
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
       RETURNING id`, [snapshot.id, encode(snapshot), fence.resourceId, fence.ownerId, fence.fencingToken]);
        return result.rows.length > 0;
    }
    async getAgent(id) {
        return this.getBody("synth_agents", "id", id);
    }
    async listAgents() {
        return this.listBodies("synth_agents", "id");
    }
    async putTask(task) {
        await upsertBody(this.db, "synth_tasks", "id", task.id, task);
    }
    async getTask(id) {
        return this.getBody("synth_tasks", "id", id);
    }
    async putRelation(relation) {
        await this.db.query(`INSERT INTO synth_relations(from_id,to_id,kind,body,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (from_id,to_id,kind) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`, [relation.from, relation.to, relation.kind, encode(relation)]);
    }
    async listRelations() {
        const result = await this.db.query(`SELECT body FROM synth_relations ORDER BY from_id,to_id,kind`);
        return result.rows.map((row) => decode(row.body));
    }
    async appendEvent(event) {
        await this.db.query(`INSERT INTO synth_events(body) VALUES ($1::jsonb)`, [encode(event)]);
    }
    async listEvents() {
        const result = await this.db.query(`SELECT body FROM synth_events ORDER BY seq`);
        return result.rows.map((row) => decode(row.body));
    }
    async readEvents(options = {}) {
        const after = options.afterSeq ?? 0;
        const limit = Math.max(0, options.limit ?? 1000);
        const result = await this.db.query(`SELECT seq,body FROM synth_events WHERE seq>$1 ORDER BY seq LIMIT $2`, [after, limit]);
        return result.rows.map((row) => ({ seq: Number(row.seq), event: decode(row.body) }));
    }
    async pruneEvents(throughSeq) {
        const result = await this.db.query(`DELETE FROM synth_events WHERE seq<=$1 RETURNING seq`, [throughSeq]);
        return result.rows.length;
    }
    async putCommand(record) {
        await this.db.query(`INSERT INTO synth_commands(id,status,body,updated_at) VALUES ($1,$2,$3::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, body=EXCLUDED.body, updated_at=now()
       WHERE
         COALESCE((synth_commands.body->>'fencingToken')::bigint,0) <= COALESCE((EXCLUDED.body->>'fencingToken')::bigint,0)
         AND NOT (synth_commands.status='committed' AND EXCLUDED.status<>'committed')`, [record.id, record.status, encode(record)]);
    }
    async getCommand(id) {
        return this.getBody("synth_commands", "id", id);
    }
    async claimCommand(record) {
        const claimed = await this.db.query(`INSERT INTO synth_commands(id,status,body,updated_at) VALUES ($1,$2,$3::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, body=EXCLUDED.body, updated_at=now()
       WHERE synth_commands.status = 'failed'
       RETURNING body`, [record.id, record.status, encode(record)]);
        if (claimed.rows.length)
            return { claimed: true, record: decode(claimed.rows[0].body) };
        const existing = await this.getCommand(record.id);
        if (!existing)
            throw new Error(`Command claim lost without visible record: ${record.id}`);
        return { claimed: false, record: existing };
    }
    async putWorkspaceCheckpoint(checkpoint) {
        await this.db.query(`INSERT INTO synth_workspace_checkpoints(workspace_id,body,created_at) VALUES ($1,$2::jsonb,now())
       ON CONFLICT (workspace_id) DO UPDATE SET body=EXCLUDED.body, created_at=now()`, [checkpoint.workspaceId, encode(checkpoint)]);
    }
    async getWorkspaceCheckpoint(workspaceId) {
        return this.getBody("synth_workspace_checkpoints", "workspace_id", workspaceId);
    }
    async putTurn(record) {
        await this.db.query(`INSERT INTO synth_turns(id,status,workspace_id,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, workspace_id=EXCLUDED.workspace_id, body=EXCLUDED.body, updated_at=now()`, [record.id, record.status, record.workspaceId, encode(record)]);
    }
    async getTurn(id) {
        return this.getBody("synth_turns", "id", id);
    }
    async listTurns(status) {
        const result = status === undefined
            ? await this.db.query(`SELECT body FROM synth_turns ORDER BY updated_at,id`)
            : await this.db.query(`SELECT body FROM synth_turns WHERE status=$1 ORDER BY updated_at,id`, [status]);
        return result.rows.map((row) => decode(row.body));
    }
    async putEffect(record) {
        await this.db.query(`INSERT INTO synth_effects(id,status,kind,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, kind=EXCLUDED.kind, body=EXCLUDED.body, updated_at=now()`, [record.id, record.status, record.kind, encode(record)]);
    }
    async getEffect(id) {
        return this.getBody("synth_effects", "id", id);
    }
    async claimEffect(record) {
        const claimed = await this.db.query(`INSERT INTO synth_effects(id,status,kind,body,updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (id) DO NOTHING
       RETURNING body`, [record.id, record.status, record.kind, encode(record)]);
        if (claimed.rows.length)
            return { claimed: true, record: decode(claimed.rows[0].body) };
        const existing = await this.getEffect(record.id);
        if (!existing)
            throw new Error(`Effect claim lost without visible record: ${record.id}`);
        return { claimed: false, record: existing };
    }
    async putProject(project) {
        const next = { ...project, revision: project.revision ?? 0 };
        const result = await this.db.query(`INSERT INTO synth_projects(id,body,updated_at) VALUES ($1,$2::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body,updated_at=now()
       WHERE COALESCE((EXCLUDED.body->>'revision')::bigint,0) > COALESCE((synth_projects.body->>'revision')::bigint,0)
       RETURNING body`, [project.id, encode(next)]);
        if (!result.rows.length) {
            const current = await this.getProject(project.id);
            if (current)
                throw new Error(`WORLD_PUT_REQUIRES_NEWER_REVISION:${project.id}:${current.revision}`);
        }
    }
    async compareAndSwapProject(project, expectedRevision) {
        const next = { ...project, revision: expectedRevision + 1, updatedAt: Date.now() };
        const result = await this.db.query(`UPDATE synth_projects SET body=$2::jsonb, updated_at=now()
       WHERE id=$1 AND COALESCE((body->>'revision')::bigint,0)=$3
       RETURNING body`, [project.id, encode(next), expectedRevision]);
        if (result.rows.length)
            return { swapped: true, project: decode(result.rows[0].body) };
        const current = await this.getProject(project.id);
        if (!current)
            throw new Error(`Unknown project ${project.id}`);
        return { swapped: false, project: current };
    }
    async getProject(id) {
        const project = await this.getBody("synth_projects", "id", id);
        return project ? { ...project, revision: project.revision ?? 0 } : undefined;
    }
    async listProjects() {
        return (await this.listBodies("synth_projects", "id")).map((project) => ({ ...project, revision: project.revision ?? 0 }));
    }
    async putArtifact(artifact) {
        await upsertBody(this.db, "synth_artifacts", "id", artifact.id, artifact);
    }
    async getArtifact(id) {
        return this.getBody("synth_artifacts", "id", id);
    }
    async projection(projectId) {
        const project = await this.getProject(projectId);
        if (!project)
            return undefined;
        const tasks = (await Promise.all(project.taskIds.map((id) => this.getTask(id)))).filter((v) => Boolean(v));
        const artifacts = (await Promise.all(project.artifactIds.map((id) => this.getArtifact(id)))).filter((v) => Boolean(v));
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
    async getBody(table, key, value) {
        identifier(table);
        identifier(key);
        const result = await this.db.query(`SELECT body FROM ${table} WHERE ${key}=$1`, [value]);
        const row = result.rows[0];
        return row ? decode(row.body) : undefined;
    }
    async listBodies(table, orderBy) {
        identifier(table);
        identifier(orderBy);
        const result = await this.db.query(`SELECT body FROM ${table} ORDER BY ${orderBy}`);
        return result.rows.map((row) => decode(row.body));
    }
}
async function upsertBody(db, table, key, value, body) {
    identifier(table);
    identifier(key);
    await db.query(`INSERT INTO ${table}(${key},body,updated_at) VALUES ($1,$2::jsonb,now())
     ON CONFLICT (${key}) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`, [value, encode(body)]);
}
function identifier(value) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value))
        throw new Error(`Unsafe SQL identifier: ${value}`);
}
function encode(value) {
    return JSON.stringify(value);
}
function decode(value) {
    return structuredClone((typeof value === "string" ? JSON.parse(value) : value));
}
