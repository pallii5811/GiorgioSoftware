/**
 * RC-08b — insurance signal detection for PARM / auto-assicurazione.
 */
import { detectInsuranceSignals } from "../src/lib/sanita/can-emit-published.ts";
import assert from "node:assert/strict";

const parm = detectInsuranceSignals(
  "PARM 2025 — Piano annuale del rischio. Posizione assicurativa. Auto-assicurazione / gestione diretta del rischio."
);
assert.equal(parm.strong, true, "auto-assicurazione + posizione assicurativa → strong");
assert.ok(parm.mediumCount >= 1, "PARM counts as medium");

const thin = detectInsuranceSignals("homepage contatti chi siamo");
assert.equal(thin.strong, false);
assert.equal(thin.mediumCount, 0);

console.log(JSON.stringify({ ok: true, rc: "RC-08b", parm }));
