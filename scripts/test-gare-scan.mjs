import { runGareScan } from "../src/lib/gare/engine.ts";
import { prisma } from "../src/lib/prisma.ts";

const r = await runGareScan({ region: "Campania", max: 12, commercialOnly: true });
console.log(r.message);
console.log("stats", r.stats);
const n = await prisma.lead.count({ where: { type: "TENDER", region: "Campania" } });
console.log("DB gare Campania:", n);
await prisma.$disconnect();
