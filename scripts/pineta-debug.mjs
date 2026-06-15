import { PrismaClient } from "@prisma/client";
import { lookupBusinessOnMaps } from "../src/lib/sanita/playwright-maps.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

const prisma = new PrismaClient();
const pineta = await prisma.lead.findFirst({
  where: { companyName: { contains: "Pineta Grande" } },
});
console.log("DB:", pineta?.companyName, pineta?.city, pineta?.website);

const queries = [
  [pineta.companyName, pineta.city, "Campania"],
  ["Casa Di Cura Pineta Grande", "Castel Volturno", "Campania"],
  ["Pineta Grande Hospital", "Castel Volturno", "Campania"],
];

for (const [name, city, region] of queries) {
  console.log(`\n→ "${name}" (${city})`);
  const hit = await lookupBusinessOnMaps(name, city, region);
  console.log(hit ? { name: hit.name, website: hit.website, phone: hit.phone } : "null");
}

await closeMapsBrowserPool();
await prisma.$disconnect();
