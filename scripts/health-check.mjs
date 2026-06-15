/**
 * Health check LeadSniper — stato DB, API, audit trail, demo reset.
 * Uso: npx tsx scripts/health-check.mjs [baseUrl]
 */
const base = process.argv[2] || "http://localhost:3001";

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

function verdict(evidence) {
  if (!evidence) return "PENDING";
  if (evidence.startsWith("[V:HOT]")) return "HOT";
  if (evidence.startsWith("[V:PUB]")) return "PUBLISHED";
  if (evidence.startsWith("[V:REV]")) return "REVIEW";
  return "LEGACY";
}

async function main() {
  console.log("\n═══ LEADSNIPER HEALTH CHECK ═══\n");

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const healthcare = await prisma.lead.count({ where: { type: "HEALTHCARE" } });
    const tender = await prisma.lead.count({ where: { type: "TENDER" } });
    const scanned = await prisma.lead.count({ where: { type: "HEALTHCARE", lastScannedAt: { not: null } } });
    const withAudit = await prisma.lead.count({
      where: { type: "HEALTHCARE", evidence: { contains: "[FONTI:" } },
    });

    for (const region of ["Campania", "Veneto"]) {
      const total = await prisma.lead.count({ where: { type: "HEALTHCARE", region } });
      const done = await prisma.lead.count({
        where: { type: "HEALTHCARE", region, lastScannedAt: { not: null } },
      });
      const audit = await prisma.lead.count({
        where: { type: "HEALTHCARE", region, evidence: { contains: "[FONTI:" } },
      });
      console.log(`${region}: ${done}/${total} scansionati · ${audit} con audit trail`);
    }

    console.log(`\nTotale HEALTHCARE: ${healthcare} | TENDER: ${tender} | Scansionati: ${scanned} | Audit: ${withAudit}`);
  } finally {
    await prisma.$disconnect();
  }

  const sanita = await get("/api/sanita");
  const gare = await get("/api/gare");
  console.log(`\nGET /api/sanita: ${sanita.status} tavily=${sanita.json?.meta?.tavilyAvailable}`);
  console.log(`GET /api/gare: ${gare.status} leads=${gare.json?.data?.length ?? 0}`);

  if (sanita.json?.data) {
    const byV = { HOT: 0, PUBLISHED: 0, REVIEW: 0, PENDING: 0, LEGACY: 0 };
    for (const l of sanita.json.data) {
      const v = l.lastScannedAt ? verdict(l.evidence) : "PENDING";
      byV[v] = (byV[v] || 0) + 1;
    }
    console.log("\nVerdetti globali:", byV);
  }

  const bad = await fetch(`${base}/api/sanita`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ region: "Lazio" }),
  });
  console.log(`POST regione invalida: ${bad.status === 400 ? "OK (400)" : "FAIL " + bad.status}`);

  // DELETE senza region → 400
  const delBad = await fetch(`${base}/api/sanita`, { method: "DELETE" });
  console.log(`DELETE senza region: ${delBad.status === 400 ? "OK (400)" : "FAIL " + delBad.status}`);

  console.log("\n✓ Health check completato\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
