/**
 * GATE CONSEGNA CLIENTE — nessun lead analizzato passa senza questi controlli.
 * Exit 0 = certificabile. Exit 1 = bloccare demo/consegna.
 *
 * npm run certify:delivery
 */
import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { isGelliSubjectStructure } from "../src/lib/sanita/gelli-scope.ts";

const regions = ["Campania", "Veneto"];
const failures = [];

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: { in: regions }, lastScannedAt: { not: null } },
  select: {
    id: true,
    companyName: true,
    region: true,
    category: true,
    osmId: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    policyFound: true,
    policyCompany: true,
    policyMassimale: true,
    policyNumber: true,
    policyExpiry: true,
    confidence: true,
    evidence: true,
  },
});

for (const l of leads) {
  const v = readVerdictToken(l.evidence);
  const name = `${l.companyName} (${l.region})`;

  if (!isGelliSubjectStructure(l.companyName, l.category, l.osmId)) {
    failures.push({
      name,
      rule: "FUORI_SCOPE_GELLI",
      detail: "non è struttura privata soggetta art. 10 (polizza obbligatoria)",
    });
  }

  if (!v) failures.push({ name, rule: "VERDETTO_MANCANTE", detail: "evidence senza token [V:...]" });

  if (v === "HOT") {
    if (l.policyFound) failures.push({ name, rule: "HOT_CON_POLIZZA", detail: "policyFound=true su HOT" });
    if (l.policyCompany)
      failures.push({ name, rule: "HOT_COMPAGNIA_SPURIA", detail: `policyCompany=${l.policyCompany}` });
    if (l.website && l.websiteReachable === false)
      failures.push({ name, rule: "HOT_SITO_GIU", detail: "HOT non certificabile — sito irraggiungibile" });
    if (l.website && (l.pagesVisited ?? 0) < 3)
      failures.push({ name, rule: "HOT_CRAWL_INSUFFICIENTE", detail: `solo ${l.pagesVisited ?? 0} pagine` });
    const ev = (l.evidence || "").toLowerCase();
    if (l.website && !ev.includes("trasparenza") && !ev.includes("documenti"))
      failures.push({ name, rule: "HOT_NO_TRASPARENZA", detail: "sezione Trasparenza non documentata" });
  }

  if (v === "PUBLISHED") {
    if (!l.policyFound) failures.push({ name, rule: "PUB_SENZA_POLICY", detail: "policyFound=false su PUBLISHED" });
    if (/^(prodotto|sostituisce)$/i.test(l.policyNumber ?? ""))
      failures.push({ name, rule: "PUB_NUMERO_INVALIDO", detail: `n° ${l.policyNumber}` });
  }

  if (v === "REVIEW" && l.website && l.websiteReachable !== false && (l.pagesVisited ?? 0) >= 5) {
  }
}

// Duplicati stesso nome+regione
const dup = new Map();
for (const l of leads) {
  const k = `${l.region}|${l.companyName.toLowerCase()}`;
  dup.set(k, (dup.get(k) ?? 0) + 1);
}
for (const [k, n] of dup) {
  if (n > 1) failures.push({ name: k, rule: "DUPLICATO", detail: `${n} record` });
}

const pending = await prisma.lead.count({
  where: { type: "HEALTHCARE", region: { in: regions }, lastScannedAt: null },
});

console.log("\n═══ CERTIFICAZIONE CONSEGNA ═══");
console.log(`Analizzati: ${leads.length} | In coda: ${pending}`);
console.log(`Fallimenti gate: ${failures.length}\n`);

if (failures.length) {
  const byRule = {};
  for (const f of failures) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    console.log(`  ✗ [${f.rule}] ${f.name} — ${f.detail}`);
  }
  console.log("\nPer regola:", byRule);
}

if (pending > 0) {
  console.log(`\n⚠ Territorio incompleto: ${pending} strutture non ancora analizzate.`);
}

const ok = failures.length === 0 && pending === 0;
console.log(ok ? "\n✅ CERTIFICATO — pronto consegna" : "\n❌ NON CERTIFICATO — correggere prima del cliente\n");
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
