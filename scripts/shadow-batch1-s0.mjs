#!/usr/bin/env node
/**
 * S0 — deterministic Sanità preflight (no live network).
 * Uses real gates: analyzePolicy, finalizeVerdict, deriveCrawlComplete, identity, commercial.
 */
import fs from "node:fs";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { finalizeVerdict } from "../src/lib/sanita/finalize-verdict.ts";
import {
  deriveCrawlComplete,
  crawlBlocksTerminalVerdict,
} from "../src/lib/evidence/contract.ts";
import {
  buildIdentityEvidence,
  deriveIdentityVerified,
  identityBlocksTerminalVerdict,
} from "../src/lib/sanita/identity-evidence.ts";
import { scoreSanitaCommercial } from "../src/lib/sanita/commercial.ts";

const cases = [];
let pass = 0;
let fail = 0;
let falseHot = 0;
let falsePub = 0;
let identityContamination = 0;
let techToHot = 0;
let techToPub = 0;

function completeCrawl(over = {}) {
  return deriveCrawlComplete({
    identityVerified: true,
    sitemapStatus: "DISCOVERED_COMPLETE",
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
    ...over,
  });
}

function finHot(over = {}) {
  return finalizeVerdict({
    verdict: "HOT",
    evidenceBody: "test",
    pagesVisited: 20,
    websiteReachable: true,
    website: "https://example-clinic.it",
    policyExhaustive: true,
    crawlCompleteness: completeCrawl(),
    ...over,
  });
}

function check(id, input, expected, got, extra = {}) {
  const ok = got === expected;
  const row = { id, input, expected, got, ok, ...extra };
  cases.push(row);
  if (ok) {
    pass++;
    console.log(`PASS ${id}`);
  } else {
    fail++;
    console.error(`FAIL ${id}: expected=${expected} got=${got}`);
  }
  if (extra.falseHot) falseHot++;
  if (extra.falsePub) falsePub++;
  if (extra.identityContamination) identityContamination++;
  if (extra.techToHot) techToHot++;
  if (extra.techToPub) techToPub++;
}

