/**
 * Pulizia DB: downgrade HOT non certificati → REVIEW + coda rescan.
 * Uso: npx tsx scripts/fix-bad-hot-db.mjs [Campania]
 */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { encodeEvidence, readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { MIN_PAGES_FOR_HOT } from "../src/lib/sanita/can-emit-hot.ts";
import { classifyGelliScope } from "../src/lib/sanita/gelli-scope.ts";
import { hostBrandMatchesName } from "../src/lib/sanita/contacts.ts";

const region = process.argv[2] || "Campania";

const hot = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:HOT]" } },
  select: {
    id: true,
    companyName: true,
    category: true,
    osmId: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    evidence: true,
    policyCompany: true,
    policyExpiry: true,
  },
});

let downgraded = 0;
let deleted = 0;
let requeued = 0;

for (const l of hot) {
  const scope = classifyGelliScope(l.companyName, l.category, l.osmId);
  if (!scope.ok) {
    await prisma.lead.delete({ where: { id: l.id } });
    deleted++;
    console.log("DEL", l.companyName?.slice(0, 45), "→", scope.reason);
    continue;
  }

  const pages = l.pagesVisited ?? 0;
  const ev = l.evidence ?? "";
  const unreachable = l.websiteReachable === false;
  const shallow = pages < MIN_PAGES_FOR_HOT;
  const badScaduta =
    /scaduta da \d+ giorni/i.test(ev) && !l.policyCompany && !l.policyExpiry;
  const brandBad = l.website && !hostBrandMatchesName(l.companyName, l.website);

  if (!shallow && !unreachable && !badScaduta && !brandBad) continue;

  let motivo = "HOT non certificato — downgrade automatico.";
  if (unreachable) motivo = "Sito non raggiungibile — HOT non certificabile.";
  else if (shallow) motivo = `Crawl insufficiente (${pages}/${MIN_PAGES_FOR_HOT} pagine) — HOT non certificabile.`;
  else if (badScaduta) motivo = "Etichetta scaduta senza metadata polizza — verifica manuale.";
  else if (brandBad) motivo = "Sito probabilmente errato per il nome struttura — verifica manuale.";

  await prisma.lead.update({
    where: { id: l.id },
    data: {
      evidence: encodeEvidence("REVIEW", motivo),
      policyCompany: null,
      policyMassimale: null,
      policyNumber: null,
      policyExpiry: null,
      confidence: null,
      lastScannedAt: l.website ? null : new Date(),
    },
  });
  downgraded++;
  if (l.website) requeued++;
  console.log("↓", l.companyName?.slice(0, 42), "|", motivo.slice(0, 50));
}

console.log(JSON.stringify({ region, checked: hot.length, downgraded, deleted, requeued }));
await prisma.$disconnect();
