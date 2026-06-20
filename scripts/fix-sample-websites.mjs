import { PrismaClient } from "@prisma/client";
import { resolveOfficialWebsite } from "../src/lib/sanita/resolve-website.ts";
import { pickOfficialWebsite } from "../src/lib/sanita/contacts.ts";
import { normalizeWebsite } from "../src/lib/sanita/discovery.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const p = new PrismaClient();
const needles = ["Antimo", "Meluccio", "Leonardo Bianchi", "San Felice"];

for (const needle of needles) {
  const leads = await p.lead.findMany({
    where: { region: "Campania", companyName: { contains: needle } },
    select: { id: true, companyName: true, city: true, website: true },
  });
  for (const lead of leads) {
    const r = await resolveOfficialWebsite(lead.companyName, lead.city, "Campania", {
      deadline: Date.now() + 90_000,
    });
    const norm = r.website ? normalizeWebsite(r.website) : null;
    const website = norm
      ? pickOfficialWebsite([norm], lead.companyName) ?? norm
      : null;
    console.log(
      JSON.stringify({
        name: lead.companyName,
        was: lead.website,
        found: website,
        source: r.source,
      })
    );
    if (website && website !== lead.website) {
      await p.lead.update({
        where: { id: lead.id },
        data: { website, lastScannedAt: null, evidence: null },
      });
      console.log("  → UPDATED DB");
    }
  }
}

await closeMapsBrowserPool().catch(() => {});
await p.$disconnect();
