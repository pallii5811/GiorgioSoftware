#!/usr/bin/env node
/**
 * Self-check identità sito: dominio first-party sanitario = identità confermata,
 * dominio estraneo (compagnia aerea, turismo) resta rifiutato.
 * Run: npx tsx scripts/check-identity-brand-host.mjs
 */
import assert from "node:assert/strict";
import { validateSiteIdentity } from "../src/lib/sanita/site-identity.ts";

const crawl = (text) => ({
  ok: true,
  text,
  policyText: "",
  pagesVisited: ["/", "/chi-siamo"],
  foundRelevantPage: false,
  policyPdfUrl: null,
  policyPdfsRead: 0,
  policyPdfsQueued: 0,
});

const HEALTH =
  "Poliambulatorio accreditato: visita medica specialistica, terapia fisica, assistenza ai pazienti, reparto prelievi.";
const AIRLINE =
  "Book flights, check-in online, SkyMiles program, baggage policy, flight status and travel deals.";

// 1) Sito giusto, nome non in chiaro nel testo → identità OK (prima era IDENTITY_MISMATCH)
const ok1 = validateSiteIdentity(
  "Poliambulatorio Veramed con punto prelievi",
  "https://www.veramed.it/",
  crawl(`${HEALTH} Sede a Verona.`),
  "Verona"
);
assert.equal(ok1.ok, true, `Veramed deve passare, invece: ${ok1.reason}`);

// 2) Città diversa sul sito multi-sede ma dominio+sanitario → OK
const ok2 = validateSiteIdentity(
  "Casa di Cura Villa Berica",
  "https://www.villaberica.it/",
  crawl(`${HEALTH} Sedi operative a Vicenza e Padova.`),
  "Vicenza"
);
assert.equal(ok2.ok, true, `Villa Berica deve passare, invece: ${ok2.reason}`);

// 3) Dominio estraneo (compagnia aerea) → deve restare RIFIUTATO
const bad1 = validateSiteIdentity(
  "Centro Delta S.R.L.",
  "https://www.delta.com/",
  crawl(AIRLINE),
  "Napoli"
);
assert.equal(bad1.ok, false, "delta.com NON deve passare come sito sanitario");

// 4) Dominio turistico senza contenuti sanitari → RIFIUTATO
const bad2 = validateSiteIdentity(
  "Casa Di Cura 'Trieste'",
  "https://www.trieste.com/",
  crawl("Hotel e soggiorno a Trieste: camere, colazione, prenotazioni turistiche."),
  "Trieste"
);
assert.equal(bad2.ok, false, "trieste.com NON deve passare");

// 3b) Brand-host + salute: comune Maps (Stra) ≠ Napoli sul sito → OK
// (prima bloccava; è rumore Maps/footer, non sito sbagliato)
const okCity = validateSiteIdentity(
  "Casa di Cura S. Patrizia",
  "https://www.casadicurasantapatrizia.it/",
  crawl(`${HEALTH} Casa di Cura Santa Patrizia, sede a Napoli.`),
  "Stra"
);
assert.equal(
  okCity.ok,
  true,
  `brand-host + salute non deve MISMATCH per comune Maps, invece: ${okCity.reason}`
);

// 3c) Senza brand-host: nome presente ma città palesemente altra → resta rifiuto
const badCity = validateSiteIdentity(
  "Poliambulatorio Rossi",
  "https://www.centromedicoesempio123.it/",
  crawl(`${HEALTH} Poliambulatorio Rossi, sede a Milano, pazienti e reparto.`),
  "Salerno"
);
assert.equal(
  badCity.ok,
  false,
  "senza brand-host, città Milano vs Salerno deve restare rifiuto"
);

// 5) Brand-host corretto + footer Roma ≠ comune Maps → OK (prima era IDENTITY_MISMATCH)
const ok3 = validateSiteIdentity(
  "Casa di Cura Tortorella Spa",
  "https://www.casadicuratortorella.it/",
  crawl(
    `${HEALTH} Casa di Cura Tortorella. Contatti sede legale Roma via Example. Pazienti e reparto.`
  ),
  "Valva"
);
assert.equal(ok3.ok, true, `Tortorella brand-host deve passare con footer Roma, invece: ${ok3.reason}`);

// 6) Brand-host + crawl corto senza salute → NON omonimia (retry), reason senza "errato"
const pending = validateSiteIdentity(
  "Camaldoli Hospital",
  "https://www.camaldolihospital.it/",
  crawl("Home"),
  "Crispano"
);
assert.equal(pending.ok, false, "crawl troppo corto non conferma ancora");
assert.equal(
  /omonimia|sito errato/i.test(pending.reason),
  false,
  `non deve sembrare MISMATCH Maps: ${pending.reason}`
);
assert.match(
  pending.reason,
  /brand-host in attesa/i,
  `atteso insufficiente brand-host, got: ${pending.reason}`
);

// 7) CAD INFISSI brand-host senza salute → resta rifiutato (non sanitario)
const bad4 = validateSiteIdentity(
  "CAD INFISSI",
  "https://cadinfissi.it/",
  {
    ...crawl(
      "Infissi e serramenti in PVC, porte finestre, preventivi, showroom, catalogo prodotti " +
        "e installazione professionale in tutta la provincia. Contatti e listino prezzi."
    ),
    pagesVisited: ["/", "/prodotti", "/contatti", "/chi-siamo", "/gallery", "/preventivo"],
  },
  "Casapesenna"
);
assert.equal(bad4.ok, false, "CAD INFISSI non sanitario deve restare rifiutato");

console.log("OK identity-brand-host self-check");
