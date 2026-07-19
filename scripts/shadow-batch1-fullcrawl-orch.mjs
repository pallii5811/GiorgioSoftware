#!/usr/bin/env node
/**
 * Orchestrator: runs fullcrawl-one per ID with OS-level timeout (hard kill).
 * Resumes skipping IDs already in results.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, "data/shadow/crawl/fullcrawl-results.jsonl");
const DOCS = path.join(ROOT, "docs/shadow/batch1-completion");
const TIMEOUT_MS = Number(process.env.SHADOW_CRAWL_LEAD_MS || 360_000);
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("DATABASE_URL required");
  process.exit(78);
}

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

const camp = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/shadow/batch1/sanita-selection-campania.json"), "utf8"));
const ven = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/shadow/batch1/sanita-selection-veneto.json"), "utf8"));
const ids = [
  ...camp.ids.map((id) => ({ id, region: "Campania" })),
  ...ven.ids.map((id) => ({ id, region: "Veneto" })),
];
const selectionHash = createHash("sha256").update(ids.map((x) => x.id).join(",")).digest("hex");

const done = new Set();
if (fs.existsSync(RESULTS)) {
  for (const line of fs.readFileSync(RESULTS, "utf8").split(/\n+/).filter(Boolean)) {
    try {
      done.add(JSON.parse(line).id);
    } catch {
      /* */
    }
  }
}

const env = {
  ...process.env,
  SHADOW_MODE: "true",
  SHADOW_DATABASE_ID: process.env.SHADOW_DATABASE_ID || "giorgio-shadow-20260718-rerun",
  SHADOW_RUN_ID: process.env.SHADOW_RUN_ID || "shadow-batch1-fullcrawl-20260718",
  SHADOW_ALLOW_DB_WRITE: "true",
  SHADOW_ALLOW_APPLY: "1",
  ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE: "true",
  DISABLE_EMAILS: "true",
  DISABLE_WEBHOOKS: "true",
  DISABLE_CUSTOMER_NOTIFICATIONS: "true",
  DISABLE_PUBLIC_QUEUE_PUBLISH: "true",
  DISABLE_PRODUCTION_CRON: "true",
  POLICY_EXHAUSTIVE: "1",
  OCR_ENABLED: "1",
  SCAN_FAST: "0",
  SCAN_ENGINE_LOCAL: "1",
  DATABASE_URL: DB,
};

function runOne(id, region) {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["tsx", "scripts/shadow-batch1-fullcrawl-one.mjs", id, region],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* */
        }
      }, 5000);
      // record timeout row if child didn't write
      const existing = fs.existsSync(RESULTS)
        ? fs.readFileSync(RESULTS, "utf8").includes(`"id":"${id}"`)
        : false;
      if (!existing) {
        fs.appendFileSync(
          RESULTS,
          JSON.stringify({
            id,
            region,
            newVerdict: "REVIEW",
            identityStatus: "TECHNICALLY_UNVERIFIABLE",
            crawlComplete: false,
            technicalFailure: true,
            error: `HARD_TIMEOUT:${TIMEOUT_MS}`,
            oldVerdict: "?",
            durationMs: TIMEOUT_MS,
          }) + "\n"
        );
      }
      resolve({ id, timedOut: true, out, err });
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ id, code, timedOut: false, out: out.slice(-500), err: err.slice(-300) });
    });
  });
}

const queue = ids.filter((x) => !done.has(x.id));
console.log(JSON.stringify({ selectionHash, done: done.size, remaining: queue.length, timeoutMs: TIMEOUT_MS }));

for (let i = 0; i < queue.length; i++) {
  const { id, region } = queue[i];
  console.log(`[${i + 1}/${queue.length}] ${region} ${id}`);
  const r = await runOne(id, region);
  console.log(JSON.stringify(r));
}

const all = fs
  .readFileSync(RESULTS, "utf8")
  .split(/\n+/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function metrics(region) {
  const rows = all.filter((r) => r.region === region);
  return {
    selected: 25,
    completed: rows.length,
    identityVerified: rows.filter((r) =>
      ["OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED"].includes(r.identityStatus)
    ).length,
    identityUnverified: rows.filter(
      (r) => !["OFFICIAL_CONFIRMED", "GROUP_OFFICIAL_CONFIRMED"].includes(r.identityStatus)
    ).length,
    notChecked: rows.filter((r) => r.identityStatus === "NOT_CHECKED").length,
    crawlComplete: rows.filter((r) => r.crawlComplete).length,
    HOT: rows.filter((r) => r.newVerdict === "HOT").length,
    PUBLISHED: rows.filter((r) => r.newVerdict === "PUBLISHED").length,
    REVIEW: rows.filter((r) => r.newVerdict === "REVIEW").length,
    technicalFailure: rows.filter((r) => r.technicalFailure).length,
  };
}

const summary = {
  selectionHash,
  processed: all.length,
  campania: metrics("Campania"),
  veneto: metrics("Veneto"),
  completedAll: all.length >= 50,
};
fs.writeFileSync(path.join(DOCS, "fullcrawl-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.completedAll ? 0 : 3);
