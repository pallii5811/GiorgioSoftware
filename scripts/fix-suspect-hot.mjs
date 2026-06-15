/** Rianalizza lead HOT sospetti (sito irraggiungibile, URL bloccati, crawl superficiale). */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { isBlockedWebsiteHost } from "../src/lib/sanita/website.ts";
import { completeLeadAnalysis } from "../src/lib/sanita/scan-engine.ts";

process.env.OCR_ENABLED = "1";
process.env.POLICY_EXHAUSTIVE = "1";

const hot = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } },
});

const suspects = hot.filter((l) => {
  if (!l.website) return false;
  try {
    const host = new URL(l.website).hostname;
    if (isBlockedWebsiteHost(host)) return true;
  } catch {
    return true;
  }
  if (l.websiteReachable === false) return true;
  if ((l.pagesVisited ?? 0) < 3 && !l.evidence?.includes("Portali ASL")) return true;
  return false;
});

console.log(`Rianalisi ${suspects.length} HOT sospetti…\n`);
const counters = { analyzed: 0, withPolicy: 0, hot: 0, review: 0, regionalChecked: 0, regionalWithPolicy: 0 };

for (const lead of suspects) {
  let clearWebsite = false;
  try {
    clearWebsite = isBlockedWebsiteHost(new URL(lead.website).hostname);
  } catch {
    clearWebsite = true;
  }
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastScannedAt: null,
      evidence: null,
      ...(clearWebsite ? { website: null } : {}),
    },
  });
  const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
  if (!fresh) continue;
  console.log(`→ ${fresh.companyName}`);
  await completeLeadAnalysis(fresh, fresh.region, counters);
}

console.log(`\nFatto: hot=${counters.hot} pub=${counters.withPolicy} review=${counters.review}`);
await prisma.$disconnect();
