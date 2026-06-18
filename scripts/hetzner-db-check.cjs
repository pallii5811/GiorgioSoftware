const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.lead
  .count()
  .then((n) => {
    console.log('LEADS:', n);
    return p.$disconnect();
  })
  .catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
