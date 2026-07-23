#!/usr/bin/env node
/**
 * Gate estrazione scheda polizza (tabella + Scade-alle-ore-24).
 * Quietanza NON deve diventare expiry.
 */
import assert from "node:assert/strict";
import { extractSchedaPolizzaFields } from "../src/lib/sanita/policy-scheda-extract.ts";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import {
  SCHEDA_POLIZZA_FIXTURE_ANON,
  SCHEDA_POLIZZA_FIXTURE_SCADE24,
} from "../src/lib/sanita/fixtures/scheda-polizza-anon.ts";

function ymd(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function checkFixture(label, text) {
  const s = extractSchedaPolizzaFields(text);
  const a = analyzePolicy(text);
  console.log(label, {
    number: s.policyNumber,
    expiry: ymd(s.expiry),
    nextPayment: ymd(s.nextPayment),
    analyzeExpiry: ymd(a.expiry),
    analyzeNumber: a.policyNumber,
    company: a.company,
  });
  assert.equal(s.policyNumber, "RCI00010002744", `${label}: number`);
  assert.equal(ymd(s.expiry), "2025-12-31", `${label}: expiry`);
  assert.equal(ymd(s.nextPayment), "2025-06-30", `${label}: quietanza`);
  assert.notEqual(ymd(s.expiry), ymd(s.nextPayment), `${label}: quietanza≠expiry`);
  assert.equal(ymd(a.expiry), "2025-12-31", `${label}: analyzePolicy expiry`);
  assert.equal(a.policyNumber, "RCI00010002744", `${label}: analyzePolicy number`);
  // As of 2026-07-23 → expired
  const today = Date.UTC(2026, 6, 23);
  assert.ok(a.expiry && a.expiry.getTime() < today, `${label}: expired vs 2026-07-23`);
}

checkFixture("table-anon", SCHEDA_POLIZZA_FIXTURE_ANON);
checkFixture("scade24-anon", SCHEDA_POLIZZA_FIXTURE_SCADE24);

console.log(
  JSON.stringify({
    suite: "scheda-polizza-extract",
    exitCode: 0,
    pass: 2,
    gate: {
      expiry: "2025-12-31",
      number: "RCI00010002744",
      stateExpected: "PUBLISHED_EXPIRED",
      neverDateUnknown: true,
      neverQuietanzaAsExpiry: true,
    },
  })
);
