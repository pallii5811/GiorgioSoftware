const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const region = process.argv[2] || "Campania";
  const leads = await p.lead.findMany({
    where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
    select: {
      companyName: true,
      city: true,
      website: true,
      policyFound: true,
      policyCompany: true,
      policyMassimale: true,
      policyNumber: true,
      policyExpiry: true,
      confidence: true,
      evidence: true,
      pagesVisited: true,
    },
    orderBy: { companyName: "asc" },
  });

  const tok = (ev) => {
    const m = (ev || "").match(/^\[V:(PUB|HOT|REV)\]/i);
    return m ? m[1] : "?";
  };

  const by = { PUB: [], HOT: [], REV: [], "?": [] };
  for (const l of leads) by[tok(l.evidence)].push(l);

  console.log(`\n${region}: ${leads.length} analizzati`);
  console.log(`PUBLISHED=${by.PUB.length} HOT=${by.HOT.length} REVIEW=${by.REV.length}`);

  console.log("\n=== PUBLISHED (dettaglio) ===");
  for (const l of by.PUB) {
    const docs = (l.evidence || "").match(/\[DOCS:\s*([^\]]+)\]/i);
    console.log(`\n• ${l.companyName} (${l.city || "?"})`);
    console.log(`  sito: ${l.website}`);
    console.log(`  compagnia: ${l.policyCompany} | massimale: ${l.policyMassimale} | n: ${l.policyNumber} | scad: ${l.policyExpiry}`);
    console.log(`  confidence: ${l.confidence} | pagine: ${l.pagesVisited}`);
    console.log(`  pdf: ${docs ? docs[1].trim() : "(nessuno in evidence)"}`);
  }

  console.log("\n=== REVIEW (motivi) ===");
  for (const l of by.REV) {
    const body = (l.evidence || "").replace(/^\[V:REV\]\s*/i, "");
    console.log(`• ${l.companyName}: ${body.slice(0, 160)}`);
  }

  // HOT senza sito / senza trasparenza
  const hotNoSite = by.HOT.filter((l) => !l.website);
  const hotWithPdf = by.HOT.filter((l) => /PDF polizza letti (\d+)\/(\d+)/i.test(l.evidence || ""));
  let pdfRead = 0;
  for (const l of hotWithPdf) {
    const m = (l.evidence || "").match(/PDF polizza letti (\d+)\/(\d+)/i);
    if (m && Number(m[1]) > 0) pdfRead++;
  }
  console.log(`\n=== HOT audit ===`);
  console.log(`HOT totali: ${by.HOT.length}`);
  console.log(`HOT senza sito: ${hotNoSite.length}`);
  console.log(`HOT con almeno 1 PDF policy letto: ${pdfRead}`);

  const vm = await p.lead.findMany({
    where: { type: "HEALTHCARE", region, companyName: { contains: "Villa Maria" } },
    select: { companyName: true, city: true, website: true, policyFound: true, evidence: true, lastScannedAt: true },
  });
  if (vm.length) {
    console.log("\n=== Villa Maria (tutte) ===");
    for (const l of vm) console.log(`• ${l.companyName} (${l.city}) ${l.website} | scanned=${!!l.lastScannedAt} pub=${l.policyFound} | ${(l.evidence||"").slice(0,100)}`);
  }

  await p.$disconnect();
})();
