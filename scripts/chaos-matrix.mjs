import { spawn } from "node:child_process";

const suites = [
  "dist/test/chaos.test.js",
  "dist/test/v04.test.js",
  "dist/test/kubernetes.test.js",
  "dist/test/postgres.test.js",
];

let failures = 0;
for (const suite of suites) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", suite], { stdio: "inherit" });
    child.on("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) failures++;
}
if (failures) process.exitCode = 1;
