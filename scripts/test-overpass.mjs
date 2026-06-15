// Test reachability + sample data from Overpass API (OpenStreetMap)
// Veneto = IT-34, Campania = IT-72
const query = `
[out:json][timeout:60];
area["ISO3166-2"="IT-34"]->.r;
(
  nwr["amenity"="nursing_home"](area.r);
  nwr["social_facility"="nursing_home"](area.r);
  nwr["healthcare"="clinic"](area.r);
);
out center tags 15;
`;

async function main() {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  for (const url of endpoints) {
    try {
      console.log("Trying:", url);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      console.log("Status:", res.status);
      const json = await res.json();
      const elements = json.elements || [];
      console.log("Total elements:", elements.length);
      const withSite = elements.filter((e) => e.tags && e.tags.website);
      console.log("With website:", withSite.length);
      console.log("--- SAMPLE (first 10) ---");
      elements.slice(0, 10).forEach((e) => {
        const t = e.tags || {};
        console.log(
          JSON.stringify({
            name: t.name || "(no name)",
            website: t.website || t["contact:website"] || null,
            city: t["addr:city"] || null,
            phone: t.phone || t["contact:phone"] || null,
          })
        );
      });
      return;
    } catch (err) {
      console.error("FAILED:", url, err.message);
    }
  }
  console.error("All endpoints failed.");
}

main();