// 1 current policy
{
  const r = analyzePolicy(`Polizza RC sanitaria UnipolSai n. RC-2024-001234 massimale € 5.000.000,00 scadenza 31/12/2027`);
  check("S0-01", "polizza corrente", true, r.policyFound === true && r.policyObsolete === false, {
    evidence: String(r.evidence || "").slice(0, 100),
  });
}
// 2 expired
{
  const r = analyzePolicy(`
    Polizza RC Professionale
    Compagnia: Generali
    Scadenza: 24/05/2016
    Massimale: € 2.000.000
  `);
  check("S0-02", "polizza scaduta", true, r.policyFound === true && r.policyObsolete === true);
}
// 3 other entity — identity mismatch blocks PUB
{
  const id = buildIdentityEvidence({
    status: "MISMATCH",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: [],
    conflicts: ["Polizza intestata a altra struttura"],
  });
  const block = identityBlocksTerminalVerdict(id);
  check("S0-03", "polizza altra struttura", true, Boolean(block), {
    identityStatus: id.status,
    identityContamination: !block,
  });
}
// 4 company without contract
{
  const r = analyzePolicy(`In Trasparenza Gelli art.2-4 la compagnia UnipolSai è citata senza estremi polizza`);
  check("S0-04", "compagnia senza contratto", false, r.policyFound);
}
// 5 Gelli citation only
{
  const r = analyzePolicy(`In ottemperanza alla Legge 24/2017 (Gelli-Bianco)`);
  check("S0-05", "solo citazione Gelli", false, r.policyFound);
}
// 6 valid autoinsurance
{
  const r = analyzePolicy(
    `La struttura adotta la forma di autoassicurazione / gestione diretta del rischio Art. 10 Legge Gelli-Bianco 24/2017`
  );
  check("S0-06", "autoassicurazione valida", true, r.policyFound);
}
// 7 generic autoinsurance — HTML keyword alone should not stay HOT without exhaustive
{
  const f = finHot({ policyExhaustive: false, pagesVisited: 3 });
  check("S0-07", "autoassicurazione generica / crawl corto", "REVIEW", f.verdict, {
    falseHot: f.verdict === "HOT",
  });
}
// 8 PARM without insurance contract (fondo rischi accounting)
{
  const r = analyzePolicy(`PIANO ANNUALE RISK MANAGEMENT PARM 2026 Legge Gelli. Nessuna polizza RC sottoscritta.`);
  check("S0-08", "PARM senza contratto", false, r.policyFound);
}
// 9 PARS without contract
{
  const r = analyzePolicy(`PARS 2025 — programma assicurativo non ancora sottoscritto`);
  check("S0-09", "PARS senza contratto", false, r.policyFound);
}
// 10 readable PDF path — complete crawl may allow HOT
{
  const f = finHot();
  check("S0-10", "PDF leggibile + crawl completo", "HOT", f.verdict);
}
// 11 OCR doubt
{
  const c = completeCrawl({ criticalOcrDoubts: 1 });
  const f = finHot({ crawlCompleteness: c, needsOcrReview: true });
  check("S0-11", "OCR dubbio", "REVIEW", f.verdict, { falseHot: f.verdict === "HOT", completeness: c.complete });
}
// 12 corrupt / unreadable docs
{
  const c = completeCrawl({ unreadableRelevantDocuments: 1, relevantDocumentsProcessed: false });
  const f = finHot({ crawlCompleteness: c });
  check("S0-12", "PDF corrotto/illeggibile", "REVIEW", f.verdict, {
    falseHot: f.verdict === "HOT",
    techToHot: f.verdict === "HOT",
  });
}
// 13 unreachable
{
  const f = finHot({ websiteReachable: false });
  check("S0-13", "sito irraggiungibile", "REVIEW", f.verdict, { techToHot: f.verdict === "HOT" });
}
// 14-16 HTTP failures via failedRelevantUrls / incomplete
for (const [id, label, over] of [
  ["S0-14", "HTTP 403", { failedRelevantUrls: 3, relevantLinksProcessed: false }],
  ["S0-15", "HTTP 429", { failedRelevantUrls: 2, relevantDocumentsProcessed: false }],
  ["S0-16", "timeout", { timeCapReached: true }],
]) {
  const c = completeCrawl(over);
  const f = finHot({ crawlCompleteness: c });
  check(id, label, "REVIEW", f.verdict, { techToHot: f.verdict === "HOT" });
}
// 17 sitemap complete
{
  const c = completeCrawl({ sitemapStatus: "DISCOVERED_COMPLETE" });
  check("S0-17", "sitemap completa", true, c.complete === true);
}
// 18 sitemap partial
{
  const c = completeCrawl({ sitemapStatus: "DISCOVERED_PARTIAL", unresolvedRelevantUrls: 2 });
  const f = finHot({ crawlCompleteness: c });
  check("S0-18", "sitemap parziale", "REVIEW", f.verdict, { falseHot: f.verdict === "HOT" });
}
// 19 sitemap failed
{
  const c = completeCrawl({ sitemapStatus: "DISCOVERED_FAILED" });
  const f = finHot({ crawlCompleteness: c });
  check("S0-19", "sitemap fallita", "REVIEW", f.verdict, { falseHot: f.verdict === "HOT" });
}
// 20 no sitemap but HTML exhausted
{
  const c = completeCrawl({ sitemapStatus: "NOT_PRESENT" });
  check("S0-20", "no sitemap HTML esaurita", true, c.complete === true);
}
// 21 official domain
{
  const id = buildIdentityEvidence({
    status: "OFFICIAL_CONFIRMED",
    matchedLegalName: true,
    matchedFacilityName: true,
    matchedAddress: true,
    matchedMunicipality: true,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: true,
    matchedGroupRelationship: false,
    sourceUrls: ["https://clinic.it"],
    reasons: ["dominio ufficiale"],
    conflicts: [],
  });
  check("S0-21", "dominio ufficiale", true, deriveIdentityVerified(id.status));
}
// 22 group with seat
{
  const id = buildIdentityEvidence({
    status: "GROUP_OFFICIAL_CONFIRMED",
    matchedLegalName: true,
    matchedFacilityName: true,
    matchedAddress: true,
    matchedMunicipality: true,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: true,
    sourceUrls: ["https://group.it/sede-napoli"],
    reasons: ["gruppo + sede"],
    conflicts: [],
  });
  check("S0-22", "gruppo con prova sede", true, id.verified);
}
// 23 group without seat proof
{
  const id = buildIdentityEvidence({
    status: "PROBABLE",
    matchedLegalName: true,
    matchedFacilityName: true,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: true,
    sourceUrls: ["https://group.it"],
    reasons: ["gruppo senza sede"],
    conflicts: [],
  });
  const block = identityBlocksTerminalVerdict(id);
  const crawl = completeCrawl({ identityVerified: false });
  const f = finHot({ crawlCompleteness: crawl });
  check("S0-23", "gruppo senza prova sede", "REVIEW", f.verdict, {
    falseHot: f.verdict === "HOT",
    identityStatus: id.status,
    reason: block,
  });
}
// 24 wrong homonym
{
  const id = buildIdentityEvidence({
    status: "MISMATCH",
    matchedLegalName: false,
    matchedFacilityName: false,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: [],
    conflicts: ["omonimo errato"],
  });
  check("S0-24", "sito omonimo errato", true, Boolean(identityBlocksTerminalVerdict(id)), {
    identityContamination: !identityBlocksTerminalVerdict(id),
  });
}
// 25 stale panel
{
  const id = buildIdentityEvidence({
    status: "STALE_PANEL",
    matchedLegalName: true,
    matchedFacilityName: true,
    matchedAddress: false,
    matchedMunicipality: false,
    matchedPhone: false,
    matchedTaxIdentifier: false,
    matchedOfficialRegistry: false,
    matchedGroupRelationship: false,
    sourceUrls: [],
    reasons: ["pannello obsoleto"],
    conflicts: [],
  });
  check("S0-25", "pannello obsoleto", true, Boolean(identityBlocksTerminalVerdict(id)));
}
// 26 transparency without policy — HOT ok if complete
{
  const f = finHot({ evidenceBody: "Trasparenza ok, polizza assente" });
  check("S0-26", "Trasparenza senza polizza", "HOT", f.verdict);
}
// 27 transparency 404 → failed urls
{
  const c = completeCrawl({ failedRelevantUrls: 1, relevantLinksProcessed: false });
  const f = finHot({ crawlCompleteness: c });
  check("S0-27", "Trasparenza 404", "REVIEW", f.verdict, { techToHot: f.verdict === "HOT" });
}
// 28 JSON pending
{
  const c = completeCrawl({ jsonEndpointsProcessed: false });
  check("S0-28", "endpoint JSON pending", true, Boolean(crawlBlocksTerminalVerdict(c)));
  const f = finHot({ crawlCompleteness: c });
  if (f.verdict === "HOT") {
    falseHot++;
    fail++;
    pass--;
    cases[cases.length - 1].ok = false;
  }
}
// 29 JS content pending
{
  const c = completeCrawl({ sameHostScriptsProcessed: false });
  const f = finHot({ crawlCompleteness: c });
  check("S0-29", "contenuto JS pending", "REVIEW", f.verdict, { falseHot: f.verdict === "HOT" });
}
// 30 URL cap
{
  const c = completeCrawl({ urlCapReached: true, htmlQueueExhausted: false });
  const f = finHot({ crawlCompleteness: c });
  check("S0-30", "crawl interrotto da cap", "REVIEW", f.verdict, { falseHot: f.verdict === "HOT" });
}

// Ambiguous → REVIEW via commercial on REVIEW
{
  const s = scoreSanitaCommercial({ verdict: "HOT", crawlComplete: false });
  check("S0-extra-actionable", "HOT incompleto NOT_ACTIONABLE", "NOT_ACTIONABLE", s.tier);
}

const summary = {
  fixtureCount: cases.length,
  pass,
  fail,
  falseHot,
  falsePub,
  identityContamination,
  technicalFailureTerminals: techToHot + techToPub,
  techToHot,
  techToPub,
  exitCode: fail || falseHot || falsePub || identityContamination || techToHot || techToPub ? 1 : 0,
  cases,
};
fs.mkdirSync("docs/shadow/batch1", { recursive: true });
fs.writeFileSync("docs/shadow/batch1/s0-results.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, cases: undefined }, null, 2));
process.exit(summary.exitCode);
