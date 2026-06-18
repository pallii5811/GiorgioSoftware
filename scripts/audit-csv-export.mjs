/**
 * Audit accurato export CSV: ri-crawl ogni sito e confronta verdetto CSV vs motore.
 * Uso: npx tsx scripts/audit-csv-export.mjs [path.csv]
 */
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { crawlSite } from "../src/lib/sanita/crawler.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite } from "../src/lib/sanita/verdict.ts";
import { isParkedOrForSalePage } from "../src/lib/sanita/website.ts";
import { companyNameOnSite, validateSiteIdentity } from "../src/lib/sanita/site-identity.ts";

const CSV_PATH = process.argv[2] || "lead-sanita-2026-06-17.csv";
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 2);
const REPORT = process.env.AUDIT_REPORT || "csv-audit-report.jsonl";
const SUMMARY = process.env.AUDIT_SUMMARY || "csv-audit-summary.json";

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = process.env.OCR_ENABLED ?? "1";
process.env.SCAN_FAST = "0";

function parseCsv(text) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ";") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  return rows;
}

function csvVerdictToToken(v) {
  const s = (v || "").toLowerCase();
  if (/polizza\s+pubblicata|conforme|pubblicata/i.test(s)) return "PUBLISHED";
  if (/irregolare|lead certificato|prioritario|hot|caldissimo/i.test(s)) return "HOT";
  if (/verificare|review|incerto/i.test(s)) return "REVIEW";
  return "?";
}

function classifyMismatch(stored, recomputed) {
  if (stored === recomputed) return "MATCH";
  if (stored === "HOT" && recomputed === "PUBLISHED") return "FALSE_HOT_MISSED_PUB";
  if (stored === "PUBLISHED" && recomputed === "HOT") return "FALSE_PUB";
  if (stored === "HOT" && recomputed === "REVIEW") return "HOT_OVERSTATED";
  if (stored === "REVIEW" && recomputed === "HOT") return "REVIEW_TO_HOT";
  if (stored === "REVIEW" && recomputed === "PUBLISHED") return "REVIEW_TO_PUB";
  if (stored === "PUBLISHED" && recomputed === "REVIEW") return "PUB_DOWNGRADE";
  return "OTHER_MISMATCH";
}

async function auditRow(row, headers) {
  const get = (k) => row[headers.indexOf(k)] ?? "";
  const name = get("Struttura");
  const city = get("Citta");
  const website = get("Sito")?.trim() || null;
  const stored = csvVerdictToToken(get("Verdetto"));
  const evidence = get("Evidenza");

  if (!website) {
    return {
      name,
      city,
      website: null,
      stored,
      recomputed: "REVIEW",
      status: "NO_WEBSITE",
      match: stored === "REVIEW",
      note: "Nessun sito nel CSV",
    };
  }

  const crawl = await crawlSite(website);

  if (!crawl.ok) {
    return {
      name,
      city,
      website,
      stored,
      recomputed: "REVIEW",
      status: "SITE_DOWN",
      match: stored !== "HOT" && stored !== "PUBLISHED",
      crawlError: crawl.error,
      note: stored === "HOT" ? "CSV HOT ma sito irraggiungibile/parcheggiato" : null,
    };
  }

  const parked = isParkedOrForSalePage(`${crawl.text} ${crawl.policyText}`, website);
  const identity = validateSiteIdentity(name, website, crawl, city);
  const analysis = analyzeCrawlPolicy(crawl);
  const prelim = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, prelim, {
    companyName: name,
    website,
    city,
    mapsVerified: /Google Maps/i.test(get("FontiControllate") || evidence),
  });
  const recomputed = rec.verdict;
  const status = classifyMismatch(stored, recomputed);

  return {
    name,
    city,
    website,
    stored,
    recomputed,
    status,
    match: status === "MATCH",
    policyFound: analysis.policyFound,
    policyCompany: analysis.company,
    policyNumber: analysis.policyNumber,
    massimale: analysis.massimale,
    pages: crawl.pagesVisited.length,
    pdfsRead: crawl.policyPdfsRead,
    pdfsQueued: crawl.policyPdfsQueued,
    foundRelevantPage: crawl.foundRelevantPage,
    policyExhaustive: crawl.policyExhaustive,
    identityOk: identity.ok,
    identityReason: identity.reason,
    parked,
    nameOnSite: companyNameOnSite(name, `${crawl.text} ${crawl.policyText}`),
    reconcileNote: rec.note,
    policyPdfUrl: crawl.policyPdfUrl,
  };
}

