import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const camp = await p.lead.findMany({
  where: { type: "HEALTHCARE", region: "Campania" },
  select: {
    id: true,
    companyName: true,
    website: true,
    city: true,
    osmId: true,
    phone: true,
    evidence: true,
    lastScannedAt: true,
  },
  orderBy: { companyName: "asc" },
});

const withSite = camp.filter((l) => l.website?.trim());
const noSite = camp.filter((l) => !l.website?.trim());

function source(osmId) {
  if (!osmId) return "unknown";
  if (osmId.startsWith("min-salute/")) return "min-salute";
  if (osmId.startsWith("gmaps/")) return "gmaps";
  if (osmId.includes("/")) return "osm";
  return "other";
}

const bySrc = {};
for (const l of camp) {
  const s = source(l.osmId);
  bySrc[s] ??= { total: 0, withSite: 0 };
  bySrc[s].total++;
  if (l.website?.trim()) bySrc[s].withSite++;
}

console.log(`Campania: ${camp.length} total | ${withSite.length} con sito | ${noSite.length} senza sito\n`);
console.log("=== PER FONTE ===");
for (const [s, v] of Object.entries(bySrc).sort()) {
  console.log(`  ${s}: ${v.withSite}/${v.total} con sito (${v.total - v.withSite} senza)`);
}
console.log();

console.log("=== CON SITO ===");
for (const l of withSite) console.log(`  + ${l.companyName} | ${l.website}`);

console.log("\n=== SENZA SITO (tutte) ===");
for (const l of noSite) {
  const ev = l.evidence?.slice(0, 80) ?? "";
  console.log(`  - ${l.companyName} | ${l.city ?? "?"} | ${l.osmId?.slice(0, 30) ?? ""} | scanned=${!!l.lastScannedAt}`);
}

await p.$disconnect();
