#!/usr/bin/env node
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const commit = process.argv[2];
const outDir = process.argv[3] || "tmp-cert-tree";
if (!commit) {
  console.error("usage: node scripts/_extract-git-files.mjs <commit> [outdir]");
  process.exit(1);
}

const files = [
  "scripts/production-revalidate-sanita-v3.mjs",
  "scripts/production-revalidate-sanita-worker.mjs",
  "scripts/revalidate-checkpoint-v3.mjs",
  "src/lib/sanita/canonical-published-terminal.ts",
  "src/lib/sanita/crawl-slice-runner.ts",
  "src/lib/sanita/scan-engine.ts",
  "scripts/test-published-worker-canonical.mjs",
  "scripts/test-revalidation-v3.mjs",
];

const result = { commit, files: {} };
for (const rel of files) {
  let buf;
  try {
    buf = execFileSync("git", ["show", `${commit}:${rel}`]);
  } catch {
    buf = execFileSync("git", ["show", `HEAD:${rel}`]);
    console.error(`FALLBACK HEAD for ${rel}`);
  }
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  result.files[rel] = { sha256, bytes: buf.length };
  console.error(`OK ${rel} ${sha256.slice(0, 12)}… ${buf.length}`);
}
fs.writeFileSync(
  path.join(outDir, "_expected-hashes.json"),
  JSON.stringify(
    {
      commit,
      files: Object.fromEntries(
        Object.entries(result.files).filter(([k]) =>
          !k.includes("test-")
        )
      ),
    },
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify(result, null, 2));
