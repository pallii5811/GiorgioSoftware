const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  for (const region of ["Campania", "Veneto"]) {
    const total = await p.lead.count({ where: { type: "HEALTHCARE", region } });
    const gmaps = await p.lead.count({
      where: { type: "HEALTHCARE", region, osmId: { startsWith: "gmaps/" } },
    });
    const withSite = await p.lead.count({
      where: { type: "HEALTHCARE", region, website: { not: null } },
    });
    const done = await p.lead.count({
      where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
    });
    console.log(
      `${region}: total=${total} gmaps=${gmaps} conSito=${withSite} analizzati=${done}`
    );
  }
  await p.$disconnect();
})();
