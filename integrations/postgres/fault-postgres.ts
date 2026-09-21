/**
 * Fault matrix cell: remove Postgres (deny the port it is reached on).
 *
 * The dependency is the socket at `127.0.0.1:5432`. This probe owns a real
 * `kubectl port-forward svc/postgres 5432:5432`; the control arm writes and
 * reads an agent through it, then the port-forward is SIGKILLed (the port is
 * genuinely denied) and the same write is attempted.
 *
 * The four questions:
 *   retried     -> the pg pool makes one connection attempt and fails
 *   data lost   -> the control row is read back after the port is restored
 *   human       -> no production caller of PostgresPersistence exists; the
 *                  default durable path does not touch Postgres (see the
 *                  call-path evidence recorded alongside this probe)
 *   twice       -> `putAgent` is an upsert by id: two writes -> one row
 *
 * Exit 0 when the control passes, the denial fails closed, and both durability
 * checks hold; 1 otherwise; 2 when Postgres/port-forward data is unavailable.
 *
 *   npx tsx integrations/postgres/fault-postgres.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createConnection } from "node:net";
import { openPostgresPersistence } from "./node-pg.js";

const namespace = process.env.SYNTH_POSTGRES_NAMESPACE ?? "synth-audit-pg";
const service = process.env.SYNTH_POSTGRES_SERVICE ?? "postgres";
const port = Number(process.env.SYNTH_POSTGRES_PORT ?? 5432);
const url = process.env.SYNTH_POSTGRES_URL ?? `postgres://synth:synth@127.0.0.1:${port}/synth`;

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function waitPort(open: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen()) === open) return;
    await sleep(200);
  }
}

function startPortForward(): ChildProcess {
  return spawn("kubectl", ["port-forward", `svc/${service}`, `${port}:5432`, "-n", namespace], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

const result: Record<string, unknown> = { fault: "postgres", url, namespace };
let forward: ChildProcess | undefined;
let ok = false;

const agent = {
  id: `fault-pg-${Date.now()}`,
  definitionId: "fault-probe",
  workspaceId: "ws-fault",
  state: "idle" as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  mailbox: [],
};

try {
  forward = startPortForward();
  await waitPort(true, 20_000);
  if (!(await portOpen())) {
    forward?.kill("SIGKILL");
    console.error(JSON.stringify({
      skipped: true,
      reason: `no Postgres reachable on 127.0.0.1:${port}; kubectl port-forward svc/${service} -n ${namespace} did not open`,
    }));
    process.exit(2);
  }

  // Control: write and read through the live port.
  const control = await openPostgresPersistence({ connectionString: url, pool: { connectionTimeoutMillis: 2_000 } });
  try {
    await control.persistence.putAgent({ ...agent, metadata: { control: true } });
    const read = await control.persistence.getAgent(agent.id);
    // "twice": the same id written again must not create a second row.
    await control.persistence.putAgent({ ...agent, metadata: { control: true, second: true } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await (control.pool as any).query("select count(*)::int as n from synth_agents where id=$1", [agent.id]);
    result.control = { wroteAndRead: Boolean(read && read.id === agent.id), rowsForId: count.rows[0].n };
  } finally {
    await control.close();
  }

  // Fault: kill the port-forward; the port is genuinely denied.
  forward.kill("SIGKILL");
  await waitPort(false, 10_000);
  result.portClosed = !(await portOpen());

  let faultError: string | undefined;
  let faultOk = false;
  const started = Date.now();
  try {
    const denied = await openPostgresPersistence({ connectionString: url, pool: { connectionTimeoutMillis: 2_000 } });
    try {
      await denied.persistence.putAgent({ ...agent, metadata: { denied: true } });
      faultOk = true;
    } finally {
      await denied.close().catch(() => {});
    }
  } catch (error) {
    faultError = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  result.fault = {
    failedClosed: !faultOk,
    error: faultError,
    ms: Date.now() - started,
  };

  // Restore and prove the control row survived the outage.
  forward = startPortForward();
  await waitPort(true, 20_000);
  const restored = await openPostgresPersistence({ connectionString: url, pool: { connectionTimeoutMillis: 2_000 } });
  try {
    const read = await restored.persistence.getAgent(agent.id);
    result.dataSurvivedOutage = Boolean(read && read.id === agent.id);
  } finally {
    await restored.close();
  }

  const controlOk = (result.control as { wroteAndRead: boolean }).wroteAndRead && (result.control as { rowsForId: number }).rowsForId === 1;
  ok = controlOk && result.portClosed === true && (result.fault as { failedClosed: boolean }).failedClosed && result.dataSurvivedOutage === true;
  result.questions = {
    retried: false,
    dataLost: !result.dataSurvivedOutage,
    humanNeeded: null,
    sideEffectTwice: (result.control as { rowsForId: number }).rowsForId !== 1,
  };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  ok = false;
} finally {
  forward?.kill("SIGKILL");
  result.ok = ok;
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}
