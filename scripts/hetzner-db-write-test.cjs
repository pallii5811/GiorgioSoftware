const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const one = await p.lead.findFirst();
    if (!one) {
      console.log('NO_LEADS');
      return;
    }
    const r = await p.lead.update({
      where: { id: one.id },
      data: { updatedAt: new Date() },
    });
    console.log('WRITE_OK', r.id);
  } catch (e) {
    console.error('WRITE_ERR', e.message);
    process.exitCode = 1;
  } finally {
    await p.$disconnect();
  }
})();
