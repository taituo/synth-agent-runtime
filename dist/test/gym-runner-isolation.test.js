/**
 * The runner boundary is named, not assumed.
 *
 *   - `sandbox` (gVisor) is the ONLY default. Agent code never runs on the host
 *     unless the caller explicitly asked for the labelled unisolated arm.
 *   - The local arm is labelled `unisolated` in the artifact and a SCORED run is
 *     refused on it: model-authored code on the host can read the held-out
 *     vectors, so a score from it would be a ground-truth leak.
 *   - Materializing a task never writes the hidden vectors (or the hidden test)
 *     into the checkout the agent/pod sees; only the visible test is planted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertScoredRunnerAllowed, DEFAULT_GYM_RUNNER, describeGymRunner, loadGymTask, materializeGymTask, parseGymRunner, UnisolatedScoredRunError, DEFAULT_GYM_FIXTURE_CACHE_DIR, GymFixtureUnavailableError, HIDDEN_CASES_FIXTURE, } from "../src/index.js";
const HE_TASK = "test/fixtures/gym-tasks/he/hex-decode";
test("the default runner is sandbox/gVisor, and local is explicitly unisolated", () => {
    assert.equal(DEFAULT_GYM_RUNNER, "sandbox");
    assert.equal(parseGymRunner(undefined), "sandbox");
    assert.equal(parseGymRunner(""), "sandbox");
    assert.equal(parseGymRunner("local"), "local");
    const sandbox = describeGymRunner("sandbox");
    assert.equal(sandbox.isolation, "gvisor");
    assert.equal(sandbox.isolated, true);
    assert.equal(sandbox.scoredAllowed, true);
    const local = describeGymRunner("local");
    assert.equal(local.isolation, "unisolated");
    assert.equal(local.label, "unisolated");
    assert.equal(local.isolated, false);
    assert.equal(local.scoredAllowed, false);
});
test("an unknown runner value is rejected, not silently treated as the default", () => {
    assert.throws(() => parseGymRunner("gvisor"), /unknown runner/);
    assert.throws(() => parseGymRunner("host"), /unknown runner/);
});
test("a scored run is refused on the local arm and allowed on the sandbox arm", () => {
    assert.doesNotThrow(() => assertScoredRunnerAllowed("sandbox"));
    assert.throws(() => assertScoredRunnerAllowed("local"), UnisolatedScoredRunError);
});
test("materializing a task does not plant the hidden vectors or the hidden test", async (t) => {
    const task = await loadGymTask(HE_TASK);
    let work;
    try {
        work = await mkdtemp(join(tmpdir(), "gym-runner-iso-"));
        const materialized = await materializeGymTask({ task, workDir: work, fixtureCacheDir: DEFAULT_GYM_FIXTURE_CACHE_DIR });
        // Walk the checkout the agent (and the sandbox's TreeSource) sees.
        const found = [];
        const walk = async (dir, rel = "") => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (entry.name === ".git")
                    continue;
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory())
                    await walk(join(dir, entry.name), childRel);
                else
                    found.push(childRel);
            }
        };
        await walk(materialized.repoDir);
        assert.ok(found.some((path) => path.endsWith(task.visibleTestPath) || path === task.visibleTestPath), `the visible test must be planted; saw ${found.join(", ")}`);
        assert.ok(!found.some((path) => path.includes(HIDDEN_CASES_FIXTURE)), `hidden.cases.json must never reach the checkout; saw ${found.join(", ")}`);
        assert.ok(!found.some((path) => path.includes("hidden.test.mjs")), `the hidden test must never reach the checkout; saw ${found.join(", ")}`);
        assert.ok(!existsSync(join(materialized.repoDir, "test", HIDDEN_CASES_FIXTURE)), "hidden.cases.json must not exist in the checkout");
    }
    catch (error) {
        if (error instanceof GymFixtureUnavailableError) {
            t.skip(error.message);
            return;
        }
        throw error;
    }
    finally {
        if (work)
            await rm(work, { recursive: true, force: true });
    }
});
