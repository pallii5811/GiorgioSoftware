const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.lead
  .findMany({
    where: { evidence: { contains: '[V:PUB]' } },
    select: { companyName: true, evidence: true },
    take: 10,
  })
  .then((rows) => {
    for (const l of rows) {
      const hasDocs = /\[DOCS:/i.test(l.evidence || '');
      console.log(hasDocs ? 'HAS_DOCS' : 'NO_DOCS', l.companyName);
      if (l.evidence) console.log(l.evidence.slice(0, 600));
      console.log('---');
    }
    return p.$disconnect();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
