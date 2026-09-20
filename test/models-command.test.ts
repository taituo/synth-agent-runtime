/**
 * Solidify the `models:list` command: it prints provider/profile, and a
 * gateway that lists nothing or is unreachable is exit 2, never a vacuous
 * success. Uses a real local HTTP server, not a mock of the script.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/models.mjs", import.meta.url));

function serve(body: unknown, status = 200): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function run(url?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SYNTH_GATEWAY_URL;
  delete env.GATEWAY_URL;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...(url ? [url] : [])], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("prints every model with provider and profile", async () => {
  const { server, url } = await serve({
    object: "list",
    data: [
      { object: "model", id: "cheap", provider: "opencode-go", profile: "coding" },
      { object: "model", id: "strong", owned_by: "synth-router", provider: "litellm" },
    ],
  });
  try {
    const result = await run(url);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /cheap\s+opencode-go\s+coding/);
    assert.match(result.stdout, /strong\s+litellm/);
    assert.match(result.stdout, /2 model\(s\)/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an empty catalog is exit 2, not success", async () => {
  const { server, url } = await serve({ object: "list", data: [] });
  try {
    const result = await run(url);
    assert.equal(result.code, 2, "an empty list must not look like success");
    assert.match(result.stderr, /lists no models/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unreachable gateway is exit 2", async () => {
  const result = await run("http://127.0.0.1:9");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not reachable/);
});

test("no gateway configured is exit 2", async () => {
  const result = await run(undefined);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Set SYNTH_GATEWAY_URL/);
});
