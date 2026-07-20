/**
 * Audit/quarantena lead Sanità legacy (pre evidence v2).
 * Default: dry-run (nessuna scrittura DB).
 * Uso:
 *   npx tsx scripts/sanita-legacy-audit.mjs
 *   npx tsx scripts/sanita-legacy-quarantine.mjs --dry-run
 *   npx tsx scripts/sanita-legacy-quarantine.mjs --apply   # SOLO locale/shadow, mai produzione in questa fase
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import {
  isLegacyLead,
  parseVersionMarkers,
  CURRENT_EVIDENCE_VERSION,
  CURRENT_VERDICT_VERSION,
} from "../src/lib/sanita/evidence-version.ts";

const apply = process.argv.includes("--apply");
const dryRun = !apply;

const regions = ["Campania", "Veneto"];
const report = {
  generatedAt: new Date().toISOString(),
  dryRun,
  currentEvidenceVersion: CURRENT_EVIDENCE_VERSION,
  currentVerdictVersion: CURRENT_VERDICT_VERSION,
  byRegion: {},
};

for (const region of regions) {
  const leads = await prisma.lead.findMany({
    where: { type: "HEALTHCARE", region },
    select: {
      id: true,
      companyName: true,
      evidence: true,
      website: true,
      pagesVisited: true,
      lastScannedAt: true,
    },
  });

  const stats = {
    total: leads.length,
    HOT: 0,
    PUBLISHED: 0,
    REVIEW: 0,
    unscanned: 0,
    legacy: 0,
    legacyHot: 0,
    legacyPublished: 0,
    missingIdentityMarker: 0,
    missingCompletenessHint: 0,
    missingEvidenceVersion: 0,
    rescanRequired: [],
  };

  for (const l of leads) {
    const v = readVerdictToken(l.evidence);
    if (!l.lastScannedAt) stats.unscanned++;
    if (v === "HOT") stats.HOT++;
    else if (v === "PUBLISHED") stats.PUBLISHED++;
    else if (v === "REVIEW") stats.REVIEW++;

    const markers = parseVersionMarkers(l.evidence);
    if (!markers) stats.missingEvidenceVersion++;
    if (isLegacyLead(l.evidence)) {
      stats.legacy++;
      if (v === "HOT") {
        stats.legacyHot++;
        stats.rescanRequired.push({ id: l.id, companyName: l.companyName, verdict: v });
      }
      if (v === "PUBLISHED") {
        stats.legacyPublished++;
        stats.rescanRequired.push({ id: l.id, companyName: l.companyName, verdict: v });
      }
    }
    if (!/IdentityEvidence|OFFICIAL_CONFIRMED|identityVerified/i.test(l.evidence || "")) {
      stats.missingIdentityMarker++;
    }
    if (!/CRAWL_COMPLETE|completeness|Crawl incompleto|esaustiv/i.test(l.evidence || "")) {
      stats.missingCompletenessHint++;
    }
  }

  report.byRegion[region] = {
    ...stats,
    rescanRequiredCount: stats.rescanRequired.length,
    rescanRequiredSample: stats.rescanRequired.slice(0, 20),
  };
  // Non serializzare tutti gli ID nel report principale
  delete report.byRegion[region].rescanRequired;
}

mkdirSync("data/coverage/sanita", { recursive: true });
const outPath = `data/coverage/sanita/legacy-audit-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);
if (dryRun) console.log("DRY-RUN: nessuna modifica al database.");
else console.log("APPLY non implementato in questa fase (DB live vietato). Usa solo shadow locale.");

await prisma.$disconnect();
