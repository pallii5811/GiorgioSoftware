/** Breakdown motivi REVIEW — npx tsx scripts/review-breakdown.mjs Campania */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const region = process.argv[2] || "Campania";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:REV]" } },
  select: { companyName: true, website: true, websiteReachable: true, pagesVisited: true, evidence: true },
});

const buckets = {};
function bucket(l) {
  const ev = (l.evidence || "").toLowerCase();
  if (!l.website) return "senza_sito";
  if (ev.includes("timeout") || ev.includes("interrotta")) return "timeout";
  if (ev.includes("non esaustivo") || ev.includes("crawl insufficiente")) return "crawl_non_esaustivo";
  if (ev.includes("sito errato") || ev.includes("omonimia") || ev.includes("probabilmente errato"))
    return "sito_errato";
  if (l.websiteReachable === false || ev.includes("irraggiungibile") || ev.includes("waf") || ev.includes("blocca"))
    return "sito_bloccato";
  if (ev.includes("manutenzione")) return "manutenzione";
  if (ev.includes("ocr")) return "ocr";
  if (ev.includes("non individuato")) return "discovery_fallita";
  if (ev.includes("impossibile certificare")) return "non_certificabile";
  return "altro";
}

for (const l of leads) {
  const b = bucket(l);
  buckets[b] = (buckets[b] || 0) + 1;
}

console.log(`\n${region} REVIEW=${leads.length}\n`);
for (const [k, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} — ${k}`);
}

await prisma.$disconnect();
