/**
 * Test unitari puri per src/lib/sanita/archive-results-map.ts (nessun I/O).
 * Esegui: npx tsx scripts/test-archive-results-mapping.mjs
 */
import {
  applyFilters,
  evidenceUrlsFromText,
  inRunScope,
  mapCheckpointOnly,
  mapResultRow,
  publishedSubtypeOf,
  sortResults,
  unresolvedFromEvidence,
} from "../src/lib/sanita/archive-results-map.ts";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// 1. result row PUBLISHED_CURRENT completo
const pubRow = {
  id: "abc123",
  companyName: "Casa di Cura Esempio",
  city: "Napoli",
  region: "Campania",
  processingState: "PUBLISHED_CURRENT",
  businessVerdict: "PUBLISHED_CURRENT",
  policyCompany: "Generali",
  policyNumber: "123/45",
  policyExpiry: "2027-01-01",
  policyFound: true,
  contentHash: "a".repeat(64),
  crawlComplete: true,
  finishedAt: "2026-07-22T10:00:00Z",
  fullEvidence:
    "[V:PUB] polizza certificata. [FRONTIER:CLOSED,p=0,f=0,pdf=3,ocr=1,n=9] fonte polizza PDF: https://esempio.it/polizza.pdf altro testo",
};
const m1 = mapResultRow(pubRow);
check("pub: publishedSubtype policy_valid", m1.publishedSubtype === "policy_valid");
check("pub: pdfHash 64hex", m1.pdfHash === "a".repeat(64));
check("pub: unresolved 0 da FRONTIER:CLOSED", m1.unresolvedRelevantNodes === 0);
check("pub: frontierComplete true", m1.frontierComplete === true);
check(
  "pub: evidenceUrls contiene fonte PDF",
  m1.evidenceUrls.includes("https://esempio.it/polizza.pdf"),
  JSON.stringify(m1.evidenceUrls)
);
check("pub: appliedLive sempre false", m1.appliedLive === false);

// 2. marker FRONTIER:OPEN p=34 f=2 → 36
check(
  "frontier open: p+f sommati",
  unresolvedFromEvidence("[FRONTIER:OPEN,p=34,f=2,pdf=19,ocr=0,n=41]") === 36
);

// 3. evidence senza marker → null
check("frontier assente → null", unresolvedFromEvidence("testo qualsiasi") === null);
check("frontier evidence vuota → null", unresolvedFromEvidence("") === null);

// 4. HOT e RETRY → subtype null
check("HOT → subtype null", publishedSubtypeOf("HOT_VERIFIED") === null);
check("RETRY → subtype null", publishedSubtypeOf("RETRY_PENDING") === null);
check("EXPIRED → policy_expired", publishedSubtypeOf("PUBLISHED_EXPIRED") === "policy_expired");
check("DATE_UNKNOWN → date_unknown", publishedSubtypeOf("PUBLISHED_DATE_UNKNOWN") === "date_unknown");

// 5. scope=run
check("inRunScope: prima escluso", !inRunScope("2026-07-20T10:00:00Z", "2026-07-22T00:00:00Z"));
check("inRunScope: uguale incluso", inRunScope("2026-07-22T00:00:00Z", "2026-07-22T00:00:00Z"));
check("inRunScope: dopo incluso", inRunScope("2026-07-22T08:00:00Z", "2026-07-22T00:00:00Z"));
check("inRunScope: runStartedAt null → incluso", inRunScope("2026-07-20T00:00:00Z", null));
check("inRunScope: completedAt null con run attivo → escluso", !inRunScope(null, "2026-07-22T00:00:00Z"));

// 6. filtro q case-insensitive su companyName e city
const rows = [
  mapResultRow({ ...pubRow, id: "1", companyName: "Villa Alfa", city: "Napoli" }),
  mapResultRow({ ...pubRow, id: "2", companyName: "Casa Beta", city: "Salerno" }),
];
check("q su companyName", applyFilters(rows, { q: "villa" }).length === 1);
check("q su city case-insensitive", applyFilters(rows, { q: "SALERNO" })[0]?.leadId === "2");
check("region filter", applyFilters(rows, { region: "Veneto" }).length === 0);
check("outcome filter", applyFilters(rows, { outcome: "HOT_VERIFIED" }).length === 0);
check(
  "outcome PUBLISHED_CURRENT",
  applyFilters(rows, { outcome: "PUBLISHED_CURRENT" }).length === 2
);

// 7. riga da solo checkpoint (result file mancante)
const cpOnly = mapCheckpointOnly("xyz", {
  finishedAt: "2026-07-22T09:00:00Z",
  processingState: "REVIEW_HUMAN",
});
check("checkpoint-only: state", cpOnly.processingState === "REVIEW_HUMAN");
check("checkpoint-only: completedAt", cpOnly.completedAt === "2026-07-22T09:00:00Z");
check("checkpoint-only: companyName null", cpOnly.companyName === null);
check("checkpoint-only: no crash senza terminal/retry", mapCheckpointOnly("z").leadId === "z");

// 8. ordinamento completedAt desc, null in coda
const sorted = sortResults([
  mapResultRow({ ...pubRow, id: "old", finishedAt: "2026-07-20T00:00:00Z" }),
  mapResultRow({ ...pubRow, id: "none", finishedAt: null }),
  mapResultRow({ ...pubRow, id: "new", finishedAt: "2026-07-22T00:00:00Z" }),
]);
check(
  "sort: new, old, none",
  sorted.map((r) => r.leadId).join(",") === "new,old,none",
  sorted.map((r) => r.leadId).join(",")
);

// 9. pdfHash non 64hex → null
const badHash = mapResultRow({ ...pubRow, id: "h", contentHash: "not-a-sha" });
check("pdfHash invalido → null", badHash.pdfHash === null);

// 10. evidenceUrls dedup e pulizia trailing
const urls = evidenceUrlsFromText(
  "vedi https://a.it/x.pdf, e https://a.it/x.pdf. fonte polizza HTML: https://a.it/polizza"
);
check("urls dedup", urls.filter((u) => u === "https://a.it/x.pdf").length === 1, urls.join(","));
check("urls fonte html inclusa", urls.includes("https://a.it/polizza"));

console.log(fail === 0 ? `ALL ${pass} PASS` : `${fail} FAILURES (${pass} pass)`);
process.exit(fail === 0 ? 0 : 1);
