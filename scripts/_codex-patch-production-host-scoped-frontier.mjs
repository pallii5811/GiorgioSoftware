#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const target = "/opt/leadsniper/src/lib/sanita/lead-crawl-runtime.ts";
const backup =
  process.env.FRONTIER_RUNTIME_BACKUP_PATH ??
  `/opt/leadsniper/backups/lead-crawl-runtime-${new Date().toISOString().replaceAll(":", "-")}.ts`;

let source = readFileSync(target, "utf8");
if (
  source.includes("crawlRunContainsCompletedForeignSite") &&
  source.includes("hostScopedRunId")
) {
  console.log("HOST_SCOPED_FRONTIER_ALREADY_PRESENT");
  process.exit(0);
}

const eol = source.includes("\r\n") ? "\r\n" : "\n";
const lines = (value) => value.replaceAll("\n", eol);

const helperAnchor = lines(`  return defaultFrontierDbPath(runId);
}
`);
const helperInsertion = lines(`  return defaultFrontierDbPath(runId);
}

function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\\./i, "").toLowerCase();
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return host || null;
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

function hostScopedRunId(runId: string, website: string): string {
  const host = registrableDomain(website) ?? new URL(website).hostname.toLowerCase();
  return \`\${runId}-site-\${host.replace(/[^a-z0-9.-]/gi, "_")}\`;
}

function crawlRunContainsCompletedForeignSite(crawlRunId: string, website: string): boolean {
  const expected = registrableDomain(website);
  if (!expected) return false;
  return listNodes(crawlRunId).some(
    (node) =>
      node.state === "COMPLETED" &&
      (node.discoverySource === "seed" || node.discoverySource === "seed_guess") &&
      registrableDomain(node.canonicalUrl) !== expected
  );
}
`);

const constRunId = lines(
  "  const runId = opts.runId || process.env.SHADOW_RUN_ID || `analyze-${opts.leadId}`;"
);
const letRunId = lines(
  "  let runId = opts.runId || process.env.SHADOW_RUN_ID || `analyze-${opts.leadId}`;"
);
const createAnchor = lines(`  const { crawlRunId } = createCrawlRun({
    leadId: opts.leadId,
    runId,
    workerId: "scan-engine-slices",
  });
`);
const createInsertion = lines(`  let { crawlRunId } = createCrawlRun({
    leadId: opts.leadId,
    runId,
    workerId: "scan-engine-slices",
  });

  // Il sito ufficiale può essere corretto dopo una scheda Maps omonima errata.
  // Non mescolare mai pagine già completate sul vecchio dominio.
  if (crawlRunContainsCompletedForeignSite(crawlRunId, opts.website)) {
    runId = hostScopedRunId(runId, opts.website);
    ({ crawlRunId } = createCrawlRun({
      leadId: opts.leadId,
      runId,
      workerId: "scan-engine-slices",
    }));
  }
`);

for (const [label, anchor] of [
  ["resolveProductFrontierPath", helperAnchor],
  ["runId declaration", constRunId],
  ["createCrawlRun", createAnchor],
]) {
  if (!source.includes(anchor)) {
    throw new Error(`${label} anchor not found; refusing unsafe patch`);
  }
}

mkdirSync(dirname(backup), { recursive: true });
copyFileSync(target, backup);
source = source.replace(helperAnchor, helperInsertion);
source = source.replace(constRunId, letRunId);
source = source.replace(createAnchor, createInsertion);
writeFileSync(target, source, "utf8");

console.log(`HOST_SCOPED_FRONTIER_PATCHED ${backup}`);
