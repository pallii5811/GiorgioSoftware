/**
 * Rianalizza REVIEW senza sito — Maps/guess migliorati (es. Pineta Grande / Villa Esther).
 */
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";

import { prisma } from "../src/lib/sanita/db-ready.ts";
import { completeLeadAnalysis, runBatch } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const region = process.argv[2] || "Campania";

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    evidence: { startsWith: "[V:REV]" },
    OR: [{ website: null }, { website: "" }],
  },
});

console.log(`${region}: ${leads.length} REVIEW senza sito`);

let i = 0;
await runBatch(leads, 1, async (lead) => {
  await prisma.lead.update({ where: { id: lead.id }, data: { lastScannedAt: null } });
  i++;
  const c = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };
  await completeLeadAnalysis(lead, region, c);
  const fresh = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: { evidence: true, website: true },
  });
  console.log(
    `[${i}/${leads.length}]`,
    lead.companyName?.slice(0, 40),
    "→",
    readVerdictToken(fresh?.evidence),
    fresh?.website?.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40) ?? "no-site"
  );
});

await Promise.race([
  Promise.all([
    terminateOcrWorker().catch(() => {}),
    closeMapsBrowserPool().catch(() => {}),
    prisma.$disconnect(),
  ]),
  new Promise((r) => setTimeout(r, 15_000)),
]);
process.exit(0);
