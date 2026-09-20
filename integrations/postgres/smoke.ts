import { openPostgresPersistence } from "./node-pg.js";
import { newAgentId, newWorkspaceId } from "../../src/index.js";

const url = process.env.SYNTH_POSTGRES_URL;
if (!url) {
  console.error(JSON.stringify({ skipped: true, reason: "SYNTH_POSTGRES_URL not set; live Postgres required" }));
  process.exit(2);
}
const opened = await openPostgresPersistence({ connectionString: url });
try {
  const id = newAgentId();
  await opened.persistence.putAgent({
    id,
    definitionId: "smoke",
    workspaceId: newWorkspaceId(),
    state: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mailbox: [],
    metadata: { smoke: true },
  });
  const read = await opened.persistence.getAgent(id);
  if (!read || read.id !== id) throw new Error("Postgres smoke roundtrip failed");
  console.log(JSON.stringify({ ok: true, agentId: id }));
} finally {
  await opened.close();
}
