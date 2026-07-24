#!/usr/bin/env node
/**
 * Offline repair: reclassify spurious relevant/critical on targeted frontiers.
 * Uses same classifyUrlRelevance rules as the engine.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { classifyUrlRelevance } from "../src/lib/sanita/crawl-relevance.ts";

const dir = process.argv[2] || "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite"));
let total = 0;
for (const f of files) {
  const fp = path.join(dir, f);
  const db = new Database(fp);
  const rows = db
    .prepare(
      `SELECT id, canonicalUrl, relevance, discoverySource FROM CrawlFrontierNode
       WHERE relevance IN ('critical','relevant')`
    )
    .all();
  let n = 0;
  const upd = db.prepare(`UPDATE CrawlFrontierNode SET relevance = ?, updatedAt = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) {
      const src = String(row.discoverySource || "");
      if (src === "seed" || src === "seed_guess" || src === "extra") continue;
      const next = classifyUrlRelevance(row.canonicalUrl, {
        discoverySource: src || "html-link",
      });
      if (next === "low" && next !== row.relevance) {
        upd.run(next, new Date().toISOString(), row.id);
        n++;
      }
    }
  });
  tx();
  db.close();
  if (n) console.log(JSON.stringify({ file: f, demoted: n }));
  total += n;
}
console.log(JSON.stringify({ ok: true, totalDemoted: total, files: files.length }));
