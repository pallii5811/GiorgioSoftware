import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Veneto", lastScannedAt: { not: null } },
  select: {
    companyName: true,
    city: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    evidence: true,
  },
});

const byV = { HOT: 0, PUB: 0, REV: 0 };
const buckets = {};

function bucket(l) {
  const ev = (l.evidence || "").toLowerCase();
  if (ev.includes("timeout") || ev.includes("non completata in tempo")) return "timeout";
  if (ev.includes("irraggiungibile") || l.websiteReachable === false) return "sito_giu";
  if (!l.website) return "senza_sito";
  if (ev.includes("omonimia") || ev.includes("sito errato") || ev.includes("nome struttura assente") || ev.includes("città attesa"))
    return "identita";
  if (ev.includes("pdf non processati") || ev.includes("crawl incompleto") || ev.includes("non esaustivo"))
    return "crawl_incompleto";
  if (ev.includes("ocr")) return "ocr";
  if (ev.includes("trasparenza") && ev.includes("non trovata")) return "no_trasparenza";
  if (ev.includes("impossibile certificare")) return "non_certificabile";
  if ((l.pagesVisited ?? 0) < 3) return "crawl_superficiale";
  if (ev.includes("portale") || ev.includes("tavily") || ev.includes("nessun sito")) return "solo_tavily";
  return "altro";
}

for (const l of leads) {
  const v = readVerdictToken(l.evidence);
  if (v === "HOT") byV.HOT++;
  else if (v === "PUBLISHED") byV.PUB++;
  else byV.REV++;
  const b = bucket(l);
  buckets[b] = (buckets[b] || 0) + 1;
}

console.log("Veneto analizzati:", leads.length);
console.log("HOT:", byV.HOT, "PUB:", byV.PUB, "REVIEW:", byV.REV);
console.log("\nMotivi REVIEW:\n");
for (const [k, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  if (k !== "altro" || buckets[k] > 5) console.log(`  ${String(n).padStart(3)} — ${k}`);
}

await prisma.$disconnect();
