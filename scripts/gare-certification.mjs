/**
 * Gate qualità gare — dati ANAC + contatti arricchiti.
 * npm run certify:gare
 */
import { prisma } from "../src/lib/prisma.ts";
import { fetchAnacAwards } from "../src/lib/gare/anac.ts";
import { isGareCommerciallyRelevant } from "../src/lib/gare/relevance.ts";

const regions = ["Campania", "Veneto"];
const failures = [];

for (const region of regions) {
  const { awards, year, years } = await fetchAnacAwards(region, { max: 20 });
  if (!year || awards.length === 0) {
    failures.push({ name: region, rule: "ANAC_VUOTO", detail: "nessuna aggiudicazione ANAC" });
    continue;
  }
  let valid = 0;
  for (const a of awards.slice(0, 10)) {
    const cigOk = /^[A-Z0-9]{10}$/.test(a.cig);
    const nameOk = a.companyName.length >= 3;
    const amountOk = a.amount > 0;
    if (cigOk && nameOk && amountOk) valid++;
    else
      failures.push({
        name: a.companyName,
        rule: "ANAC_RECORD_INVALIDO",
        detail: `CIG=${a.cig} amount=${a.amount}`,
      });
  }
  if (valid < Math.min(5, awards.length)) {
    failures.push({ name: region, rule: "ANAC_SAMPLE_DEBOLE", detail: `solo ${valid}/10 validi` });
  }
}

const tenders = await prisma.lead.findMany({
  where: { type: "TENDER", region: { in: regions } },
  select: {
    id: true,
    companyName: true,
    region: true,
    tenderCig: true,
    tenderAmount: true,
    tenderObject: true,
    phone: true,
    email: true,
    pec: true,
    website: true,
    lastScannedAt: true,
  },
});

for (const t of tenders) {
  const name = `${t.companyName} (${t.region})`;
  if (!t.tenderCig || !/^[A-Z0-9]{10}$/.test(t.tenderCig))
    failures.push({ name, rule: "CIG_INVALIDO", detail: String(t.tenderCig) });
  if (!(t.tenderAmount > 0)) failures.push({ name, rule: "IMPORTO_ZERO", detail: String(t.tenderAmount) });
  if (!t.tenderObject || t.tenderObject.length < 10)
    failures.push({ name, rule: "OGGETTO_MANCANTE", detail: "tenderObject vuoto" });

  const relevant = isGareCommerciallyRelevant(t.tenderObject ?? "", t.companyName, t.tenderAmount ?? 0);
  if (!relevant)
    failures.push({ name, rule: "GARA_NON_RILEVANTE", detail: (t.tenderObject ?? "").slice(0, 80) });

  if (t.lastScannedAt && !t.phone && !t.email && !t.pec && !t.website)
    failures.push({ name, rule: "CONTATTI_ASSENTI", detail: "arricchimento senza contatti" });
}

console.log("\n═══ CERTIFICAZIONE GARE ═══");
console.log(`Gare in DB: ${tenders.length} | Fallimenti: ${failures.length}\n`);

if (failures.length) {
  for (const f of failures.slice(0, 30)) console.log(`  ✗ [${f.rule}] ${f.name} — ${f.detail}`);
  if (failures.length > 30) console.log(`  … +${failures.length - 30} altri`);
  console.log("\n❌ GARE NON CERTIFICATE\n");
  process.exit(1);
}

console.log("✅ GARE CERTIFICATE — ANAC + DB OK\n");
await prisma.$disconnect();
