/**
 * Ri-applica criteri rigorosi a tutti gli HOT con sito (identità + profondità crawl).
 * Crawl in subprocess isolato — crash OCR/Tesseract non ferma il batch.
 * npm run reaudit:hot
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, ensureSqliteWal } from "../src/lib/sanita/db-ready.ts";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite, readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { packEvidence } from "../src/lib/sanita/audit.ts";
import { scoreLead } from "../src/lib/sanita/score.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(__dirname, "_crawl-worker.mjs");
const CRAWL_TIMEOUT_MS = 300_000;

process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";

/** Un crawl per processo figlio — il parent sopravvive a crash nativi OCR. */
function crawlIsolated(website) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", WORKER, website], {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        OCR_ENABLED: "1",
        POLICY_EXHAUSTIVE: "1",
        SCAN_FAST: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    const timer = setTimeout(() => child.kill("SIGTERM"), CRAWL_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const jsonStart = stdout.lastIndexOf("{");
      if (jsonStart >= 0) {
        try {
          resolve(JSON.parse(stdout.slice(jsonStart)));
          return;
        } catch {
          /* fall through */
        }
      }
      resolve({
        ok: false,
        error: stderr.trim().slice(0, 200) || `worker exit code ${code}`,
        crash: true,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, crash: true });
    });
  });
}

await ensureSqliteWal();

const hot = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    website: { not: null },
    lastScannedAt: { not: null },
  },
  orderBy: { companyName: "asc" },
});

console.log(`\n🔒 RE-AUDIT RIGOROSO — ${hot.length} HOT con sito (subprocess isolato)\n`);

let confirmed = 0;
let downgraded = 0;
let upgraded = 0;
let errors = 0;

for (let i = 0; i < hot.length; i++) {
  const lead = hot[i];
  const oldV = readVerdictToken(lead.evidence);

  const crawl = await crawlIsolated(lead.website);

  if (crawl.crash) {
    errors++;
    console.warn(`  ⚠ ${lead.companyName?.slice(0, 40)}: worker crash — ${crawl.error?.slice(0, 60)}`);
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        evidence: packEvidence("REVIEW", `Re-audit: crash OCR/crawl — ${crawl.error}`, { osm: true }),
        leadScore: scoreLead({ verdict: "REVIEW", phone: lead.phone, email: lead.email, pec: lead.pec }),
        lastScannedAt: new Date(),
      },
    });
    downgraded++;
    continue;
  }

  if (!crawl.ok) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        websiteReachable: false,
        evidence: packEvidence("REVIEW", `Re-audit: sito irraggiungibile — ${crawl.error}`, { osm: true }),
        leadScore: scoreLead({ verdict: "REVIEW", phone: lead.phone, email: lead.email, pec: lead.pec }),
        lastScannedAt: new Date(),
      },
    });
    downgraded++;
    continue;
  }

  const analysis = analyzeCrawlPolicy(crawl);
  let verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const rec = reconcilePolicyVerdict(crawl, analysis, verdict, {
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
  });
  verdict = rec.verdict;

  if (verdict === "HOT") confirmed++;
  else if (verdict === "PUBLISHED") upgraded++;
  else downgraded++;

  if (verdict !== oldV || rec.note) {
    const body =
      (rec.note ? `${rec.note} ` : "") +
      (analysis.evidence ||
        (verdict === "HOT"
          ? "Polizza non pubblicata — sito e Trasparenza verificati (re-audit rigoroso)."
          : verdict === "PUBLISHED"
            ? "Polizza trovata in re-audit."
            : "Re-audit: controllo non conclusivo."));
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        websiteReachable: true,
        policyFound: analysis.policyFound,
        policyCompany: analysis.company,
        policyMassimale: analysis.massimale,
        policyNumber: analysis.policyNumber,
        policyExpiry: analysis.expiry,
        confidence: analysis.confidence,
        pagesVisited: crawl.pagesVisited.length,
        leadScore: scoreLead({
          verdict,
          phone: lead.phone,
          email: lead.email,
          pec: lead.pec,
          expiry: analysis.expiry,
        }),
        evidence: packEvidence(verdict, body, {
          osm: true,
          sitePages: crawl.pagesVisited,
          siteRelevant: crawl.foundRelevantPage,
        }),
        lastScannedAt: new Date(),
      },
    });
    if (verdict !== oldV) {
      console.log(`  ✎ ${lead.companyName?.slice(0, 40)}: ${oldV} → ${verdict}`);
    }
  }

  if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${hot.length}`);
}

console.log(
  `\n✅ HOT confermati: ${confirmed} | declassati: ${downgraded} | PUBLISHED: ${upgraded} | errori crawl: ${errors}\n`
);
await prisma.$disconnect();
