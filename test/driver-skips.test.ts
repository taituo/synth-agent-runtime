/**
 * Solidify the new live drivers' skip paths: a driver with no explicit model
 * list, or a refusal to run "all", must exit 2 and say so — never a vacuous
 * success. Runs the real driver scripts via tsx; no model calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEMPORAL_DIR = fileURLToPath(new URL("../../integrations/temporal/", import.meta.url));
const TSX = join(TEMPORAL_DIR, "node_modules", ".bin", "tsx");

interface RunResult {
  code: number;
  output: string;
}

async function runDriver(script: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [script], { cwd: TEMPORAL_DIR, env });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function tsxAvailable(): Promise<boolean> {
  try {
    await access(TSX);
    return true;
  } catch {
    return false;
  }
}

const DRIVERS = ["corpus-model-compare.ts", "rate-limit-scope.ts"] as const;

for (const driver of DRIVERS) {
  test(`${driver}: no MODELS is a skip with exit 2`, async (t) => {
    if (!(await tsxAvailable())) return t.skip("tsx not installed");
    const env = { ...process.env };
    delete env.MODELS;
    const result = await runDriver(driver, env);
    assert.equal(result.code, 2, `expected skip exit 2, got ${result.code}: ${result.output}`);
    assert.match(result.output, /skipped/);
  });

  test(`${driver}: MODELS=all is refused with exit 2`, async (t) => {
    if (!(await tsxAvailable())) return t.skip("tsx not installed");
    const result = await runDriver(driver, { ...process.env, MODELS: "all" });
    assert.equal(result.code, 2, `expected refusal exit 2, got ${result.code}: ${result.output}`);
    assert.match(result.output, /skipped/);
  });
}
