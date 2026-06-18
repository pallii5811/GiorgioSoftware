const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const scanned = await p.lead.count({
    where: { region: 'Campania', lastScannedAt: { not: null } },
  });
  const total = await p.lead.count({ where: { region: 'Campania' } });
  console.log('SCANNED', scanned, 'TOTAL', total);
  await p.$disconnect();
})();
