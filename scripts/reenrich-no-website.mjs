import { PrismaClient } from "@prisma/client";
import { resolveOfficialWebsite } from "../src/lib/sanita/resolve-website.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";
import { normalizeWebsite } from "../src/lib/sanita/discovery.ts";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";

const leads = await p.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    OR: [{ website: null }, { website: "" }],
  },
  select: { id: true, companyName: true, city: true, region: true },
  orderBy: { companyName: "asc" },
});

console.log(`Lead senza sito: ${leads.length}`);
let found = 0;

for (const lead of leads) {
  const resolved = await resolveOfficialWebsite(lead.companyName, lead.city, region, {
    deadline: Date.now() + 120_000,
  });
  const website = resolved.website ? normalizeWebsite(resolved.website) : null;
  if (!website) {
    console.log(`- ${lead.companyName} (${lead.city})`);
    continue;
  }
  found++;
  await p.lead.update({
    where: { id: lead.id },
    data: {
      website,
      companyName: resolved.companyName || lead.companyName,
      ...(resolved.phone ? { phone: resolved.phone } : {}),
      ...(resolved.city ? { city: resolved.city } : {}),
      lastScannedAt: null,
      evidence: null,
      leadScore: 0,
      pagesVisited: 0,
    },
  });
  console.log(`+ ${lead.companyName} → ${website} (${resolved.source})`);
}

await closeMapsBrowserPool().catch(() => {});
console.log(JSON.stringify({ total: leads.length, found }, null, 2));
await p.$disconnect();
