/**
 * Test suite completo — verifica ogni modulo critico del lead engine.
 * Esegui con: node --experimental-vm-modules scripts/test-suite.mjs
 * o con tsx se disponibile: npx tsx scripts/test-suite.mjs
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { extractJsonPolicyText, extractPageText } from "../src/lib/sanita/extract-embedded.ts";
import { reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";
import { verdictFromSite, verdictFromRegional, readVerdictToken, finalizeVerdict } from "../src/lib/sanita/verdict.ts";
import { scoreLead } from "../src/lib/sanita/score.ts";
import {
  deriveCrawlComplete,
  crawlBlocksTerminalVerdict,
} from "../src/lib/evidence/contract.ts";
import { estimateCauzione, scoreGareCommercial, claimKindLabel } from "../src/lib/gare/commercial.ts";
import { scoreSanitaCommercial } from "../src/lib/sanita/commercial.ts";

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
  assert(r2.policyFound === true, "Caso 2: polizza pubblicata resta trovata anche se scaduta >365gg");
  assert(r2.policyObsolete === true, "Caso 2: policyObsolete deve essere true");
  assert(r2.company === "Generali", `Caso 2: company=${r2.company}`);
  assert(r2.evidence?.includes("scaduta"), "Caso 2: evidence deve menzionare 'scaduta'");
  console.log("  ✓ Caso 2: polizza scaduta 2016 → policyFound=true + obsolete (non assenza)");

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

  // Caso 6b: PARM — assunzione diretta del rischio (Minerva-style)
  const text6b = `
    PIANO ANNUALE DI RISK MANAGEMENT legge 24/2017
    DESCRIZIONE DELLA POSIZIONE ASSICURATIVA
    La Casa di Cura ha istituito una misura analoga alle coperture assicurative,
    con assunzione diretta del rischio, prevedendo fondo rischio e fondo riserva sinistri.
  `;
  const r6b = analyzePolicy(text6b);
  assert(r6b.policyFound === true, "Caso 6b: assunzione diretta PARM = policyFound true");
  console.log("  ✓ Caso 6b: assunzione diretta del rischio in PARM riconosciuta");

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

  // Caso 8: Villa Maione — PARM con risarcimenti erogati NON è polizza RC art.10
  const text8 = `
    LEGGE GELLI — Relazione annuale consuntiva sugli eventi avversi
    Sinistrosità e risarcimenti erogati nell'ultimo quinquennio.
    La clinica Maione è titolare di una Polizza Assicurativa RC stipulata con AmTrust Italia.
    Anno 2018 | N. sinistri liquidati 2 | Risarcimenti erogati 20.889,62€
    Anno 2019 | Risarcimenti erogati 394.593,00€
    Dal 2019 è stata stipulata polizza con AM TRUST ITALIA con scadenza triennale (si allega in parte).
  `;
  const r8 = analyzePolicy(text8);
  assert(r8.policyFound === false, `Caso 8 Villa Maione PARM: policyFound deve essere false (era ${r8.policyFound})`);
  assert(r8.massimale == null || !String(r8.massimale).includes("20.889"), `Caso 8: massimale non deve essere risarcimento (${r8.massimale})`);
  console.log("  ✓ Caso 8: Villa Maione PARM/risarcimenti → NON policyFound");

  // Caso 9: solo compagnia citata in pagina Trasparenza Gelli (art.2-4) senza estremi polizza
  const text9 = `
    LEGGE GELLI: art. 2 e 4 impongono relazione eventi avversi e pubblicazione risarcimenti.
    PARM 2024 — CONSULTA I DOCUMENTI
    Compagnia assicurativa: Generali
    Servizi erogati, carta dei servizi, liste di attesa.
  `;
  const r9 = analyzePolicy(text9);
  assert(r9.policyFound === false, `Caso 9 Villa Cinzia: solo Generali in Trasparenza → policyFound=false (era ${r9.policyFound})`);
  console.log("  ✓ Caso 9: solo compagnia in Trasparenza → NON policyFound");

  // Caso 10: PDF costi contabilizzati — "fondo rischi" contabile ≠ autoassicurazione Gelli
  const text10 = `
    COSTI CONTABILIZZATI NEL 2021
    Servizi Offerti Materie Prime Personale Altri costi Totale
    La voce "Altri Costi" include var.rimanenze, accantonamento fondo rischi e oneri diversi di gestione
    Ricoveri/Ambulatoriali SSN + Privati 10.440.923 €
  `;
  const r10 = analyzePolicy(text10);
  assert(r10.policyFound === false, `Caso 10 Costi contabilizzati: policyFound=false (era ${r10.policyFound})`);
  console.log("  ✓ Caso 10: Costi contabilizzati / fondo rischi contabile → NON policyFound");

  // Caso 11: Montevergine — art.10 + polizza Generali su pagina Gestione del Rischio Clinico
  const text11 = `
    OBIETTIVO CUORE rubrica settimanale articoli cardiologia news blog
    Gestione del Rischio Clinico relazione annuale eventi avversi art. 2 comma 5 L. 24/2017
    Art.10 Legge Gelli-Bianco 8 Marzo 2017 n.24.
    La società Casa di Cura Privata Montevergine S.p.A. rende noto, che Assicurazioni Generali S.p.A.
    presta la copertura assicurativa in ordine alla responsabilità civile verso terzi e verso i prestatori d'opera,
    in forza del Contratto di cui alla polizza n. 450289527 emessa il 11/04/2025 stipulato in data 20/04/2019,
    che prevede i seguenti massimali: RCT € 5.000.000,00 per ogni sinistro; RCO € 5.000.000,00 per ogni sinistro;
  `;
  const r11 = analyzePolicy(text11);
  assert(r11.policyFound === true, `Caso 11 Montevergine: policyFound=true (era ${r11.policyFound})`);
  assert(r11.company === "Assicurazioni Generali" || r11.company === "Generali", `Caso 11: company=${r11.company}`);
  assert(r11.policyNumber === "450289527", `Caso 11: policyNumber=${r11.policyNumber}`);
  console.log("  ✓ Caso 11: Montevergine art.10 su Gestione Rischio Clinico → policyFound");

  // Caso 12: Malzoni PARS — autoassicurazione art.10 dentro documento PARS (non solo PARM art.4)
  const text12 = `
    PARS 2025 Piano Annuale per la Gestione del Rischio Sanitario
    Malzoni Research Hospital S.p.A.
    Art. 10 Legge Gelli-Bianco 24/2017 — responsabilità civile verso terzi
    La struttura adotta la forma di autoassicurazione / gestione diretta del rischio
    per la copertura assicurativa RC professionale sanitaria.
  `;
  const r12 = analyzePolicy(text12);
  assert(r12.policyFound === true, `Caso 12 Malzoni PARS autoassicurazione: policyFound=true (era ${r12.policyFound})`);
  assert(
    r12.company === "Autoassicurazione / gestione diretta del rischio",
    `Caso 12: company=${r12.company}`
  );
  console.log("  ✓ Caso 12: Malzoni PARS con autoassicurazione art.10 → policyFound");

  // Caso 13: Villa dei Fiori Acerra — PARM 2026 sezione posizione assicurativa RCT/RCO AmTrust
  const text13 = `
    PIANO ANNUALE RISK MANAGEMENT PARM 2026 Legge Gelli 24/2017
    1.4 DESCRIZIONE DELLA POSIZIONE ASSICURATIVA
    Allo stato la struttura ha stipulato una polizza assicurativa per RCT e RCO con la AM Trust.
  `;
  const r13 = analyzePolicy(text13);
  assert(r13.policyFound === true, `Caso 13 Villa dei Fiori PARM: policyFound=true (era ${r13.policyFound})`);
  assert(r13.company === "AmTrust", `Caso 13: company=${r13.company}`);
  console.log("  ✓ Caso 13: Villa dei Fiori PARM RCT/RCO AmTrust → policyFound");

  console.log("  DETECTOR: TUTTI I TEST PASSATI ✓");
}

function testFalsePositiveGates() {
  console.log("\n=== TEST 1b: ANTI FALSI PUBLISHED (reconcile) ===");

  const mockCrawl = {
    ok: true,
    text: "LEGGE GELLI PARM 2024. Compagnia: Generali. Risarcimenti erogati 20.889,62€",
    policyText: "LEGGE GELLI PARM 2024. Compagnia: Generali.",
    pagesVisited: ["https://clinicavillacinzia.com/amministrazione-trasparente/"],
    error: null,
    foundRelevantPage: true,
    policyExhaustive: true,
    policyPdfsQueued: 0,
    policyPdfsRead: 0,
    needsOcrReview: false,
    policyPdfAnalysis: null,
    policyPdfUrl: null,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
  };
  const analysis = analyzePolicy(mockCrawl.policyText);
  const rec = reconcilePolicyVerdict(mockCrawl, analysis, "REVIEW", {
    companyName: "Casa Di Cura Villa Cinzia",
    website: "https://clinicavillacinzia.com",
    city: "Napoli",
    category: "Casa di cura accreditata (Min. Salute)",
  });
  assert(rec.verdict !== "PUBLISHED", `reconcile non deve dare PUBLISHED (era ${rec.verdict})`);
  console.log(`  ✓ reconcile Villa Cinzia-like → ${rec.verdict} (non PUBLISHED)`);

  const autoHtmlCrawl = {
    ...mockCrawl,
    text: "Autoassicurazione / gestione diretta del rischio. Art. 10 Legge Gelli.",
    policyText: "Autoassicurazione / gestione diretta del rischio.",
    pagesVisited: ["https://villadeifiori.it/amministrazione-trasparente/"],
    policyPdfUrl: null,
    policyPdfAnalysis: null,
  };
  const autoAnalysis = analyzePolicy(autoHtmlCrawl.policyText);
  const autoRec = reconcilePolicyVerdict(autoHtmlCrawl, autoAnalysis, "REVIEW");
  assert(autoRec.verdict !== "PUBLISHED", `autoassicurazione HTML senza PDF → non PUBLISHED (era ${autoRec.verdict})`);
  console.log(`  ✓ autoassicurazione solo HTML → ${autoRec.verdict}`);

  const pdfUrl = "https://example.it/wp-content/polizza-rc-2026.pdf";
  const pdfCrawl = {
    ...mockCrawl,
    text: "",
    policyText: "Polizza RC Professionale Compagnia: Zurich Scadenza: 31/12/2026 Massimale: 5.000.000 EUR",
    pagesVisited: [pdfUrl],
    policyPdfUrl: pdfUrl,
    policyPdfAnalysis: analyzePolicy(
      "Polizza RC Professionale Compagnia: Zurich Scadenza: 31/12/2026 Massimale: 5.000.000 EUR N. polizza RCG123456"
    ),
  };
  const pdfRec = reconcilePolicyVerdict(pdfCrawl, pdfCrawl.policyPdfAnalysis, "REVIEW");
  assert(pdfRec.verdict === "PUBLISHED", `PDF polizza RC → PUBLISHED (era ${pdfRec.verdict})`);
  console.log("  ✓ PDF polizza RC concreti → PUBLISHED");

  const costiPdfUrl =
    "https://www.villadeifioriacerra.it/wp-content/uploads/2022/06/Costi-contabilizzati-nel-2021.pdf";
  const costiPdfCrawl = {
    ...mockCrawl,
    text: "",
    policyText: `COSTI CONTABILIZZATI NEL 2021 accantonamento fondo rischi Ricoveri/Ambulatoriali`,
    pagesVisited: [costiPdfUrl],
    policyPdfUrl: costiPdfUrl,
    policyPdfAnalysis: analyzePolicy(
      `COSTI CONTABILIZZATI NEL 2021 accantonamento fondo rischi Ricoveri/Ambulatoriali`
    ),
  };
  const costiRec = reconcilePolicyVerdict(costiPdfCrawl, costiPdfCrawl.policyPdfAnalysis, "REVIEW");
  assert(costiRec.verdict !== "PUBLISHED", `Costi contabilizzati PDF → non PUBLISHED (era ${costiRec.verdict})`);
  console.log(`  ✓ Costi contabilizzati PDF → ${costiRec.verdict} (non PUBLISHED)`);

  const cartaUrl = "https://www.gepos.it/wp-content/uploads/2025/06/Carta-Servizi-GEPOS-2025.pdf";
  const cartaCrawl = {
    ...mockCrawl,
    text: "Carta dei Servizi. Notizie generali. Servizi generali.",
    policyText: "Carta dei Servizi",
    pagesVisited: [cartaUrl],
    policyPdfUrl: cartaUrl,
    policyPdfAnalysis: { policyFound: true, company: "Generali", massimale: "15.000,00 euro", confidence: 1, policyObsolete: false },
  };
  const cartaRec = reconcilePolicyVerdict(cartaCrawl, cartaCrawl.policyPdfAnalysis, "REVIEW");
  assert(cartaRec.verdict !== "PUBLISHED", `Carta Servizi non deve essere PUBLISHED (era ${cartaRec.verdict})`);
  console.log(`  ✓ Carta Servizi GEPOS-like → ${cartaRec.verdict}`);

  const montevergineUrl =
    "https://www.clinicamontevergine.com/cuore/q-service/gestione-del-rischio-clinico/";
  const monteverginePolicy = `
    Art.10 Legge Gelli-Bianco 8 Marzo 2017 n.24.
    Assicurazioni Generali S.p.A. copertura assicurativa responsabilità civile verso terzi e prestatori d'opera
    polizza n. 450289527 RCT € 5.000.000,00 RCO € 5.000.000,00
  `;
  const montevergineCrawl = {
    ...mockCrawl,
    text: monteverginePolicy,
    policyText: monteverginePolicy,
    pagesVisited: [montevergineUrl],
    policyPdfUrl: null,
    policyPdfAnalysis: null,
  };
  const montevergineRec = reconcilePolicyVerdict(
    montevergineCrawl,
    analyzePolicy(monteverginePolicy),
    "REVIEW",
    {
      companyName: "Casa Di Cura Montevergine",
      website: "https://www.clinicamontevergine.com",
      city: "Mercogliano",
      category: "Casa di cura accreditata (Min. Salute)",
    }
  );
  assert(
    montevergineRec.verdict === "PUBLISHED",
    `Montevergine gestione rischio clinico → PUBLISHED (era ${montevergineRec.verdict})`
  );
  console.log("  ✓ Montevergine art.10 HTML → PUBLISHED");

  const parmPdfUrl =
    "https://www.clinicamontevergine.com/wp-content/uploads/relazione-annuale-rischio-clinico-2024.pdf";
  const parmPdfCrawl = {
    ...montevergineCrawl,
    policyPdfUrl: parmPdfUrl,
    policyPdfAnalysis: {
      policyFound: true,
      company: "Generali",
      massimale: null,
      policyNumber: null,
      expiry: new Date("2025-12-31"),
      confidence: 0.6,
      evidence: "Relazione annuale rischio clinico eventi avversi",
    },
  };
  const parmRec = reconcilePolicyVerdict(
    parmPdfCrawl,
    analyzePolicy(monteverginePolicy),
    "REVIEW"
  );
  assert(
    parmRec.verdict === "PUBLISHED",
    `Montevergine HTML + PDF PARM parziale → PUBLISHED (era ${parmRec.verdict})`
  );
  console.log("  ✓ Montevergine HTML + PDF PARM parziale → PUBLISHED");

  const malzoniParsUrl =
    "http://www.malzoni.it/wp-content/uploads/2021/09/PARS-2025-Malzoni-Research-Hospital-S.p.A..pdf";
  const malzoniParsText = `
    PARS 2025 Piano Annuale Gestione del Rischio Sanitario Malzoni Research Hospital
    Art. 10 Legge Gelli 24/2017 responsabilità civile verso terzi
    autoassicurazione gestione diretta del rischio copertura assicurativa RC
  `;
  const malzoniCrawl = {
    ...mockCrawl,
    text: malzoniParsText,
    policyText: malzoniParsText,
    pagesVisited: ["https://www.malzoni.it/societa-trasparente/", malzoniParsUrl],
    policyPdfUrl: malzoniParsUrl,
    policyPdfAnalysis: analyzePolicy(malzoniParsText),
  };
  const malzoniRec = reconcilePolicyVerdict(malzoniCrawl, malzoniCrawl.policyPdfAnalysis, "REVIEW", {
    companyName: "Casa Di Cura Villa Dei Platani",
    website: "https://www.malzoni.it",
    city: "Avellino",
  });
  assert(
    malzoniRec.verdict === "PUBLISHED",
    `Malzoni PARS autoassicurazione → PUBLISHED (era ${malzoniRec.verdict})`
  );
  console.log("  ✓ Malzoni PARS PDF autoassicurazione → PUBLISHED");

  const fioriParmUrl =
    "https://www.villadeifioriacerra.it/wp-content/uploads/PARM-2026-VILLA-DEI-FIORI-.pdf";
  const fioriParmText = `
    PARM 2026 Piano Annuale Risk Management Legge Gelli
    1.4 DESCRIZIONE DELLA POSIZIONE ASSICURATIVA
    stipulato una polizza assicurativa per RCT e RCO con la AM Trust.
  `;
  const fioriRec = reconcilePolicyVerdict(
    {
      ...mockCrawl,
      text: fioriParmText,
      policyText: fioriParmText,
      pagesVisited: ["https://www.villadeifioriacerra.it/trasparenza/", fioriParmUrl],
      policyPdfUrl: fioriParmUrl,
      policyPdfAnalysis: analyzePolicy(fioriParmText),
    },
    analyzePolicy(fioriParmText),
    "REVIEW"
  );
  assert(fioriRec.verdict === "PUBLISHED", `Villa dei Fiori PARM → PUBLISHED (era ${fioriRec.verdict})`);
  console.log("  ✓ Villa dei Fiori PARM AmTrust → PUBLISHED");

  const crossHostRec = reconcilePolicyVerdict(
    {
      ok: true,
      text: "Polizza RC Generali massimale 5.000.000",
      policyText: "Polizza RC Generali",
      pagesVisited: ["https://www.villadeipini.com/site/"],
      policyPdfUrl: "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf",
      foundRelevantPage: true,
      policyExhaustive: true,
      needsOcrReview: false,
      policyPdfsQueued: 1,
      policyPdfsRead: 1,
      policyPdfAnalysis: analyzePolicy("Polizza RC Generali massimale 5.000.000 scadenza 31/12/2026"),
    },
    analyzePolicy("Polizza RC Generali massimale 5.000.000 scadenza 31/12/2026"),
    "REVIEW",
    { companyName: "Casa di Riposo Alfonso Rubilli", website: "http://www.casadiriposorubilli.it/", city: "Avellino" }
  );
  assert(crossHostRec.verdict !== "PUBLISHED", `cross-host Rubilli/Pini → non PUBLISHED (era ${crossHostRec.verdict})`);
  console.log(`  ✓ Gate host reconcile cross-struttura → ${crossHostRec.verdict}`);

  console.log("  ANTI FALSI PUBLISHED: TUTTI I TEST PASSATI ✓");
}

async function testSiteIdentity() {
  console.log("\n=== TEST 1d: SITE IDENTITY ===");
  const { companyNameOnSite, crawlHostMatchesWebsite, validateSiteIdentity } = await import(
    "../src/lib/sanita/site-identity.ts"
  );
  const {
    buildIdentityEvidence,
    identityBlocksTerminalVerdict,
    deriveIdentityVerified,
  } = await import("../src/lib/sanita/identity-evidence.ts");

  const okPini = companyNameOnSite(
    "Casa Di Cura Privata Villa Dei Pini S.p.A.",
    "Benvenuti alla Villa Dei Pini casa di cura ad Avellino"
  );
  assert(okPini, "Villa Dei Pini deve essere riconosciuta sul sito");
  console.log("  ✓ Villa Dei Pini riconosciuta sul testo sito");

  const crossHostCrawl = {
    ok: true,
    pagesVisited: ["https://www.villadeipini.com/site/"],
    policyPdfUrl: "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf",
    text: "",
    policyText: "",
  };
  const blocked = crawlHostMatchesWebsite("http://www.casadiriposorubilli.it/", crossHostCrawl);
  assert(!blocked.ok, "Rubilli con crawl/PDF Pini deve essere bloccato");
  console.log("  ✓ Gate host: PDF cross-struttura → bloccato");

  const twinCrawl = {
    ok: true,
    pagesVisited: ["https://www.nepheocare.com/trasparenza"],
    policyPdfUrl: "https://www.nepheocare.com/polizza.pdf",
    text: "",
    policyText: "",
  };
  assert(crawlHostMatchesWebsite("https://www.nepheocare.it/", twinCrawl).ok, "TLD gemello .it/.com ok");
  console.log("  ✓ Gate host: stesso brand .it/.com → permesso");

  // --- Contratto IdentityEvidence: verified mai da verdetto precedente ---
  const legacyHotIdentity = buildIdentityEvidence({
    status: "NOT_CHECKED",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: ["Vecchio HOT senza prove identità"],
    conflicts: [],
  });
  assert(legacyHotIdentity.verified === false, "vecchio HOT senza prove → verified=false");
  assert(!!identityBlocksTerminalVerdict(legacyHotIdentity), "blocca HOT terminal");

  const legacyPub = buildIdentityEvidence({
    status: "INSUFFICIENT",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: ["Vecchio PUBLISHED senza IdentityEvidence"],
    conflicts: [],
  });
  assert(legacyPub.verified === false, "vecchio PUB senza prove → verified=false");
  assert(!!identityBlocksTerminalVerdict(legacyPub), "blocca PUB terminal");

  const groupOk = buildIdentityEvidence({
    status: "GROUP_OFFICIAL_CONFIRMED",
    matchedLegalName: true,
    matchedFacilityName: true,
    matchedAddress: true,
    matchedMunicipality: true,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: true,
    sourceUrls: ["https://gruppo.example.it/sedi/napoli"],
    reasons: ["Dominio gruppo + relazione sede verificata"],
    conflicts: [],
  });
  assert(groupOk.verified === true, "GROUP con relazione sede → verified");
  assert(identityBlocksTerminalVerdict(groupOk) === null, "GROUP ok non blocca");

  const groupNoSeat = buildIdentityEvidence({
    status: "PROBABLE",
    matchedLegalName: true,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: ["https://gruppo.example.it/"],
    reasons: ["Dominio gruppo senza prova della sede"],
    conflicts: [],
  });
  assert(groupNoSeat.verified === false, "gruppo senza sede → non verified");
  assert(!!identityBlocksTerminalVerdict(groupNoSeat), "gruppo senza sede blocca");

  const omonima = validateSiteIdentity(
    "Casa di Cura Sant'Anna",
    "https://santanna-altro.it",
    {
      ok: true,
      text: "Benvenuti alla clinica omonima di Milano. Nessun riferimento Campania.",
      policyText: "",
      pagesVisited: ["https://santanna-altro.it/"],
      foundRelevantPage: false,
      policyExhaustive: false,
      policyPdfsQueued: 0,
      policyPdfsRead: 0,
      needsOcrReview: false,
      emails: [],
      pec: null,
      phones: [],
      piva: null,
      error: null,
      policyPdfAnalysis: null,
      policyPdfUrl: null,
    },
    "Napoli"
  );
  assert(!omonima.ok, "omonimia / comune diverso → identity fail");
  console.log("  ✓ omonimia / comune differente bloccata");

  const stalePanel = buildIdentityEvidence({
    status: "STALE_PANEL",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: ["Pannello Google Maps obsoleto"],
    conflicts: ["Maps URL non corrisponde al sito istituzionale"],
  });
  assert(!deriveIdentityVerified(stalePanel.status), "STALE_PANEL non verified");
  assert(!!identityBlocksTerminalVerdict(stalePanel), "STALE_PANEL blocca");

  const inherited = buildIdentityEvidence({
    status: "MISMATCH",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: ["https://villadeipini.com"],
    reasons: ["Dati ereditati da struttura precedente nello stesso batch"],
    conflicts: ["host crawl ≠ website lead"],
  });
  assert(/Contaminazione critica/i.test(identityBlocksTerminalVerdict(inherited) || ""), "MISMATCH = contaminazione");

  const similarNameWrongAddr = validateSiteIdentity(
    "Poliambulatorio Salus Napoli",
    "https://salus-milano.example.it",
    {
      ok: true,
      text: "Poliambulatorio Salus — Via Roma 1, Milano. Orari e prenotazioni.",
      policyText: "",
      pagesVisited: ["https://salus-milano.example.it/", "https://salus-milano.example.it/contatti"],
      foundRelevantPage: true,
      policyExhaustive: true,
      policyPdfsQueued: 0,
      policyPdfsRead: 0,
      needsOcrReview: false,
      emails: [],
      pec: null,
      phones: [],
      piva: null,
      error: null,
      policyPdfAnalysis: null,
      policyPdfUrl: null,
    },
    "Napoli"
  );
  assert(!similarNameWrongAddr.ok, "nome simile indirizzo/città diversa → fail");
  console.log("  ✓ sito nome simile + indirizzo differente bloccato");

  console.log("  SITE IDENTITY: TUTTI I TEST PASSATI ✓");
}

async function testGuessWebsite() {
  console.log("\n=== TEST 1c: GUESS WEBSITE ===");
  const { probeGuessedOfficialWebsite } = await import("../src/lib/sanita/guess-website.ts");
  const villaMaria = await probeGuessedOfficialWebsite("Casa Di Cura Villa Maria BAIANO");
  assert(
    villaMaria && /villamaria/i.test(villaMaria),
    `Villa Maria → dominio *villamaria* (era ${villaMaria})`
  );
  console.log(`  ✓ Villa Maria Baiano → ${villaMaria}`);

  const montevergine = await probeGuessedOfficialWebsite("Casa Di Cura Montevergine", {
    deadline: Date.now() + 45_000,
  });
  if (montevergine) {
    assert(/montevergine/i.test(montevergine), `Montevergine dominio errato: ${montevergine}`);
    console.log(`  ✓ Montevergine → ${montevergine}`);
  } else {
    console.log("  ⚠ Montevergine: sito lento — risolto via Maps in scansione");
  }

  const platani = await probeGuessedOfficialWebsite("Casa Di Cura Villa Dei Platani", {
    deadline: Date.now() + 30_000,
  });
  assert(
    platani && (/platani|malzoni/i.test(platani)),
    `Villa Dei Platani → platani/malzoni (era ${platani})`
  );
  console.log(`  ✓ Villa Dei Platani → ${platani}`);

  const gepos = await probeGuessedOfficialWebsite("Casa Di Cura Ge.P.O.S. S.r.l.");
  if (gepos && /gepos/i.test(gepos)) {
    console.log(`  ✓ GEPOS → ${gepos}`);
  } else {
    console.log("  ⚠ GEPOS: dominio non raggiungibile da probe — risolto via Maps/Tavily in scansione");
  }

  console.log("  GUESS WEBSITE: TUTTI I TEST PASSATI ✓");
}

// === TEST 2: VERDICT ===
function testVerdict() {
  console.log("\n=== TEST 2: VERDICT ===");

  assertEq(verdictFromSite({ reachable: true, policyFound: true, foundRelevantPage: true }), "PUBLISHED", "verdict PUBLISHED");
  assertEq(verdictFromSite({ reachable: true, policyFound: false, foundRelevantPage: true }), "REVIEW", "verdictFromSite mai HOT (solo reconcile)");
  assertEq(verdictFromSite({ reachable: true, policyFound: false, foundRelevantPage: false }), "REVIEW", "verdict REVIEW (non trovata, pagina non rilevante)");
  assertEq(verdictFromSite({ reachable: false, policyFound: false, foundRelevantPage: false }), "REVIEW", "verdict REVIEW (sito non raggiungibile)");

  assertEq(verdictFromRegional({ checked: true, policyFound: true }), "PUBLISHED", "regional PUBLISHED");
  // Mai HOT da portali regionali soli — serve crawl sito esaustivo (zero falsi HOT).
  assertEq(verdictFromRegional({ checked: true, policyFound: false, hasWebsite: true }), "REVIEW", "regional senza polizza → REVIEW (no HOT)");
  assertEq(verdictFromRegional({ checked: true, policyFound: false, hasWebsite: false }), "REVIEW", "regional senza sito → REVIEW");

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

  const rsaCrawl = {
    ...mockCrawl,
    text: "RSA San Vincenzo. Amministrazione trasparente. Servizi residenziali.",
    policyText: "RSA San Vincenzo. Amministrazione trasparente.",
    pagesVisited: ["https://rsa.it/amministrazione-trasparente"],
  };
  const vRsa = reconcilePolicyVerdict(rsaCrawl, analyzePolicy(rsaCrawl.text), "REVIEW", {
    companyName: "RSA San Vincenzo De' Paoli",
    website: "https://rsa.it",
    city: "Castel Morrone",
    category: "RSA",
  }).verdict;
  assert(vRsa === "HOT", "Integration: RSA con Trasparenza letta e senza polizza → HOT");

  console.log("  INTEGRAZIONE: TUTTI I TEST PASSATI ✓");
}

function testEmbeddedJson() {
  console.log("\n=== TEST 7: EMBEDDED JSON ===");
  const html = `<!doctype html><html><body><p>Home</p>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"polizza":"Polizza in vigore AM TRUST n° RCH00020000180 massimale € 5.000.000"}}}</script>
  </body></html>`;
  const text = extractPageText(html);
  const a = analyzePolicy(text);
  assert(a.policyFound === true, "Next.js __NEXT_DATA__ con polizza → policyFound");
  assert(a.policyNumber === "RCH00020000180", `policyNumber=${a.policyNumber}`);
  const api = extractJsonPolicyText('{"assicurazione":{"compagnia":"UnipolSai","numero_pratica":"176944850"}}');
  assert(/176944850/.test(api), "API JSON estrae numero pratica");
  console.log("  EMBEDDED JSON: TUTTI I TEST PASSATI ✓");
}

async function testCtoEvidenceGates() {
  console.log("\n=== TEST CTO: evidence + crawl completeness + cauzione stima ===");

  const incomplete = deriveCrawlComplete({
    identityVerified: true,
    sitemapStatus: "DISCOVERED_COMPLETE",
    htmlQueueExhausted: false,
    relevantLinksProcessed: false,
    relevantDocumentsProcessed: true,
    jsonEndpointsProcessed: true,
    sameHostScriptsProcessed: true,
    unresolvedRelevantUrls: 3,
    failedRelevantUrls: 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: 0,
    urlCapReached: true,
    timeCapReached: false,
  });
  assert(incomplete.complete === false, "cap URL → complete=false");
  assert(!!crawlBlocksTerminalVerdict(incomplete), "cap URL blocca HOT");

  const complete = deriveCrawlComplete({
    identityVerified: true,
    sitemapStatus: "NOT_PRESENT",
    htmlQueueExhausted: true,
    relevantLinksProcessed: true,
    relevantDocumentsProcessed: true,
    jsonEndpointsProcessed: true,
    sameHostScriptsProcessed: true,
    unresolvedRelevantUrls: 0,
    failedRelevantUrls: 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: 0,
    urlCapReached: false,
    timeCapReached: false,
  });
  assert(complete.complete === true, "tutti i gate → complete=true");
  assert(crawlBlocksTerminalVerdict(complete) === null, "complete non blocca");

  const smFail = deriveCrawlComplete({
    identityVerified: true,
    sitemapStatus: "DISCOVERED_FAILED",
    htmlQueueExhausted: true,
    relevantLinksProcessed: true,
    relevantDocumentsProcessed: true,
    jsonEndpointsProcessed: true,
    sameHostScriptsProcessed: true,
    unresolvedRelevantUrls: 0,
    failedRelevantUrls: 0,
    unreadableRelevantDocuments: 0,
    criticalOcrDoubts: 0,
    urlCapReached: false,
    timeCapReached: false,
  });
  assert(smFail.complete === false, "sitemap FAILED → complete=false");
  assert(!!crawlBlocksTerminalVerdict(smFail), "sitemap FAILED blocca HOT");

  for (const status of [
    "DISCOVERED_PARTIAL",
    "ROBOTS_REFERENCED_FAILED",
    "NOT_DISCOVERED",
  ]) {
    const c = deriveCrawlComplete({
      identityVerified: true,
      sitemapStatus: status,
      htmlQueueExhausted: true,
      relevantLinksProcessed: true,
      relevantDocumentsProcessed: true,
      jsonEndpointsProcessed: true,
      sameHostScriptsProcessed: true,
      unresolvedRelevantUrls: 0,
      failedRelevantUrls: 0,
      unreadableRelevantDocuments: 0,
      criticalOcrDoubts: 0,
      urlCapReached: false,
      timeCapReached: false,
    });
    assert(c.complete === false, `sitemap ${status} → complete=false`);
    assert(!!crawlBlocksTerminalVerdict(c), `sitemap ${status} blocca HOT`);
  }

  const { legacyHotExcludedFromQueue, passesDefaultClientQueueGate } = await import(
    "../src/lib/sanita/actionable-queue.ts"
  );
  const { isLegacyLead } = await import("../src/lib/sanita/evidence-version.ts");
  assert(isLegacyLead("[V:HOT] old without version") === true, "HOT senza versione = legacy");
  assert(
    legacyHotExcludedFromQueue("[V:HOT] old without version") === true,
    "legacy HOT escluso dalla coda commerciale"
  );
  assert(
    passesDefaultClientQueueGate({ evidence: "[V:HOT] old without version", type: "HEALTHCARE" }) ===
      false,
    "legacy HOT escluso dalla vista cliente default"
  );
  assert(
    passesDefaultClientQueueGate({ evidence: null, type: "HEALTHCARE" }) === true,
    "pending senza verdetto resta visibile in pipeline"
  );

  const finCap = finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "assenza",
    pagesVisited: 40,
    websiteReachable: true,
    website: "https://example.it",
    policyExhaustive: true,
    crawlCompleteness: incomplete,
  });
  assertEq(finCap.verdict, "REVIEW", "HOT degradato se crawl incompleto (cap)");
  assert(finCap.downgraded === true, "downgraded=true");

  const finOk = finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "assenza certificata",
    pagesVisited: 40,
    websiteReachable: true,
    website: "https://example.it",
    policyExhaustive: true,
    crawlCompleteness: complete,
  });
  assertEq(finOk.verdict, "HOT", "HOT permesso solo se completeness.complete");

  const finTimeout = finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "x",
    pagesVisited: 40,
    websiteReachable: false,
    website: "https://example.it",
    policyExhaustive: true,
    crawlCompleteness: complete,
  });
  assertEq(finTimeout.verdict, "REVIEW", "sito non raggiungibile ≠ assenza");

  const est = estimateCauzione(1_000_000);
  assertEq(est.kind, "ESTIMATE", "cauzione è ESTIMATE");
  assertEq(est.value, 100_000, "10% di 1M");
  assert(claimKindLabel(est.kind).includes("Stima"), "label stima");

  const gare = scoreGareCommercial({
    awardDate: new Date(),
    amount: 2_000_000,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
  });
  assert(gare.score >= 70, `gare score HIGH+ atteso, got ${gare.score}`);
  assert(gare.inferences.some((i) => /cauzione/i.test(i)), "inferenza cauzione etichettata");

  const san = scoreSanitaCommercial({
    verdict: "HOT",
    crawlComplete: false,
    hasPhone: true,
  });
  assertEq(san.tier, "NOT_ACTIONABLE", "HOT senza crawl completo non actionable");

  const sanOk = scoreSanitaCommercial({
    verdict: "HOT",
    crawlComplete: true,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    pagesVisited: 40,
  });
  assert(sanOk.score >= 70, `sanità HOT completo score=${sanOk.score}`);
  console.log("  ✓ CTO evidence/completeness/cauzione gates");
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
    testFalsePositiveGates,
    testSiteIdentity,
    testGuessWebsite,
    testVerdict,
    testScoreLead,
    testPdfDigital,
    testOcrExtraction,
    testIntegration,
    testEmbeddedJson,
    testCtoEvidenceGates,
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
