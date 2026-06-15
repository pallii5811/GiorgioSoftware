/**
 * Quante strutture NON sono target Gelli (Art. 10)?
 * npx tsx scripts/count-non-gelli-targets.mjs
 */
import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { classifyGelliScope } from "../src/lib/sanita/gelli-scope.ts";

function classify(lead) {
  const r = classifyGelliScope(lead.companyName, lead.category, lead.osmId);
  if (r.ok) {
    if (lead.osmId?.startsWith("min-salute/")) {
      return { bucket: "OK_MIN_SALUTE", reason: r.reason };
    }
    return { bucket: "OK_TARGET", reason: r.reason };
  }
  return { bucket: "NO_GELLI", reason: r.reason };
}

const all = await prisma.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: {
    id: true,
    companyName: true,
    region: true,
    category: true,
    osmId: true,
    lastScannedAt: true,
    evidence: true,
  },
});

const analyzed = all.filter((l) => l.lastScannedAt);
const counts = { OK_MIN_SALUTE: 0, OK_TARGET: 0, NO_GELLI: 0 };
const notOk = [];

for (const l of all) {
  const c = classify(l);
  counts[c.bucket]++;
  if (c.bucket === "NO_GELLI") {
    notOk.push({
      name: l.companyName,
      region: l.region,
      category: l.category,
      source: l.osmId?.split("/")[0] ?? "?",
      reason: c.reason,
      analyzed: !!l.lastScannedAt,
      verdict: l.lastScannedAt ? readVerdictToken(l.evidence) : null,
    });
  }
}

const analyzedNotOk = notOk.filter((x) => x.analyzed);

console.log("\n═══ TUTTE LE STRUTTURE IN DB ═══");
console.log("Totale:", all.length);
console.log("Target Gelli (art. 10):", counts.OK_TARGET + counts.OK_MIN_SALUTE);
console.log("NON target Gelli:", notOk.length);
console.log("  — OK Min.Salute:", counts.OK_MIN_SALUTE);
console.log("  — OK strutture:", counts.OK_TARGET);

console.log("\n═══ SOLO QUELLE GIÀ ANALIZZATE ═══");
console.log("Analizzate:", analyzed.length);
console.log("NON target tra analizzate:", analyzedNotOk.length);

if (notOk.length) {
  console.log("\n── Elenco NON target (tutte) ──");
  for (const x of notOk) {
    console.log(
      `  [${x.source}] ${x.name} (${x.region}) | ${x.reason} | analizzata=${x.analyzed}${x.verdict ? ` ${x.verdict}` : ""}`
    );
  }
}

await prisma.$disconnect();
