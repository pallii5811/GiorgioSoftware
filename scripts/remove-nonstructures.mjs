/** Rimuove dal DB lead che non sono strutture sanitarie (portali, directory). */
import { prisma } from "../src/lib/prisma.ts";

const patterns = ["ABCsalute"];
let removed = 0;
for (const p of patterns) {
  const r = await prisma.lead.deleteMany({
    where: { type: "HEALTHCARE", companyName: { contains: p } },
  });
  removed += r.count;
}
console.log(`rimossi: ${removed}`);
await prisma.$disconnect();
