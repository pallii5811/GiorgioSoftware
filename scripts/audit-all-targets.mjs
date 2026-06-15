import { prisma } from "../src/lib/prisma.ts";

const SUSPECT =
  /scuola primaria|scuola elementare|albergo\b|hotel\b|ristorant|lilt|lega italiana|basilic|museo|chiesa|parrocch|tabacch|palestra|distretto sanit|ulss\b|asl\b.*distretto|immobiliar|banca\b|agenzia viagg|onoranze funebri|pompe funebri/i;

const all = await prisma.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: { companyName: true, region: true, category: true, osmId: true },
});

const suspects = all.filter(
  (l) => SUSPECT.test(l.companyName) || SUSPECT.test(l.category ?? "")
);

console.log("Totale in DB:", all.length);
console.log("Sospetti fuori target Gelli:", suspects.length);
for (const s of suspects.slice(0, 25)) {
  console.log(`  [${s.osmId?.split("/")[0]}] ${s.companyName} (${s.region}) — ${s.category ?? "?"}`);
}
if (suspects.length > 25) console.log(`  ... +${suspects.length - 25} altri`);

await prisma.$disconnect();
