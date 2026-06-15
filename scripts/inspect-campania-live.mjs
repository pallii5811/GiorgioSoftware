import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", region: "Campania", lastScannedAt: { not: null } },
  orderBy: { lastScannedAt: "desc" },
});

console.log(`\n═══ CAMPANIA — ${leads.length} analizzate ═══\n`);
for (const l of leads) {
  const v = readVerdictToken(l.evidence) ?? "?";
  const exp = l.policyExpiry ? new Date(l.policyExpiry).toISOString().slice(0, 10) : "—";
  const body = (l.evidence || "").replace(/^\[V:\w+\]\s*/, "").slice(0, 110);
  console.log(`[${v}] ${l.companyName?.slice(0, 48)} · ${l.city ?? "?"}`);
  console.log(`      sito: ${l.website ?? "NESSUNO"} | pag: ${l.pagesVisited ?? 0} | polizza: ${l.policyFound ? `SÌ (${l.policyCompany ?? "?"} scad. ${exp})` : "no"}`);
  console.log(`      ${body}\n`);
}

await prisma.$disconnect();
