/** Azzera i lead con sito directory/social (doctolib, google, ecc.) per rianalisi pulita. */
import { prisma } from "../src/lib/prisma.ts";
import { isBlockedWebsiteHost } from "../src/lib/sanita/website.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", website: { not: null } },
  select: { id: true, companyName: true, website: true, region: true },
});

let fixed = 0;
for (const l of leads) {
  let host = "";
  try {
    host = new URL(l.website).hostname;
  } catch {
    host = "";
  }
  if (!host || !isBlockedWebsiteHost(host)) continue;
  await prisma.lead.update({
    where: { id: l.id },
    data: {
      website: null,
      lastScannedAt: null,
      evidence: null,
      policyFound: false,
      policyCompany: null,
      policyExpiry: null,
      policyMassimale: null,
    },
  });
  console.log(`reset: [${l.region}] ${l.companyName} (${host})`);
  fixed++;
}
console.log(`\n${fixed} lead azzerati per rianalisi.`);
await prisma.$disconnect();
