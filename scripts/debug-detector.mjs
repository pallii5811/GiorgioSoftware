import { analyzePolicy } from "../src/lib/sanita/detector.ts";

const text = `Polizza RC Professionale
Compagnia: Zurich
Scadenza: 31/12/2024
Massimale: 5.000.000 EUR`;

const r = analyzePolicy(text);
console.log("policyFound:", r.policyFound);
console.log("company:", r.company);
console.log("massimale:", r.massimale);
console.log("expiry:", r.expiry);
console.log("policyNumber:", r.policyNumber);
console.log("confidence:", r.confidence);
console.log("evidence:", r.evidence?.substring(0, 100));
