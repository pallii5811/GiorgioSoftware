import { fetchAccreditedClinics } from "../src/lib/sanita/salute.ts";
import { getRegionCities } from "../src/lib/sanita/region-cities.ts";
import { prisma } from "../src/lib/prisma.ts";

for (const region of ["Campania", "Veneto"]) {
  const clinics = await fetchAccreditedClinics(region);
  const cities = await getRegionCities(region);
  const db = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
  const maps = await prisma.lead.count({ where: { type: "HEALTHCARE", region, osmId: { startsWith: "gmaps/" } } });
  const salute = await prisma.lead.count({ where: { type: "HEALTHCARE", region, osmId: { startsWith: "min-salute/" } } });
  console.log(region, { minSaluteCsv: clinics.length, cities: cities.length, dbTotal: db, dbMaps: maps, dbMinSalute: salute });
}

await prisma.$disconnect();
