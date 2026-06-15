/**
 * Test suite completo — verifica ogni modulo critico del lead engine.
 * Esegui con: node --experimental-vm-modules scripts/test-suite.mjs
 * o con tsx se disponibile: npx tsx scripts/test-suite.mjs
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite, verdictFromRegional, readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { scoreLead } from "../src/lib/sanita/score.ts";

// === UTILITÀ ===
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL: ${msg}\n  Expected: ${expected}\n  Actual: ${actual}`);
  }
}

// === TEST 1: DETECTOR — analyzePolicy ===
function testDetector() {
  console.log("\n=== TEST 1: DETECTOR ===");

  // Caso 1: polizza completa con tutti i dati
  const text1 = `
    Polizza Responsabilità Civile Professionale
    Compagnia: UnipolSai Assicurazioni
    Massimale: € 5.000.000,00
    Numero polizza: RC-2024-001234
    Scadenza: 31/12/2025
    Legge Gelli Bianco
  `;
  const r1 = analyzePolicy(text1);
  assert(r1.policyFound === true, "Caso 1: policyFound deve essere true");
  assert(r1.company === "UnipolSai", `Caso 1: company=${r1.company}`);
  assert(r1.massimale === "€ 5.000.000,00", `Caso 1: massimale=${r1.massimale}`);
  assert(r1.policyNumber === "RC-2024-001234", `Caso 1: policyNumber=${r1.policyNumber}`);
  assert(r1.confidence >= 0.8, `Caso 1: confidence troppo bassa ${r1.confidence}`);
  assert(r1.policyObsolete === false, "Caso 1: policyObsolete deve essere false (data futura)");
  console.log("  ✓ Caso 1: polizza completa con tutti i dati");

  // Caso 2: polizza scaduta da > 365 giorni (2016)
  const text2 = `
    Polizza RC Professionale
    Compagnia: Generali
    Scadenza: 24/05/2016
    Massimale: € 2.000.000
  `;
  const r2 = analyzePolicy(text2);
  assert(r2.policyFound === false, "Caso 2: policyFound deve essere false (scaduta >365gg)");
  assert(r2.policyObsolete === true, "Caso 2: policyObsolete deve essere true");
  assert(r2.company === "Generali", `Caso 2: company=${r2.company}`);
  assert(r2.evidence?.includes("scaduta"), "Caso 2: evidence deve menzionare 'scaduta'");
  console.log("  ✓ Caso 2: polizza scaduta 2016 → obsolete, policyFound=false");

  // Caso 3: autoassicurazione
  const text3 = `
    La struttura gestisce il rischio in forma diretta.
    Autoassicurazione / ritenzione del rischio ai sensi dell'art. 10 L. 24/2017.
  `;
  const r3 = analyzePolicy(text3);
  assert(r3.policyFound === true, "Caso 3: autoassicurazione = policyFound true");
  assert(r3.company === "Autoassicurazione / gestione diretta del rischio", `Caso 3: company=${r3.company}`);
  console.log("  ✓ Caso 3: autoassicurazione riconosciuta");

  // Caso 4: nessuna polizza
  const text4 = `
    Casa di riposo Villa Serena
    Servizi: assistenza anziani, fisioterapia
    Contatti: info@villaserena.it
  `;
  const r4 = analyzePolicy(text4);
  assert(r4.policyFound === false, "Caso 4: nessuna polizza");
  assert(r4.confidence < 0.3, "Caso 4: confidence bassa");
  console.log("  ✓ Caso 4: nessuna polizza → policyFound=false");

  // Caso 5: scadenza vicina (prossimi 90 gg)
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 30);
  const dStr = futureDate.toLocaleDateString("it-IT");
  const text5 = `Polizza RC scadenza ${dStr} compagnia Allianz massimale 3.000.000`;
  const r5 = analyzePolicy(text5);
  assert(r5.policyFound === true, "Caso 5: policyFound true");
  assert(r5.policyObsolete === false, "Caso 5: non obsolete");
  console.log("  ✓ Caso 5: scadenza vicina riconosciuta");

  // Caso 6: solo riferimento Gelli senza dati → non sufficiente
  const text6 = `In ottemperanza alla Legge 24/2017 (Gelli)`;
  const r6 = analyzePolicy(text6);
  assert(r6.policyFound === false, "Caso 6: solo Gelli senza dati → non policyFound");
  console.log("  ✓ Caso 6: solo riferimento Gelli senza dati → non policyFound");

  // Caso 7: Villa Fiorita / Berkshire — massimale RC non fondo dotazione
  const text7 = `
    Polizza N° 2026RCG00376 Berkshire Hathaway International Insurance Limited
    Limite dell'Indennizzo per Risarcimento: EUR 5.000.000,00
    Scadenza: Alle ore 24:00 del 31.01.2027
    Fondo di Dotazione interamente versato € 92.100.000
  `;
  const r7 = analyzePolicy(text7);
  assert(r7.policyFound === true, "Caso 7: policyFound");
  assert(r7.policyNumber === "2026RCG00376", `Caso 7: policyNumber=${r7.policyNumber}`);
  assert(r7.massimale?.includes("5.000.000"), `Caso 7: massimale RC=${r7.massimale}`);
  assert(!r7.massimale?.includes("92"), "Caso 7: non confondere con fondo dotazione");
  console.log("  ✓ Caso 7: Villa Fiorita / massimale RC corretto");

  console.log("  DETECTOR: TUTTI I TEST PASSATI ✓");
}

// === TEST 2: VERDICT ===
function testVerdict() {
  console.log("\n=== TEST 2: VERDICT ===");

  assertEq(verdictFromSite({ reachable: true, policyFound: true, foundRelevantPage: true }), "PUBLISHED", "verdict PUBLISHED");
  assertEq(verdictFromSite({ reachable: true, policyFound: false, foundRelevantPage: true }), "REVIEW", "verdictFromSite mai HOT (solo reconcile)");
  assertEq(verdictFromSite({ reachable: true, policyFound: false, foundRelevantPage: false }), "REVIEW", "verdict REVIEW (non trovata, pagina non rilevante)");
  assertEq(verdictFromSite({ reachable: false, policyFound: false, foundRelevantPage: false }), "REVIEW", "verdict REVIEW (sito non raggiungibile)");

  assertEq(verdictFromRegional({ checked: true, policyFound: true }), "PUBLISHED", "regional PUBLISHED");
  assertEq(verdictFromRegional({ checked: true, policyFound: false }), "HOT", "regional HOT");

  assertEq(readVerdictToken("[V:PUB] Polizza trovata"), "PUBLISHED", "read PUBLISHED");
  assertEq(readVerdictToken("[V:HOT] Nessuna polizza"), "HOT", "read HOT");
  assertEq(readVerdictToken("[V:REV] Da verificare"), "REVIEW", "read REVIEW");

  console.log("  VERDICT: TUTTI I TEST PASSATI ✓");
}

// === TEST 3: SCORE ===
function testScoreLead() {
  console.log("\n=== TEST 3: SCORE LEAD ===");

  // HOT base
  assertEq(scoreLead({ verdict: "HOT" }), 70, "HOT base = 70");
  // HOT + contatti
  assertEq(scoreLead({ verdict: "HOT", phone: "123", email: "a@b.it", pec: "pec@b.it" }), 95, "HOT + contatti = 95");
  // HOT + obsoletePolicy
  assertEq(scoreLead({ verdict: "HOT", phone: "123", email: "a@b.it", obsoletePolicy: true }), 100, "HOT + obsolete + contatti = 100");
  // PUBLISHED base
  assertEq(scoreLead({ verdict: "PUBLISHED" }), 40, "PUBLISHED base = 40");
  // REVIEW base
  assertEq(scoreLead({ verdict: "REVIEW" }), 35, "REVIEW base = 35");
  // PUBLISHED con scadenza vicina
  const nearExpiry = new Date();
  nearExpiry.setDate(nearExpiry.getDate() + 30);
  assertEq(scoreLead({ verdict: "PUBLISHED", expiry: nearExpiry }), 65, "PUBLISHED + scadenza <=90gg = 65");

  console.log("  SCORE: TUTTI I TEST PASSATI ✓");
}

// === TEST 4: PDF DIGITALE (pdf-parse) ===
async function testPdfDigital() {
  console.log("\n=== TEST 4: PDF DIGITALE ===");

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 400]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Polizza RC Professionale", { x: 50, y: 350, font, size: 14, color: rgb(0, 0, 0) });
  page.drawText("Compagnia: Zurich", { x: 50, y: 320, font, size: 12 });
  page.drawText("Scadenza: 31/12/2025", { x: 50, y: 300, font, size: 12 });
  page.drawText("Massimale: 5.000.000 EUR", { x: 50, y: 280, font, size: 12 });
  const pdfBytes = await pdfDoc.save();

  // Simula fetchPdfText con il buffer
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: Buffer.from(pdfBytes) });
  const result = await parser.getText();
  const text = (result?.text || "").replace(/\s+/g, " ").trim();
  await parser.destroy().catch(() => {});

  assert(text.includes("Zurich"), "PDF digitale: deve contenere 'Zurich'");
  assert(text.includes("31/12/2025"), "PDF digitale: deve contenere la scadenza");
  console.log("  ✓ PDF digitale letto correttamente da pdf-parse");

  // Testa il detector sul testo estratto
  const analysis = analyzePolicy(text);
  assert(analysis.policyFound === true, "Detector su PDF digitale: policyFound=true");
  assert(analysis.company === "Zurich", `Detector: company=${analysis.company}`);
  console.log("  ✓ Detector su PDF digitale: polizza riconosciuta");

  console.log("  PDF DIGITALE: TUTTI I TEST PASSATI ✓");
}

// === TEST 5: OCR — extractImagesFromPdf ===
async function testOcrExtraction() {
  console.log("\n=== TEST 5: OCR EXTRACT IMAGES ===");

  const { ocrPdfText, extractPdfFullText, collectPdfImagesForOcr, isOcrEnabled } = await import(
    "../src/lib/sanita/ocr.ts"
  );

  assert(isOcrEnabled(), "OCR deve essere attivo di default");

  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([600, 400]);
  const pdfBytes = await pdfDoc.save();

  const text = await ocrPdfText(Buffer.from(pdfBytes));
  assert(text === null, "PDF senza immagini: OCR deve restituire null");
  console.log("  ✓ PDF senza immagini: OCR restituisce null (corretto)");

  const imgs = await collectPdfImagesForOcr(Buffer.from(pdfBytes));
  assert(imgs.length === 0, "collectPdfImagesForOcr: PDF vuoto → 0 immagini");

  const full = await extractPdfFullText(Buffer.from(pdfBytes));
  assert(typeof full.text === "string", "extractPdfFullText restituisce text");

  console.log("  OCR: TEST BASE PASSATI ✓");
}

// === TEST 6: INTEGRAZIONE — flusso completo simulato ===
function testIntegration() {
  console.log("\n=== TEST 6: INTEGRAZIONE FLUSSO ===");

  // Simula il flusso completo: crawl text → detector → verdict → score
  const crawlText = `
    Casa di Cura Villa Serena
    Email: direzione@villaserena.it
    Tel: +39 041 2345678
    Partita IVA: 01234567890
    Polizza RC Professionale
    Compagnia: UnipolSai
    Scadenza: 31/12/2026
    Massimale: 5.000.000 EUR
  `;

  const analysis = analyzePolicy(crawlText);
  assert(analysis.policyFound === true, "Integration: policyFound");

  const verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: true,
  });
  assert(verdict === "PUBLISHED", "Integration: verdict=PUBLISHED");

  const score = scoreLead({
    verdict,
    phone: "+39 041 2345678",
    email: "direzione@villaserena.it",
    pec: null,
    expiry: analysis.expiry,
  });
  assert(score > 40, `Integration: score=${score}`);

  // Caso HOT (nessuna polizza) — solo reconcile dopo crawl esaustivo (struttura clinica, non RSA assistenziale)
  const crawlHot = `Casa di cura San Giuseppe. Servizi ambulatoriali. Tel: 041 9876543.`;
  const aHot = analyzePolicy(crawlHot);
  const mockCrawl = {
    ok: true,
    text: crawlHot,
    policyText: crawlHot,
    pagesVisited: ["https://example.it/societa-trasparente"],
    error: null,
    foundRelevantPage: true,
    policyExhaustive: true,
    policyPdfsQueued: 0,
    policyPdfsRead: 0,
    needsOcrReview: false,
    policyPdfAnalysis: null,
    emails: [],
    pec: null,
    phones: ["0419876543"],
    piva: null,
  };
  const vHot = reconcilePolicyVerdict(mockCrawl, aHot, "REVIEW", {
    companyName: "Casa di cura San Giuseppe",
    website: "https://example.it",
    city: "Padova",
    category: "Casa di cura",
  }).verdict;
  assert(vHot === "HOT", "Integration: HOT solo dopo reconcile esaustivo");
  const sHot = scoreLead({ verdict: vHot, phone: "041 9876543" });
  assert(sHot === 80, `Integration: HOT score=${sHot} (atteso 80)`);

  console.log("  INTEGRAZIONE: TUTTI I TEST PASSATI ✓");
}

// === ESECUZIONE ===
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   TEST SUITE — LEAD ENGINE SANITÀ                  ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const start = Date.now();
  let failed = 0;

  const tests = [
    testDetector,
    testVerdict,
    testScoreLead,
    testPdfDigital,
    testOcrExtraction,
    testIntegration,
  ];

  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failed++;
      console.error(`\n  ✗ FAIL: ${err.message}`);
    }
  }

  const elapsed = Date.now() - start;
  console.log("\n" + "═".repeat(54));
  if (failed === 0) {
    console.log("║  ✅ TUTTI I TEST PASSATI — 0 ERRORI                ║");
  } else {
    console.log(`║  ❌ ${failed} TEST FALLITI                            ║`);
  }
  console.log(`║  ⏱️  Tempo: ${elapsed}ms                                  ║`);
  console.log("═".repeat(54));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
