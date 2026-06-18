import { prisma } from "../src/lib/sanita/db-ready.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const names = ["Villa Maria", "Montevergine", "Pineta Grande", "Santa Rita", "S.Rita", "S Rita"];
for (const q of names) {
  const leads = await prisma.lead.findMany({
    where: { companyName: { contains: q } },
    select: {
      id: true,
      companyName: true,
      city: true,
      website: true,
      evidence: true,
      policyExpiry: true,
      lastScannedAt: true,
      pagesVisited: true,
    },
    take: 5,
  });
  for (const l of leads) {
    console.log("---");
    console.log(l.companyName, "|", l.city);
    console.log("site:", l.website, "| verdict:", readVerdictToken(l.evidence));
    console.log("pages:", l.pagesVisited, "| expiry:", l.policyExpiry?.toISOString?.()?.slice(0, 10));
    console.log((l.evidence || "").slice(0, 200));
  }
}
