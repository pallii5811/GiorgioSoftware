/**
 * Test unitari logica merge dedup — nessun DB, nessun side effect.
 */
import assert from "node:assert/strict";
import {
  buildScanMergePayload,
  pickBestScannedLead,
  shouldMergeScanIntoKeeper,
} from "../src/lib/sanita/lead-dedup-merge.ts";
import { pickPolicyPdfUrl } from "../src/lib/sanita/audit.ts";
import { policyPdfUrlsForLead } from "../src/lib/sanita/audit.ts";

function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const base = {
  id: "a",
  region: "Campania",
  companyName: "Test RSA",
  city: "Napoli",
  website: "https://example.it",
  osmId: "gmaps/x",
  phone: null,
  piva: null,
  createdAt: new Date("2026-01-01"),
  leadScore: 0,
  pagesVisited: 0,
};

t("merge: donor scanned → keeper unscan", () => {
  const keeper = { ...base, id: "keep", lastScannedAt: null, evidence: null };
  const donor = {
    ...base,
    id: "donor",
    lastScannedAt: new Date("2026-06-18"),
    evidence: "[V:HOT] polizza assente",
    pagesVisited: 12,
  };
  assert.equal(shouldMergeScanIntoKeeper(keeper, donor), true);
});

t("merge: PUB donor beats HOT keeper", () => {
  const keeper = {
    ...base,
    id: "keep",
    lastScannedAt: new Date("2026-06-17"),
    evidence: "[V:HOT] x",
    pagesVisited: 5,
  };
  const donor = {
    ...base,
    id: "donor",
    lastScannedAt: new Date("2026-06-18"),
    evidence: "[V:PUB] polizza ok",
    pagesVisited: 8,
  };
  assert.equal(shouldMergeScanIntoKeeper(keeper, donor), true);
  const best = pickBestScannedLead([keeper, donor]);
  assert.equal(best?.id, "donor");
});

t("merge: keeper già migliore → no copy", () => {
  const keeper = {
    ...base,
    id: "keep",
    lastScannedAt: new Date("2026-06-18"),
    evidence: "[V:PUB] ok",
    pagesVisited: 20,
  };
  const donor = {
    ...base,
    id: "donor",
    lastScannedAt: new Date("2026-06-17"),
    evidence: "[V:HOT] x",
    pagesVisited: 3,
  };
  assert.equal(shouldMergeScanIntoKeeper(keeper, donor), false);
});

t("merge payload: contatti keeper preservati", () => {
  const merged = buildScanMergePayload(
    { ...base, phone: "081111", email: "a@pec.it" },
    {
      lastScannedAt: new Date(),
      policyFound: true,
      policyCompany: "Generali",
      policyMassimale: "EUR 1.000.000",
      policyNumber: "123",
      policyExpiry: null,
      confidence: 1,
      evidence: "[V:PUB] ok",
      websiteReachable: true,
      pagesVisited: 9,
      leadScore: 90,
      phone: "082222",
      email: "b@test.it",
      pec: null,
      website: "https://example.it",
    }
  );
  assert.equal(merged.phone, "081111");
  assert.equal(merged.email, "a@pec.it");
});

t("pickPolicyPdfUrl: no random first pdf", () => {
  const url = pickPolicyPdfUrl({
    policyPdfUrl: null,
    pagesVisited: ["https://site.it/modulo_socio.pdf", "https://site.it/chi-siamo"],
  });
  assert.equal(url, null);
});

t("pickPolicyPdfUrl: policy-named pdf", () => {
  const url = pickPolicyPdfUrl({
    policyPdfUrl: null,
    pagesVisited: ["https://site.it/modulo.pdf", "https://site.it/polizza-rc-2024.pdf"],
  });
  assert.ok(url?.includes("polizza"));
});

t("policyPdfUrlsForLead: HOT senza link", () => {
  const urls = policyPdfUrlsForLead("[V:HOT] x — [DOCS: https://site.it/modulo.pdf] [FONTI: x] [Verifica: x]");
  assert.deepEqual(urls, []);
});

t("policyPdfUrlsForLead: PUB con DOCS", () => {
  const urls = policyPdfUrlsForLead("[V:PUB] ok — [DOCS: https://site.it/polizza.pdf] [FONTI: x] [Verifica: x]");
  assert.equal(urls[0], "https://site.it/polizza.pdf");
});

console.log("\nDedup/audit unit tests: OK\n");
