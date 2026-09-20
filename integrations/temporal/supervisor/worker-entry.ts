/**
 * Entry point for the supervisor worker process.
 *
 * Kept as its own process so the live proof can SIGKILL and restart it and show
 * that the supervised workflow survives — the durability claim, demonstrated.
 */
import { runSupervisorWorker } from "./worker.js";

await runSupervisorWorker();
