process.env.MAPS_CITY_BUDGET_MS = "150000";
process.env.MAPS_QUERY_GAP_MS = "500";

const { prisma } = await import("@/lib/prisma");
const { discoverRegionFromMaps } = await import("@/lib/sanita/discover-region");

const before = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Calabria", city: "Crotone" },
  select: { id: true, companyName: true },
  orderBy: { companyName: "asc" },
});

const result = await discoverRegionFromMaps("Calabria", {
  deadline: Date.now() + 170_000,
  cityOffset: 0,
  maxCities: 1,
  cities: ["Crotone"],
  includeMinSalute: false,
  minSaluteMunicipality: "Crotone",
});

const after = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Calabria", city: "Crotone" },
  select: { id: true, companyName: true, website: true },
  orderBy: { companyName: "asc" },
});
const beforeIds = new Set(before.map((lead) => lead.id));

console.log(
  JSON.stringify(
    {
      result,
      before: before.length,
      after: after.length,
      added: after.filter((lead) => !beforeIds.has(lead.id)),
    },
    null,
    2
  )
);

await prisma.$disconnect();
