/**
 * Freeze staging acceptance sample IDs from immutable backup (read-only).
 * Seed: staging-sanita-acceptance-20260719
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SEED = "staging-sanita-acceptance-20260719";
const BACKUP = "data/shadow/db/giorgio-live-backup-20260718.db";
const OUT = "docs/staging-acceptance/sample-sanita.json";

function pick(arr, n, salt) {
  const scored = arr.map((r, i) => ({
    r,
    k: crypto.createHash("sha256").update(`${SEED}:${salt}:${r.id}`).digest("hex"),
  }));
  scored.sort((a, b) => a.k.localeCompare(b.k));
  return scored.slice(0, n).map((x) => x.r);
}

const db = new DatabaseSync(BACKUP, { readOnly: true });

const pubs = db
  .prepare(
    `SELECT id, companyName, city, region, website, category, policyExpiry, policyNumber, policyCompany, evidence, pagesVisited
     FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '[V:PUB]%' AND website IS NOT NULL AND length(website) > 8`
  )
  .all();

const withPdf = pubs.filter((p) => /\.pdf|certificata da PDF|policyPdf/i.test(p.evidence || ""));
const htmlOnly = pubs.filter((p) => !/\.pdf/i.test(p.evidence || "") && /Trasparenza|HTML|polizza/i.test(p.evidence || ""));
const expired = pubs.filter((p) => p.policyExpiry && new Date(p.policyExpiry) < new Date());
const noDate = pubs.filter((p) => !p.policyExpiry);

const pubSample = [];
const takeUnique = (pool, label) => {
  for (const r of pick(pool, 8, label)) {
    if (pubSample.length >= 4) break;
    if (!pubSample.find((x) => x.id === r.id)) pubSample.push({ ...r, strata: label });
  }
};
takeUnique(withPdf, "PUB_PDF");
takeUnique(expired, "PUB_EXPIRED");
takeUnique(noDate, "PUB_DATE_UNKNOWN");
takeUnique(htmlOnly.length ? htmlOnly : pubs, "PUB_HTML");
while (pubSample.length < 4) {
  for (const r of pick(pubs, 4, "PUB_FILL")) {
    if (pubSample.length >= 4) break;
    if (!pubSample.find((x) => x.id === r.id)) pubSample.push({ ...r, strata: "PUB_FILL" });
  }
}

const hots = db
  .prepare(
    `SELECT id, companyName, city, region, website, category, evidence, pagesVisited
     FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '[V:HOT]%' AND website IS NOT NULL AND length(website) > 8 AND pagesVisited >= 8`
  )
  .all();

const hotSimple = hots.filter((h) => (h.pagesVisited || 0) < 20);
const hotDeep = hots.filter((h) => (h.pagesVisited || 0) >= 20);
const hotPdf = hots.filter((h) => /\.pdf|PDF/i.test(h.evidence || ""));
const hotJs = hots.filter((h) => /playwright|WAF|javascript|SPA|bot/i.test(h.evidence || "") || /next|react/i.test(h.website || ""));

const hotSample = [];
for (const [pool, label] of [
  [hotSimple, "HOT_SIMPLE"],
  [hotDeep, "HOT_SITEMAP_DEEP"],
  [hotJs.length ? hotJs : hotDeep, "HOT_JS"],
  [hotPdf.length ? hotPdf : hotDeep, "HOT_PDF"],
]) {
  for (const r of pick(pool, 3, label)) {
    if (hotSample.length >= 4) break;
    if (![...pubSample, ...hotSample].find((x) => x.id === r.id)) {
      hotSample.push({ ...r, strata: label });
    }
  }
}

const hard = db
  .prepare(
    `SELECT id, companyName, city, region, website, category, evidence, pagesVisited
     FROM Lead WHERE type='HEALTHCARE' AND website IS NOT NULL AND length(website) > 8
     AND (
       evidence LIKE '%WAF%' OR evidence LIKE '%timeout%' OR evidence LIKE '%OCR%'
       OR evidence LIKE '%gruppo%' OR evidence LIKE '%Playwright%' OR evidence LIKE '%RETRY%'
       OR companyName LIKE '%Gruppo%' OR website LIKE '%gruppo%'
     )
     LIMIT 80`
  )
  .all();

const hardSample = [];
const hardBuckets = [
  [/playwright|javascript|SPA|WAF|bot/i, "HARD_JS"],
  [/OCR|scanner|illeggibil/i, "HARD_OCR"],
  [/gruppo|GROUP/i, "HARD_GROUP"],
  [/timeout|403|429|RETRY|tecnico/i, "HARD_TECH"],
];
for (const [re, label] of hardBuckets) {
  const pool = hard.filter((h) => re.test(`${h.evidence} ${h.companyName} ${h.website}`));
  for (const r of pick(pool.length ? pool : hard, 2, label)) {
    if (hardSample.length >= 4) break;
    if (![...pubSample, ...hotSample, ...hardSample].find((x) => x.id === r.id)) {
      hardSample.push({ ...r, strata: label });
    }
  }
}

const sample = {
  seed: SEED,
  runId: "staging-sanita-acceptance-20260719",
  frozenAt: new Date().toISOString(),
  backup: BACKUP,
  published: pubSample.map(slim),
  hot: hotSample.map(slim),
  hard: hardSample.map(slim),
  allIds: [...pubSample, ...hotSample, ...hardSample].map((r) => r.id),
};

function slim(r) {
  return {
    id: r.id,
    companyName: r.companyName,
    city: r.city,
    region: r.region,
    website: r.website,
    category: r.category,
    strata: r.strata,
    historicalVerdict: String(r.evidence || "").startsWith("[V:PUB]")
      ? "PUBLISHED"
      : String(r.evidence || "").startsWith("[V:HOT]")
        ? "HOT"
        : "REVIEW",
    policyExpiry: r.policyExpiry || null,
    policyNumber: r.policyNumber || null,
    policyCompany: r.policyCompany || null,
    pagesVisited: r.pagesVisited ?? null,
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(sample, null, 2));
console.log(JSON.stringify({ ok: true, counts: { pub: pubSample.length, hot: hotSample.length, hard: hardSample.length, total: sample.allIds.length }, out: OUT }, null, 2));
if (sample.allIds.length !== 12) process.exit(2);
