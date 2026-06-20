import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const region = process.argv[2] || "Campania";

const leads = await p.lead.findMany({
  where: {
    type: "HEALTHCARE",
    region,
    website: { not: null },
    NOT: { website: "" },
    lastScannedAt: { not: null },
    evidence: { contains: "[V:REV]" },
  },
  select: {
    companyName: true,
    website: true,
    evidence: true,
    pagesVisited: true,
    websiteReachable: true,
  },
  orderBy: { lastScannedAt: "desc" },
});

const buckets = {};
for (const l of leads) {
  const body = (l.evidence ?? "").replace(/^\[V:REV\]\s*/, "");
  let key = "altro";
  if (/Timeout|oltre \d+ min|Blocco tecnico/i.test(body)) key = "timeout";
  else if (/website is not defined|Analisi interrotta/i.test(body)) key = "crash";
  else if (/Sito ufficiale non individuato|nessun sito|non individuato/i.test(body)) key = "no_site_found";
  else if (/identit|wrong site|sito errato|non corrisponde/i.test(body)) key = "identity";
  else if (/crawl incompleto|Trasparenza|sezione/i.test(body)) key = "crawl_transparency";
  else if (/OCR|PDF/i.test(body)) key = "pdf_ocr";
  else if (/portali regionali|Tavily/i.test(body)) key = "regional";
  if (!buckets[key]) buckets[key] = [];
  buckets[key].push(l);
}

const summary = Object.fromEntries(
  Object.entries(buckets).map(([k, v]) => [k, v.length])
);
console.log(JSON.stringify({ total: leads.length, summary }, null, 2));

for (const [k, arr] of Object.entries(buckets).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n=== ${k} (${arr.length}) ===`);
  for (const l of arr.slice(0, 5)) {
    console.log(`- ${l.companyName}`);
    console.log(`  web: ${l.website} | pages: ${l.pagesVisited} | reachable: ${l.websiteReachable}`);
    console.log(`  ${(l.evidence ?? "").slice(0, 120)}`);
  }
}

await p.$disconnect();
