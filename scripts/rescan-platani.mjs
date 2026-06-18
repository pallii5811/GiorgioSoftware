import { prisma } from "../src/lib/sanita/db-ready.ts";
import { analyzeLead } from "../src/lib/sanita/scan-engine.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { terminateOcrWorker } from "../src/lib/sanita/ocr.ts";
import { closeMapsBrowserPool } from "../src/lib/sanita/playwright-maps.ts";

process.env.POLICY_EXHAUSTIVE = "1";
process.env.OCR_ENABLED = "1";

const lead = await prisma.lead.findFirst({
  where: { website: { contains: "malzoni" } },
});
if (!lead) {
  console.error("NOT_FOUND");
  process.exit(1);
}

await prisma.lead.update({
  where: { id: lead.id },
  data: {
    companyName: "Casa Di Cura Villa Dei Platani",
    website: "https://www.malzoni.it/",
    lastScannedAt: null,
  },
});

const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("BEFORE", fresh?.companyName, readVerdictToken(fresh?.evidence));

const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0 };
await analyzeLead({ ...fresh, region: "Campania" }, counters);

const after = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("AFTER", after?.companyName, readVerdictToken(after?.evidence), after?.policyCompany);

await terminateOcrWorker().catch(() => {});
await closeMapsBrowserPool().catch(() => {});
