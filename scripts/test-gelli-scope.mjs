import { isGelliSubjectStructure, classifyGelliScope } from "../src/lib/sanita/gelli-scope.ts";

const mustPass = [
  ["Casa di Cura Privata Villa dei Fiori", "Casa di cura"],
  ["Malzoni Radio Surgery", "Centro di radioterapia"],
  ["Istituto Polidiagnostico S.Chiara", null],
  ["Medicina Futura Analisi Cliniche", null],
  ["Fondazione Oasi Sant'Antonio", "Casa di riposo"],
  ["Casa del Buon Samaritano", "Casa di riposo"],
  ["RSA Villa Serena", "Residenza per anziani"],
  ["Clinica Villa Bianca", "Clinica"],
  ["Day Hospital Salerno", null],
];

const mustFail = [
  ["Studio Medico Dott. Rossi", "Medico"],
  ["Studio Dentistico Bianchi", "Dentista"],
  ["Farmacia Comunale", "Farmacia"],
  ["LILT - Sezione di Avellino", "Associazione"],
  ["Agenzia Immobiliare Tecnocasa", "Agenzia immobiliare"],
  ["Hotel San Francesco Resort", "Hotel"],
  ["Clinica Veterinaria Partenope", "Veterinario"],
  ["Dott.ssa Verdi Psicologa", "Psicologo"],
  ["Consultorio Familiare ASL", null],
  ["Terme di Telese", "Terme"],
  ["Distretto Sanitario 52", null],
];

let fail = 0;
for (const [name, cat] of mustPass) {
  const ok = isGelliSubjectStructure(name, cat);
  if (!ok) {
    fail++;
    console.log(`✗ FAIL pass: ${name} — ${classifyGelliScope(name, cat).reason}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
for (const [name, cat] of mustFail) {
  const ok = isGelliSubjectStructure(name, cat);
  if (ok) {
    fail++;
    console.log(`✗ FAIL block: ${name} — doveva essere escluso`);
  } else {
    console.log(`✓ escluso: ${name} (${classifyGelliScope(name, cat).reason})`);
  }
}
console.log(fail === 0 ? "\nTUTTI PASSATI" : `\n${fail} FALLITI`);
process.exit(fail === 0 ? 0 : 1);
