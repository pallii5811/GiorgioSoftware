/**
 * Verifica se i siti segnati irraggiungibili nel DB rispondono ORA (rete ok).
 */
import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { externalFetch } from "../src/lib/http.ts";

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: "Veneto",
    lastScannedAt: { not: null },
    websiteReachable: false,
    website: { not: null },
  },
  select: { companyName: true, website: true, evidence: true },
  take: 30,
});

let up = 0;
let down = 0;
const samples = [];

for (const l of leads) {
  const url = l.website.startsWith("http") ? l.website : `https://${l.website}`;
  let ok = false;
  let status = "err";
  try {
    const res = await externalFetch(url, { timeoutMs: 12_000 });
    ok = res.status >= 200 && res.status < 500;
    status = String(res.status);
  } catch (e) {
    status = e instanceof Error ? e.message.slice(0, 60) : "fail";
  }
  if (ok) up++;
  else down++;
  if (samples.length < 8) {
    samples.push({
      name: l.companyName,
      site: l.website,
      now: ok ? "UP" : "DOWN",
      status,
      verdict: readVerdictToken(l.evidence),
    });
  }
}

const total = await prisma.lead.count({
  where: {
    type: "HEALTHCARE",
    region: "Veneto",
    websiteReachable: false,
    website: { not: null },
  },
});

console.log(`Veneto sito irraggiungibile in DB: ${total}`);
console.log(`Probe ora (campione ${leads.length}): UP ${up} | DOWN ${down}`);
console.log("\nEsempi:");
for (const s of samples) console.log(`  ${s.now} ${s.status} | ${s.name} | ${s.site}`);

await prisma.$disconnect();
