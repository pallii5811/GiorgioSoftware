#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const sha = process.argv[2] || "fe8b677a2cb4372d6f117c8534d473a51d40913b";
const files = [
  "scripts/production-revalidate-sanita-v3.mjs",
  "scripts/production-revalidate-sanita-worker.mjs",
  "scripts/revalidate-checkpoint-v3.mjs",
  "src/lib/sanita/canonical-published-terminal.ts",
  "src/lib/sanita/crawl-slice-runner.ts",
  "src/lib/sanita/scan-engine.ts",
];
const out = { commit: sha, files: {} };
for (const f of files) {
  try {
    const buf = execFileSync("git", ["show", `${sha}:${f}`]);
    out.files[f] = {
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
    };
  } catch (e) {
    out.files[f] = { error: String(e?.message || e) };
  }
}
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync("data/fe8b677-file-hashes.json", JSON.stringify(out, null, 2));
