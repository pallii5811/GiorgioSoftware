import { prisma } from "@/lib/prisma";

const [region, city] = process.argv.slice(2);
if (!region || !city) throw new Error("region and city required");
const rows = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    city,
    evidence: { contains: "[STATE:HOT_VERIFIED]" },
  },
  orderBy: { companyName: "asc" },
  select: { id: true, companyName: true, website: true, evidence: true },
});
console.log(JSON.stringify({ count: rows.length, rows: rows.map(({ evidence, ...row }) => ({
  ...row,
  crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence || ""),
  frontierExhausted: /\[FRONTIER:EXHAUSTED,p=0,f=0,pdf=0,ocr=0/i.test(evidence || ""),
})) }, null, 2));
await prisma.$disconnect();
