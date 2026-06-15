import { isHealthcarePlace } from "../src/lib/sanita/playwright-maps.ts";

const cases = [
  // [nome, categoriaPanel, atteso]
  ["Casa di Cura Privata Villa dei Fiori", "Casa di cura", true],
  ["Malzoni Radio Surgery", "Centro di radioterapia", true],
  ["Istituto Polidiagnostico S.Chiara Della D.R.Ssa", null, true],
  ["Medicina Futura Analisi Cliniche", null, true],
  ["Dolce Risveglio - Casa alloggio per adulti sofferenti", null, true],
  ["Centro Medico Sant'Anna Medical", null, true],
  ["Santi Pietro E Paolo Centro Medico", null, true],
  ["Fondazione Oasi Sant'Antonio", "Casa di riposo", true],
  ["VILLA MARINA CUORE IMMACOLATO DI MARIA - Casa alloggio", null, true],
  ["Agenzia Immobiliare Tecnocasa Agropoli", "Agenzia immobiliare", false],
  ["Prestito Compass Salerno Agropoli Gruppo Mediobanca", "Società finanziaria", false],
  ["Agenzia kiron Agropoli", "Agenzia di prestiti", false],
  ["San Francesco Resort", "Hotel", false],
  ["Case Vacanze Il Giardino di Maria", null, false],
  ["SAPORI DI CASA HOME RESTAURANT AGROPOLI", "Ristorante", false],
  ["Residenza Trentova", "Residence", false],
  ["Casa del Buon Samaritano", "Casa di riposo", true],
  ["Affiliato Casaè Agropoli", "Agenzia immobiliare", false],
  ["Clinica Veterinaria Partenope", "Veterinario", false],
  ["Studio Medico Dott. Verdi", "Medico", false],
  ["Studio Dentistico Sorriso", "Dentista", false],
  ["Farmacia Centrale", "Farmacia", false],
];

let fail = 0;
for (const [name, cat, expected] of cases) {
  const got = isHealthcarePlace(name, cat);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name} [${cat ?? "-"}] → ${got} (atteso ${expected})`);
}
console.log(fail === 0 ? "\nTUTTI PASSATI" : `\n${fail} FALLITI`);
process.exit(fail === 0 ? 0 : 1);
