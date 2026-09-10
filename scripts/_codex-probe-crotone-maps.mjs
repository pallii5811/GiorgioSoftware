import { scrapeMapsCategoryCity } from "@/lib/sanita/playwright-maps";
import { closeMapsBrowserPool } from "@/lib/sanita/playwright-maps";

const city = process.argv[2] || "Crotone";
const categories = [
  "casa di cura",
  "clinica privata",
  "poliambulatorio privato",
  "centro medico",
  "centro diagnostico",
  "laboratorio analisi cliniche",
  "centro riabilitazione",
];
const deadline = Date.now() + 150_000;
const results = [];

try {
  for (const category of categories) {
    const places = await scrapeMapsCategoryCity(category, city, 20, deadline, {
      freshPage: true,
    });
    results.push({
      category,
      count: places.length,
      sample: places.slice(0, 3).map((place) => ({
        name: place.name,
        city: place.city,
        website: place.website,
      })),
    });
  }
  console.log(JSON.stringify({ city, results }, null, 2));
} finally {
  await closeMapsBrowserPool().catch(() => {});
}
