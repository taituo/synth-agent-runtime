#!/usr/bin/env node
/**
 * Mechanical secret scan. This repo is public and "scan before you push" was
 * only a habit, so it is now a command the pre-push hook and CI both run.
 *
 * It scans the git INDEX blobs (via `git cat-file --batch`), not the working
 * tree: the index is what is about to be committed and pushed, and a secret
 * staged then hidden by a differing working-tree edit must still be caught.
 * Exit 1 on any hit. A line may be exempted with a `secret-scan:allow` marker,
 * which makes the exemption explicit and reviewable rather than silent.
 *
 *   node scripts/secret-scan.mjs
 */
import { execFileSync } from "node:child_process";

const PATTERNS = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "github-token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "openrouter-key", re: /\bsk-or-[A-Za-z0-9-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
];

/** Index entries as `{ path, sha }`, straight from the index. */
function indexEntries() {
  const raw = execFileSync("git", ["ls-files", "-s", "-z"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const entries = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const sha = record.slice(0, tab).split(" ")[1];
    entries.push({ path: record.slice(tab + 1), sha });
  }
  return entries;
}

/** Read every index blob in one `git cat-file --batch` call. */
function indexContents(entries) {
  const input = `${entries.map((entry) => entry.sha).join("\n")}\n`;
  const buffer = execFileSync("git", ["cat-file", "--batch"], { input, maxBuffer: 512 * 1024 * 1024 });
  const contents = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) break;
    const header = buffer.toString("utf8", offset, newline);
    const [sha, type, sizeText] = header.split(" ");
    offset = newline + 1;
    const size = Number(sizeText);
    if (type === "missing" || !Number.isFinite(size)) continue;
    contents.set(sha, buffer.toString("utf8", offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

function redact(line) {
  return line.trim().slice(0, 160).replace(/[A-Za-z0-9_-]{20,}/g, (match) => `${match.slice(0, 4)}…${match.slice(-2)}`);
}

const entries = indexEntries();
const contents = indexContents(entries);
const hits = [];
for (const entry of entries) {
  const content = contents.get(entry.sha);
  if (content === undefined || content.includes("\0")) continue; // missing or binary
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes("secret-scan:allow")) continue;
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) hits.push({ file: entry.path, line: index + 1, pattern: pattern.name, snippet: redact(line) });
    }
  }
}

if (hits.length === 0) {
  console.log(`secret-scan: clean (${entries.length} index file(s) scanned)`);
  process.exit(0);
}
console.error(`secret-scan: ${hits.length} potential secret(s) found in the index — do not push this.`);
for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.pattern}  ${hit.snippet}`);
console.error("If a hit is a deliberate placeholder, mark that line with `secret-scan:allow`.");
process.exit(1);