async function runBatch(items, worker) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(worker));
  }
}

async function main() {
  const { installOcrSafetyHandlers, terminateOcrWorker } = await import("../src/lib/sanita/ocr.ts");
  installOcrSafetyHandlers();

  const raw = readFileSync(CSV_PATH, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  const headers = table[0];
  const dataRows = table.slice(1);

  writeFileSync(REPORT, "");
  console.log(`\n═══ CSV AUDIT — ${dataRows.length} strutture da ${CSV_PATH} ═══\n`);

  const summary = {
    total: dataRows.length,
    withSite: 0,
    noSite: 0,
    match: 0,
    mismatch: 0,
    siteDown: 0,
    falseHotMissedPub: 0,
    falsePub: 0,
    hotOverstated: 0,
    reviewToPub: 0,
    reviewToHot: 0,
    parkedWhileHot: 0,
    identityFailWhileHot: 0,
    byStored: { HOT: 0, PUBLISHED: 0, REVIEW: 0, "?": 0 },
    byRecomputed: { HOT: 0, PUBLISHED: 0, REVIEW: 0 },
    suspects: [],
  };

  let done = 0;

  for (const row of dataRows) {
    const site = row[headers.indexOf("Sito")]?.trim();
    if (site) summary.withSite++;
    else summary.noSite++;
  }

  await runBatch(dataRows, async (row) => {
    const name = row[headers.indexOf("Struttura")] || "?";
    try {
      const r = await auditRow(row, headers);
      done++;
      summary.byStored[r.stored] = (summary.byStored[r.stored] || 0) + 1;
      summary.byRecomputed[r.recomputed] = (summary.byRecomputed[r.recomputed] || 0) + 1;

      if (r.status === "SITE_DOWN") summary.siteDown++;
      if (r.match) summary.match++;
      else {
        summary.mismatch++;
        if (r.status === "FALSE_HOT_MISSED_PUB") summary.falseHotMissedPub++;
        if (r.status === "FALSE_PUB") summary.falsePub++;
        if (r.status === "HOT_OVERSTATED") summary.hotOverstated++;
        if (r.status === "REVIEW_TO_PUB") summary.reviewToPub++;
        if (r.status === "REVIEW_TO_HOT") summary.reviewToHot++;
        if (r.stored === "HOT" && r.parked) summary.parkedWhileHot++;
        if (r.stored === "HOT" && r.identityOk === false) summary.identityFailWhileHot++;
        if (!r.match) {
          summary.suspects.push({
            name: r.name,
            website: r.website,
            stored: r.stored,
            recomputed: r.recomputed,
            status: r.status,
            note: r.reconcileNote || r.crawlError || r.note,
          });
          console.log(`  ✗ ${r.status} | ${r.name} | CSV=${r.stored} → audit=${r.recomputed}`);
        }
      }

      appendFileSync(REPORT, JSON.stringify(r) + "\n");
      if (done % 5 === 0) {
        console.log(`  … ${done}/${dataRows.length} (match ${summary.match}, mismatch ${summary.mismatch})`);
      }
    } catch (e) {
      done++;
      summary.mismatch++;
      const err = { name, status: "ERROR", error: String(e) };
      summary.suspects.push(err);
      appendFileSync(REPORT, JSON.stringify(err) + "\n");
      console.log(`  ⚠ ERROR | ${name}: ${String(e).slice(0, 80)}`);
    }
  });

  await terminateOcrWorker().catch(() => {});
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));

  console.log("\n═══ RISULTATO CSV AUDIT ═══");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${REPORT}`);
  console.log(`Summary: ${SUMMARY}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
