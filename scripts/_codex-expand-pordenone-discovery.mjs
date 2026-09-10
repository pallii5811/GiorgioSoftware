process.env.NATIONAL_DISCOVERY_JOB_ID ||= "pordenone-urgent-expansion";
process.env.MAPS_CITY_BUDGET_MS ||= "420000";
process.env.MAPS_QUERY_GAP_MS ||= "400";

const { prisma } = await import("@/lib/prisma");
const { discoverRegionFromMaps } = await import("@/lib/sanita/discover-region");
const { closeMapsBrowserPool } = await import("@/lib/sanita/playwright-maps");

const where = {
  type: "HEALTHCARE",
  region: "Friuli-Venezia Giulia",
  city: "Pordenone",
};

const before = await prisma.lead.findMany({
  where,
  select: { id: true, companyName: true, website: true },
  orderBy: { companyName: "asc" },
});

try {
  const result = await discoverRegionFromMaps("Friuli-Venezia Giulia", {
    deadline: Date.now() + 430_000,
    cityOffset: 0,
    maxCities: 1,
    cities: ["Pordenone"],
    includeMinSalute: true,
    minSaluteMunicipality: "Pordenone",
  });

  const after = await prisma.lead.findMany({
    where,
    select: { id: true, companyName: true, website: true, category: true },
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
} finally {
  await closeMapsBrowserPool().catch(() => {});
  await prisma.$disconnect();
}
