import { readFileSync, existsSync } from "fs";
import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", lastScannedAt: { not: null } },
  orderBy: [{ leadScore: "desc" }, { companyName: "asc" }],
});

const byVerdict = { HOT: [], PUBLISHED: [], REVIEW: [], OTHER: [] };
for (const l of leads) {
  const v = readVerdictToken(l.evidence) ?? "OTHER";
  (byVerdict[v] ?? byVerdict.OTHER).push(l);
}

/** HOT certo: sito raggiungibile, polizza non trovata, evidenza esplicita su Trasparenza. */
function isReliableHot(l) {
  if (readVerdictToken(l.evidence) !== "HOT") return false;
  if (l.policyFound === true) return false;
  if (l.websiteReachable === false) return false;
  const ev = (l.evidence || "").toLowerCase();
  const transparencyRead =
    ev.includes("trasparenza") ||
    ev.includes("trasparenza") ||
    ev.includes("pdf verificati") ||
    ev.includes("sezione trasparenza") ||
    (l.pagesVisited ?? 0) >= 3;
  const notJustRegional =
    !ev.includes("solo portali") || ev.includes("sito:");
  return transparencyRead && notJustRegional && Boolean(l.website);
}

/** HOT debole: senza sito o solo portale ASL o crawl incompleto. */
function isWeakHot(l) {
  return readVerdictToken(l.evidence) === "HOT" && !isReliableHot(l);
}

const reliable = byVerdict.HOT.filter(isReliableHot);
const weak = byVerdict.HOT.filter(isWeakHot);

console.log("\n══════════════════════════════════════════════════");
console.log("  LEAD HOT — CHI NON HA DAVVERO PUBBLICATO LA POLIZZA");
console.log("══════════════════════════════════════════════════\n");
console.log(`Scansionati: ${leads.length}`);
console.log(`HOT totali: ${byVerdict.HOT.length}`);
console.log(`  → AFFIDABILI (sito + Trasparenza verificata): ${reliable.length}`);
console.log(`  → DEBOLI (da ricontrollare): ${weak.length}`);
console.log(`PUBLISHED: ${byVerdict.PUBLISHED.length}`);
console.log(`REVIEW: ${byVerdict.REVIEW.length}\n`);

console.log("─── HOT AFFIDABILI (priorità commerciale) ───\n");
for (const l of reliable) {
  const host = l.website?.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] ?? "—";
  console.log(
    `• [${l.leadScore ?? 0}] ${l.companyName}` +
      (l.city ? ` — ${l.city}` : "") +
      ` (${l.region})` +
      `\n  ${host}`
  );
}

if (weak.length > 0) {
  console.log(`\n─── HOT DEBOLI / DA VERIFICARE MANUALE (${weak.length}) ───\n`);
  for (const l of weak.slice(0, 15)) {
    console.log(`? ${l.companyName} (${l.region}) — ${l.website ?? "no sito"}`);
  }
  if (weak.length > 15) console.log(`  … +${weak.length - 15} altri`);
}

// verify report progress
if (existsSync("verify-report.jsonl")) {
  const lines = readFileSync("verify-report.jsonl", "utf8").trim().split("\n").filter(Boolean);
  const verified = lines.length;
  const fixed = lines.filter((ln) => JSON.parse(ln).changed).length;
  console.log(`\n─── Verify in corso: ${verified}/295 processati, ${fixed} corretti ───`);
}

await prisma.$disconnect();
