#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import {
  closeFrontierStore,
  listNodes,
  openFrontierStore,
  transitionFrontierNode,
} from "../src/lib/sanita/frontier-store.ts";
import {
  isCrawlScopeResource,
  isPolicyLikeResourceUrl,
} from "../src/lib/sanita/site-resource.ts";

const databasePath = process.argv[2];
const backupPath = process.argv[3];
if (!databasePath || !backupPath) {
  throw new Error("frontier sqlite path and backup path required");
}

const backupDb = new DatabaseSync(databasePath);
try {
  backupDb.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
} finally {
  backupDb.close();
}

const db = openFrontierStore(databasePath);
const report = [];
try {
  const runs = db
    .prepare("SELECT id, leadId FROM CrawlRun ORDER BY startedAt")
    .all();
  for (const run of runs) {
    const nodes = listNodes(String(run.id));
    const primary = nodes.find(
      (node) => node.resourceType === "html" && node.relevance === "critical"
    )?.canonicalUrl;
    if (!primary) continue;
    let excluded = 0;
    const examples = [];
    for (const node of nodes) {
      if (node.state === "EXCLUDED") continue;
      if (isCrawlScopeResource(node.canonicalUrl, primary, node.resourceType)) continue;
      if (isPolicyLikeResourceUrl(node.canonicalUrl)) continue;
      const linkedDocument =
        /^(?:pdf|office)$/i.test(node.resourceType) &&
        node.parentUrl &&
        isCrawlScopeResource(node.parentUrl, primary, "html") &&
        !/(?:inline|embedded|playwright-network)/i.test(
          String(node.discoverySource || "")
        );
      if (linkedDocument) continue;
      try {
        if (node.state === "COMPLETED") {
          transitionFrontierNode(node.id, "QUEUED", {
            lastError: "OUT_OF_SCOPE_HOST",
          });
        }
        transitionFrontierNode(node.id, "EXCLUDED", {
          lastError: "OUT_OF_SCOPE_HOST",
          exclusionReason: "OUT_OF_SCOPE_HOST",
        });
        excluded++;
        if (examples.length < 8) examples.push(node.canonicalUrl);
      } catch {
        /* active nodes are left to the resumed runner */
      }
    }
    report.push({
      crawlRunId: run.id,
      leadId: run.leadId,
      primary,
      excluded,
      examples,
    });
  }
} finally {
  closeFrontierStore();
}

console.log(JSON.stringify({ backupPath, report }, null, 2));
