import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const leads = await p.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: { region: true, evidence: true, policyFound: true, website: true },
});

const bucket = () => ({ total: 0, hot: 0, pub: 0, review: 0, noSite: 0 });
const all = bucket();
const byRegion = { Campania: bucket(), Veneto: bucket() };

for (const l of leads) {
  all.total++;
  const r = byRegion[l.region] ?? bucket();
  if (!byRegion[l.region]) byRegion[l.region] = r;
  r.total++;

  if (!l.website) {
    all.noSite++;
    r.noSite++;
    continue;
  }

  const ev = l.evidence ?? "";
  if (ev.startsWith("[V:PUB]") || l.policyFound === true) {
    all.pub++;
    r.pub++;
  } else if (ev.startsWith("[V:HOT]")) {
    all.hot++;
    r.hot++;
  } else if (ev.startsWith("[V:REV]")) {
    all.review++;
    r.review++;
  } else {
    all.review++;
    r.review++;
  }
}

const hotAll = await p.lead.count({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } },
});

console.log("\n=== POLIZZA RC NON PUBBLICATA (Legge Gelli) ===\n");
console.log("Verdict HOT (totale, incl. senza sito):", hotAll);
console.log("Con sito web — polizza NON pubblicata (HOT):", all.hot);
console.log("Con sito web — polizza pubblicata (PUB):", all.pub);
console.log("Da verificare / sito irraggiungibile (REVIEW):", all.review);
console.log("Senza sito web (non analizzabile online):", all.noSite);
console.log("\n→ Opportunità commerciali (HOT):", all.hot);
console.log("→ HOT + senza sito (contatto impossibile online):", all.hot + all.noSite, "(solo", all.hot, "con sito raggiungibile)\n");
console.log("Per regione:");
for (const [region, s] of Object.entries(byRegion)) {
  console.log(`  ${region}: HOT=${s.hot} PUB=${s.pub} REVIEW=${s.review} noSito=${s.noSite} (tot ${s.total})`);
}
console.log("");
await p.$disconnect();
