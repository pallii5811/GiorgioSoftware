import { prisma } from "../src/lib/prisma.ts";
import { readVerdictToken } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: {
    companyName: true,
    region: true,
    website: true,
    websiteReachable: true,
    pagesVisited: true,
    lastScannedAt: true,
    evidence: true,
  },
});

const review = leads.filter((l) => readVerdictToken(l.evidence) === "REVIEW");
const neverScanned = leads.filter((l) => !l.lastScannedAt);
const scannedReview = review.filter((l) => l.lastScannedAt);

function bucket(l) {
  const ev = (l.evidence || "").toLowerCase();
  if (!l.lastScannedAt) return "mai_scansionato";
  if (ev.includes("crash") || ev.includes("errore crawl") || ev.includes("ocr")) return "crash_ocr";
  if (ev.includes("irraggiungibile") || l.websiteReachable === false) return "sito_giu";
  if (!l.website) return "senza_sito";
  if (ev.includes("omonimia") || ev.includes("sito errato") || ev.includes("nome struttura assente"))
    return "sito_errato";
  if (ev.includes("pdf non processati") || ev.includes("crawl incompleto") || ev.includes("non esaustivo"))
    return "crawl_incompleto";
  if (ev.includes("ocr insufficiente") || ev.includes("scannerizzato")) return "ocr_insufficiente";
  if (ev.includes("trasparenza") && ev.includes("non trovata")) return "no_trasparenza";
  if (ev.includes("impossibile certificare")) return "non_certificabile";
  if (ev.includes("re-audit")) return "reaudit_declassato";
  if ((l.pagesVisited ?? 0) < 2) return "crawl_superficiale";
  return "altro_analizzato";
}

const counts = {};
for (const l of review) {
  const b = bucket(l);
  counts[b] = (counts[b] || 0) + 1;
}

console.log("\n═══ PERCHÉ SONO IN REVIEW? ═══\n");
console.log(`REVIEW totali:           ${review.length}`);
console.log(`  Di cui GIÀ scansionati: ${scannedReview.length}`);
console.log(`  Mai scansionati:        ${neverScanned.length} (su tutte le strutture, non solo REVIEW)\n`);
console.log("Motivi (lead già analizzati ma esito inconclusivo):\n");

const labels = {
  mai_scansionato: "Mai passati dallo scan",
  crash_ocr: "Crash OCR / errore crawl",
  sito_giu: "Sito irraggiungibile",
  senza_sito: "Senza sito web (non analizzabili online)",
  sito_errato: "Sito errato / omonimia Maps",
  crawl_incompleto: "Crawl PDF incompleto",
  ocr_insufficiente: "PDF scannerizzato non decodificato",
  no_trasparenza: "Sezione Trasparenza non trovata",
  non_certificabile: "Analizzati ma non certificabili (dubbio)",
  reaudit_declassato: "Declassati da HOT in re-audit",
  crawl_superficiale: "Crawl troppo superficiale",
  altro_analizzato: "Altri (analizzati, motivo generico)",
};

for (const [k, label] of Object.entries(labels)) {
  if (counts[k]) console.log(`  ${String(counts[k]).padStart(3)} — ${label}`);
}

console.log("\n── Esempi ──\n");
for (const l of review.filter((x) => x.lastScannedAt).slice(0, 5)) {
  const body = (l.evidence || "").replace(/^\[V:REV\]\s*/, "").slice(0, 100);
  console.log(`• ${l.companyName?.slice(0, 45)}`);
  console.log(`  ${body}…\n`);
}

await prisma.$disconnect();
