import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let ts;
try {
  ts = (await import("typescript")).default;
} catch {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  ts = (await import(pathToFileURL(join(globalRoot, "typescript/lib/typescript.js")).href)).default;
}

async function files(root, suffix) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith(suffix)) out.push(path);
    }
  }
  await walk(root);
  return out.sort();
}

const tsFiles = await files("integrations", ".ts");
let diagnostics = 0;
for (const file of tsFiles) {
  const source = await readFile(file, "utf8");
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext },
  });
  for (const diagnostic of result.diagnostics ?? []) {
    diagnostics++;
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    console.error(`${file}: ${text}`);
  }
}

const shellFiles = await files("integrations", ".sh");
for (const file of shellFiles) {
  const result = spawnSync("bash", ["-n", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ ok: diagnostics === 0, typescriptFiles: tsFiles.length, syntaxDiagnostics: diagnostics, shellFiles: shellFiles.length }));
if (diagnostics) process.exit(1);
