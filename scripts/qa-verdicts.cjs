const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function token(ev) {
  if (!ev) return "?";
  const m = ev.match(/^\[V:(PUB|HOT|REV)\]/i);
  return m ? m[1].toUpperCase() : "?";
}

(async () => {
  for (const region of ["Campania", "Veneto"]) {
    const leads = await p.lead.findMany({
      where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
      select: { companyName: true, website: true, evidence: true },
    });
    const counts = { PUB: 0, HOT: 0, REV: 0, "?": 0 };
    for (const l of leads) counts[token(l.evidence)]++;
    console.log(`\n=== ${region}: ${leads.length} analizzati ===`);
    console.log(`  PUBLISHED=${counts.PUB} HOT=${counts.HOT} REVIEW=${counts.REV} altro=${counts["?"]}`);

    const hot = leads.filter((l) => token(l.evidence) === "HOT").slice(0, 4);
    console.log(`  --- Campione HOT (devono avere: Trasparenza visitata + PDF analizzati) ---`);
    for (const l of hot) {
      console.log(`   • ${l.companyName} | ${l.website || "(no sito)"}`);
      console.log(`     ${(l.evidence || "").slice(0, 220)}`);
    }
    const pub = leads.filter((l) => token(l.evidence) === "PUB").slice(0, 3);
    console.log(`  --- Campione PUBLISHED (devono avere PDF polizza [DOCS]) ---`);
    for (const l of pub) {
      console.log(`   • ${l.companyName} | ${l.website || ""}`);
      console.log(`     ${(l.evidence || "").slice(0, 220)}`);
    }
  }
  await p.$disconnect();
})();
