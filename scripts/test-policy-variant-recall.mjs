import assert from "node:assert/strict";
import { detectPolicyCandidate } from "../src/lib/sanita/detector.ts";

const policyVariants = [
  "Estremi copertura RCT/RCO: Assicuratore Lloyd's, certificato n. ABC/2025/001.",
  "Impresa di assicurazione: Reale Mutua. Contratto RC sanitaria 2024-9981.",
  "La responsabilità civile verso terzi è garantita dalla polizza AXA 123456789.",
  "Copertura per responsabilità sanitaria – numero 450289527 – Generali.",
  "Assicurazione della responsabilità civile della struttura AmTrust RCH00020000239.",
  "POLIZZA N° RCHOOO2OOO239 AMTRUST Ospedali Privati RESPONSABILITA CIVILE.",
  "Compagnia assicuratrice: UnipolSai. RCT/O n. 1/139602/65/184419847/1.",
  "Quietanza assicurativa della struttura sanitaria, polizza 747217409, Generali.",
];

let pass = 0;
for (const [index, text] of policyVariants.entries()) {
  const detection = detectPolicyCandidate(
    text,
    `https://clinic.example/amministrazione-trasparente/polizza-${index + 1}`
  );
  assert.ok(
    detection.policy.policyFound || detection.candidate,
    `variant ${index + 1} must publish or block HOT: ${JSON.stringify(detection)}`
  );
  pass++;
}

const nonPolicyVariants = [
  "Se hai una polizza sanitaria puoi ottenere tariffe agevolate per le prestazioni.",
  "La Legge Gelli impone alle strutture sanitarie di pubblicare la polizza assicurativa.",
  "Informativa privacy: i dati potranno essere comunicati a compagnie assicurative.",
];
for (const [index, text] of nonPolicyVariants.entries()) {
  const detection = detectPolicyCandidate(
    text,
    `https://clinic.example/informazioni-${index + 1}`
  );
  assert.equal(
    detection.policy.policyFound,
    false,
    `non-policy ${index + 1} must not publish`
  );
  assert.equal(
    detection.candidate,
    false,
    `non-policy ${index + 1} must not create a false unresolved policy`
  );
  pass++;
}

console.log(
  JSON.stringify({
    suite: "policy-variant-recall",
    pass,
    fail: 0,
    exitCode: 0,
  })
);
