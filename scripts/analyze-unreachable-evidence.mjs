import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: "Veneto",
    lastScannedAt: { not: null },
    websiteReachable: false,
  },
  select: { evidence: true, website: true, pagesVisited: true },
});

const patterns = {
  irraggiungibile: 0,
  nessun_documento_tavily: 0,
  portali_consultati: 0,
  timeout: 0,
  no_website: 0,
};

for (const l of leads) {
  const ev = (l.evidence || "").toLowerCase();
  if (!l.website) patterns.no_website++;
  if (ev.includes("irraggiungibile") || ev.includes("non raggiungibile")) patterns.irraggiungibile++;
  if (ev.includes("nessun documento trovato")) patterns.nessun_documento_tavily++;
  if (ev.includes("portali") || ev.includes("asl")) patterns.portali_consultati++;
  if (ev.includes("timeout") || ev.includes("non completata")) patterns.timeout++;
}

console.log("Lead Veneto websiteReachable=false:", leads.length);
console.log("Pattern evidence:", patterns);

const v = { HOT: 0, PUB: 0, REV: 0 };
for (const l of leads) {
  const t = readVerdictToken(l.evidence);
  if (t === "HOT") v.HOT++;
  else if (t === "PUBLISHED") v.PUB++;
  else v.REV++;
}
console.log("Verdetti su irraggiungibili:", v);

await prisma.$disconnect();
