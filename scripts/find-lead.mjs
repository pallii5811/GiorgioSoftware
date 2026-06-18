import { prisma } from "../src/lib/sanita/db-ready.ts";

const q = process.argv[2] || "";
const leads = await prisma.lead.findMany({
  where: q.includes(".")
    ? { website: { contains: q } }
    : { companyName: { contains: q } },
  select: { id: true, companyName: true, website: true, evidence: true },
  take: 10,
});
for (const l of leads) {
  const verdict = (l.evidence || "").match(/VERDETTO:\s*(\S+)/)?.[1] || "?";
  console.log(verdict, l.companyName, l.website);
}
