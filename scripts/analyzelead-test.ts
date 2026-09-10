import { PrismaClient } from "@prisma/client";
import { analyzeLead } from "@/lib/sanita/scan-engine";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

(async () => {
const lead = await prisma.lead.findUnique({ where: { id: "cmqkld5rk009b108ekvol7g87" } });
if (!lead) { console.error("lead not found"); process.exit(1); }
console.log("before", { evidence: lead.evidence?.slice(0, 100), policyFound: lead.policyFound, processingState: lead.processingState });

const counters = {
  analyzed: 0, withPolicy: 0, published: 0, hot: 0, review: 0, reviewHuman: 0, retryPending: 0, technicalBlocked: 0, outOfScope: 0,
};

process.env.FORCE_RESCAN_PUB = "1";
process.env.FRONTIER_DB_PATH = "/opt/leadsniper-revalidate/data/revalidation/frontiers/rc08-analyze-test.sqlite";
process.env.SHADOW_RUN_ID = `analyze-${lead.id}-test`;
process.env.STAGING_MODE = "true";
process.env.DISABLE_LIVE_DB = "true";
process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";
process.env.SCAN_FAST = "0";

await analyzeLead({
  id: lead.id,
  osmId: lead.osmId,
  category: lead.category,
  companyName: lead.companyName,
  city: lead.city,
  region: lead.region,
  website: lead.website,
  phone: lead.phone,
  email: lead.email,
  pec: lead.pec,
  piva: lead.piva,
}, counters);

const after = await prisma.lead.findUnique({ where: { id: lead.id } });
console.log("after", { evidence: after?.evidence?.slice(0, 300), policyFound: after?.policyFound, processingState: after?.processingState, businessVerdict: after?.businessVerdict, counters });
await prisma.$disconnect();
})();
