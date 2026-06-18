import { prisma } from "../src/lib/sanita/db-ready.ts";
import { dedupeRegionByCompanyName, dedupeRegionByWebsite } from "../src/lib/sanita/lead-dedup.ts";

const removedSite = await dedupeRegionByWebsite("Campania");
const removedName = await dedupeRegionByCompanyName("Campania");
console.log("deduped site", removedSite, "name", removedName);
