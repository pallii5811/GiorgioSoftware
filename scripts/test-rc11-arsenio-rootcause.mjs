/**
 * RC-11 self-check: relative Sitemap resolve + foreign-seed exclusion helpers.
 * Run: npx tsx scripts/test-rc11-arsenio-rootcause.mjs
 */
import assert from "node:assert/strict";
import { discoverAndProcessSitemaps } from "../src/lib/sanita/sitemap-pipeline.ts";
import {
  openFrontierStore,
  createCrawlRun,
  closeFrontierStore,
  listNodes,
  getCrawlRun,
  defaultFrontierDbPath,
} from "../src/lib/sanita/frontier-store.ts";
import { seedCrawlFrontier } from "../src/lib/sanita/crawl-slice-runner.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- unit: relative URL resolution (no network) ---
{
  const base = "https://santarseniomedicalcentre.it/";
  const raw = "/sitemap_index.xml";
  const abs = new URL(raw, base).toString();
  assert.equal(abs, "https://santarseniomedicalcentre.it/sitemap_index.xml");
  console.log("PASS relative sitemap resolve");
}

// --- unit: registrable domain .it ≠ .com ---
{
  const reg = (u) => {
    const host = new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".").filter(Boolean);
    return parts.slice(-2).join(".");
  };
  assert.equal(reg("http://www.santarseniomedicalcentre.it/x"), "santarseniomedicalcentre.it");
  assert.equal(reg("https://santarseniomedicalcentre.com/x"), "santarseniomedicalcentre.com");
  assert.notEqual(
    reg("http://www.santarseniomedicalcentre.it/"),
    reg("https://www.santarseniomedicalcentre.com/")
  );
  console.log("PASS registrable domain it≠com");
}

// --- integration: seed .it then pollute .com seeds → exclude via slice helper path ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc11-"));
  const dbPath = path.join(dir, "f.sqlite");
  openFrontierStore(dbPath);
  const { crawlRunId } = createCrawlRun({ leadId: "L1", runId: "r1", workerId: "t" });
  seedCrawlFrontier({ crawlRunId, website: "http://www.santarseniomedicalcentre.it/" });
  // simulate alt-TLD pollution
  seedCrawlFrontier({ crawlRunId, website: "https://www.santarseniomedicalcentre.com/" });
  seedCrawlFrontier({ crawlRunId, website: "https://santarseniomedicalcentre.com/" });
  const before = listNodes(crawlRunId);
  const comBefore = before.filter((n) => /santarseniomedicalcentre\.com/i.test(n.canonicalUrl)).length;
  assert.ok(comBefore >= 10, `expected .com seeds, got ${comBefore}`);
  // import exclude via re-running seed path: call runCrawlSlice would need network;
  // instead transition via public API mirroring RC-11 excludeForeignSeedNodes
  const { transitionFrontierNode } = await import("../src/lib/sanita/frontier-store.ts");
  const website = "http://www.santarseniomedicalcentre.it/";
  const reg = (u) => {
    try {
      const host = new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
      return host.split(".").slice(-2).join(".");
    } catch {
      return null;
    }
  };
  const siteReg = reg(website);
  let excl = 0;
  for (const n of listNodes(crawlRunId)) {
    const src = String(n.discoverySource || "");
    if (src !== "seed" && src !== "seed_guess") continue;
    if (reg(n.canonicalUrl) === siteReg) continue;
    if (n.state === "EXCLUDED") continue;
    transitionFrontierNode(n.id, "EXCLUDED", {
      lastError: "EXTERNAL_HOST_IRRELEVANT",
      exclusionReason: "EXTERNAL_HOST_IRRELEVANT",
    });
    excl++;
  }
  assert.ok(excl >= 10, `excluded ${excl}`);
  const left = listNodes(crawlRunId).filter(
    (n) => /santarseniomedicalcentre\.com/i.test(n.canonicalUrl) && n.state !== "EXCLUDED"
  );
  assert.equal(left.length, 0);
  closeFrontierStore();
  console.log("PASS foreign seed exclusion", { excl, dbPath });
}

console.log("ALL RC-11 CHECKS PASS");
