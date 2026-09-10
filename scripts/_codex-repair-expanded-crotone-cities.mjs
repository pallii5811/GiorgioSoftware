process.env.MAPS_POOL_SIZE = "1";

const { prisma } = await import("@/lib/prisma");
const { resolveWebsiteViaMaps } = await import("@/lib/sanita/maps-discovery");
const { addressMatchesSearchCity, closeMapsBrowserPool } = await import(
  "@/lib/sanita/playwright-maps"
);
const { getStoredRegionCities } = await import("@/lib/sanita/region-cities");

const expandedNames = [
  "IGEA Centro Medico Diagnostico Polispecialistico",
  "Casa Di Cura Privata S. Rita Srl",
  "Dr. Fiore ecografia clinica - Fibroscan",
  "Lab. Analisi Cliniche Via Srl",
  "Laboratorio Analisi Volante S.r.l",
  "Ospedale San Giovanni di Dio",
  "Poliambulatorio Erbagil",
];
const municipalities = getStoredRegionCities("Calabria");
const rows = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    companyName: { in: expandedNames },
  },
  select: { id: true, companyName: true, city: true, website: true },
});

const result = [];
try {
  for (const lead of rows) {
    const place = await resolveWebsiteViaMaps(lead.companyName, lead.city, "Calabria", {
      deadline: Date.now() + 40_000,
    });
    const matches = place?.address
      ? municipalities.filter((city) => addressMatchesSearchCity(place.address, city))
      : [];
    const verifiedCity = matches.length === 1 ? matches[0] : null;
    if (verifiedCity !== lead.city) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { city: verifiedCity },
      });
    }
    result.push({
      id: lead.id,
      companyName: lead.companyName,
      previousCity: lead.city,
      verifiedCity,
      address: place?.address ?? null,
    });
  }
} finally {
  await closeMapsBrowserPool().catch(() => {});
  await prisma.$disconnect();
}

console.log(JSON.stringify(result, null, 2));
