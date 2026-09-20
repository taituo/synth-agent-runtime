import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { MemoryExecutionEnv, StaticTreeSource } from "../../../src/harness/env/memory.ts";
import { applyShellOutputUpdate } from "../../../src/harness/utils/output-capture.ts";
import type { ShellOutputView } from "../../../src/harness/types.ts";

function source() {
	return new StaticTreeSource({
		revision: {
			kind: "git",
			remote: "https://example.invalid/demo.git",
			ref: "main",
			commit: "0123456789012345678901234567890123456789",
		},
		files: [
			{ path: "README.md", content: "hello\n" },
			{ path: "src/a.ts", content: "export const a = 1;\n" },
		],
	});
}

async function execText(env: MemoryExecutionEnv, command: string): Promise<{ text: string; exitCode: number }> {
	let view: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			capture: { limits: { maxBytes: 1024 * 1024, maxLines: 10000, retain: "tail" } },
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		BACKGROUND_CONTEXT,
	);
	if (!result.ok) throw result.error;
	return { text: view?.text ?? "", exitCode: result.value.exitCode };
}

describe("MemoryExecutionEnv synthetic git", () => {
	it("reads immutable source lazily and keeps edits in memory", async () => {
		const env = new MemoryExecutionEnv({ source: source() });
		const before = await env.readTextFile("src/a.ts", BACKGROUND_CONTEXT);
		expect(before.ok && before.value).toBe("export const a = 1;\n");

		const write = await env.writeFile("src/a.ts", "export const a = 2;\n", BACKGROUND_CONTEXT);
		expect(write.ok).toBe(true);
		const after = await env.readTextFile("src/a.ts", BACKGROUND_CONTEXT);
		expect(after.ok && after.value).toBe("export const a = 2;\n");
	});

	it("exposes git status and diff without a .git directory", async () => {
		const env = new MemoryExecutionEnv({ source: source() });
		await env.writeFile("src/a.ts", "export const a = 2;\n", BACKGROUND_CONTEXT);
		await env.writeFile("src/new.ts", "export const n = 1;\n", BACKGROUND_CONTEXT);

		const status = await execText(env, "git status --short");
		expect(status.exitCode).toBe(0);
		expect(status.text).toContain("M src/a.ts");
		expect(status.text).toContain("?? src/new.ts");

		const diff = await execText(env, "git diff");
		expect(diff.text).toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(diff.text).toContain("export const a = 2;");
	});

	it("supports pipelines and redirection entirely in memory", async () => {
		const env = new MemoryExecutionEnv({ source: source() });
		const run = await execText(env, "cat README.md | grep hello > /tmp/match.txt");
		expect(run.exitCode).toBe(0);
		const file = await env.readTextFile("/tmp/match.txt", BACKGROUND_CONTEXT);
		expect(file.ok && file.value).toBe("hello\n");
	});

	it("never falls through to host executables", async () => {
		const env = new MemoryExecutionEnv({ source: source() });
		const run = await execText(env, "node -e 'process.exit(0)'");
		expect(run.exitCode).toBe(127);
		expect(run.text).toContain("command not available in synthetic environment");
	});

	it("forks workspace state independently", async () => {
		const parent = new MemoryExecutionEnv({ source: source() });
		const child = parent.fork();
		await child.writeFile("README.md", "child\n", BACKGROUND_CONTEXT);
		const parentRead = await parent.readTextFile("README.md", BACKGROUND_CONTEXT);
		const childRead = await child.readTextFile("README.md", BACKGROUND_CONTEXT);
		expect(parentRead.ok && parentRead.value).toBe("hello\n");
		expect(childRead.ok && childRead.value).toBe("child\n");
	});
});
