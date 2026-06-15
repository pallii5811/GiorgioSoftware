/** Quanti siti Veneto il crawler ha marcato irraggiungibili — e rispondono ORA? */
import { prisma } from "../src/lib/prisma.ts";
import { externalFetch } from "../src/lib/http.ts";

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: "Veneto",
    websiteReachable: false,
    website: { not: null },
    lastScannedAt: { not: null },
  },
  select: { companyName: true, website: true, pagesVisited: true, evidence: true },
  take: 30,
});

let up = 0;
let down = 0;
const downSamples = [];
const upSamples = [];

for (const l of leads) {
  const raw = l.website.trim();
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let ok = false;
  let detail = "";
  try {
    const res = await externalFetch(url, { timeoutMs: 10_000 });
    ok = res.status >= 200 && res.status < 500;
    detail = String(res.status);
  } catch (e) {
    detail = e instanceof Error ? e.message.slice(0, 50) : "error";
  }
  if (ok) {
    up++;
    if (upSamples.length < 5) upSamples.push({ name: l.companyName, site: l.website, detail });
  } else {
    down++;
    if (downSamples.length < 5) downSamples.push({ name: l.companyName, site: l.website, detail });
  }
}

console.log(`Siti marcati irraggiungibili dallo SCRAPER: ${leads.length}`);
console.log(`Probe adesso: UP ${up} | DOWN ${down}`);
console.log("\nEsempi UP (crawler fallito ma sito vivo):");
for (const s of upSamples) console.log(`  ${s.detail} | ${s.name} | ${s.site}`);
console.log("\nEsempi DOWN (davvero offline):");
for (const s of downSamples) console.log(`  ${s.detail} | ${s.name} | ${s.site}`);

await prisma.$disconnect();
