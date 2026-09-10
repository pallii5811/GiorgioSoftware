const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ datasources: { db: { url: "file:/opt/leadsniper/prisma/dev.db" } } });
const ids = [
  "cmrukbcco0002126387vm7gse",
  "cmqktyimz000i111hygme29nh",
  "cmqklex5q00bh108eq9blm01k",
];
(async () => {
  for (const id of ids) {
    const l = await p.lead.findUnique({ where: { id } });
    console.log(
      JSON.stringify({
        id,
        name: l?.companyName,
        status: l?.status,
        notes: (l?.notes || "").slice(0, 50),
        lastScannedAt: l?.lastScannedAt,
        ev: (l?.evidence || "").slice(0, 150),
      })
    );
  }
  await p.$disconnect();
})();
