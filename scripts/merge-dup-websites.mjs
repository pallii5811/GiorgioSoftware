import { PrismaClient } from "@prisma/client";
import {
  absorbWebsiteDuplicates,
  websiteHostKey,
} from "../src/lib/sanita/lead-dedup.ts";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";

const leads = await p.lead.findMany({
  where: { type: "HEALTHCARE", region, website: { not: null } },
  select: { id: true, companyName: true, website: true },
});

const seen = new Set();
let merged = 0;
for (const lead of leads) {
  const host = websiteHostKey(lead.website);
  if (!host || seen.has(host)) continue;
  seen.add(host);
  const before = await p.lead.count({ where: { type: "HEALTHCARE", region } });
  await absorbWebsiteDuplicates(lead.id, lead.website, region);
  const after = await p.lead.count({ where: { type: "HEALTHCARE", region } });
  if (after < before) {
    merged += before - after;
    console.log("MERGED", host, lead.companyName);
  }
}
console.log("DONE merged", merged);
await p.$disconnect();
