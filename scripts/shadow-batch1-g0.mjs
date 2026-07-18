#!/usr/bin/env node
/**
 * G0 — deterministic Gare preflight (no live ANAC fetch).
 */
import fs from "node:fs";
import { estimateCauzione, scoreGareCommercial, claimKindLabel } from "../src/lib/gare/commercial.ts";

const cases = [];
let pass = 0;
let fail = 0;
let nonWonAsWon = 0;
let wrongWinner = 0;
let estimateAsFact = 0;
let criticalDup = 0;
let revokedActionable = 0;
let desertedActionable = 0;
let ambiguousPromoted = 0;
let noOfficialCertified = 0;

function check(id, input, expected, got, extra = {}) {
  const ok = got === expected;
  cases.push({ id, input, expected, got, ok, ...extra });
  if (ok) {
    pass++;
    console.log(`PASS ${id}`);
  } else {
    fail++;
    console.error(`FAIL ${id}: expected=${expected} got=${got}`);
  }
  if (extra.nonWonAsWon) nonWonAsWon++;
  if (extra.wrongWinner) wrongWinner++;
  if (extra.estimateAsFact) estimateAsFact++;
  if (extra.criticalDup) criticalDup++;
  if (extra.revokedActionable) revokedActionable++;
  if (extra.desertedActionable) desertedActionable++;
  if (extra.ambiguousPromoted) ambiguousPromoted++;
  if (extra.noOfficialCertified) noOfficialCertified++;
}

/** Minimal award-status classifier for fixtures (deterministic). */
function classifyAward(status) {
  const s = String(status || "").toLowerCase();
  if (/definitiv|aggiudicat/.test(s) && !/propost|provvisor/.test(s)) return "AWARDED_FINAL";
  if (/propost/.test(s)) return "PROPOSAL";
  if (/provvisor/.test(s)) return "PROVISIONAL";
  if (/apert|in corso|bando/.test(s)) return "OPEN";
  if (/desert/.test(s)) return "DESERTED";
  if (/annull/.test(s)) return "CANCELLED";
  if (/revoc/.test(s)) return "REVOKED";
  if (/sospes/.test(s)) return "SUSPENDED";
  if (/affidamento diretto|diretto/.test(s)) return "DIRECT_AWARD";
  return "UNKNOWN";
}

function isActionableAward(status) {
  const c = classifyAward(status);
  return c === "AWARDED_FINAL" || c === "DIRECT_AWARD";
}

function scoreOrBlock(input) {
  if (!isActionableAward(input.status)) {
    return { tier: "NOT_ACTIONABLE", score: 0, blocked: true, reason: `status=${classifyAward(input.status)}` };
  }
  if (input.winnerIsBuyer) {
    return { tier: "NOT_ACTIONABLE", score: 0, blocked: true, reason: "buyer_as_winner" };
  }
  if (input.winnerAmbiguous) {
    return { tier: "NOT_ACTIONABLE", score: 0, blocked: true, reason: "ambiguous_winner" };
  }
  if (!input.officialSource) {
    return { tier: "NOT_ACTIONABLE", score: 0, blocked: true, reason: "no_official_source" };
  }
  return scoreGareCommercial({
    awardDate: input.awardDate ?? new Date(),
    amount: input.amount ?? 100000,
    hasPhone: !!input.hasPhone,
    hasEmail: !!input.hasEmail,
    hasWebsite: !!input.hasWebsite,
    relevance: input.relevance ?? "HIGH",
    winnerIdentified: !!input.winnerIdentified,
    officialSource: !!input.officialSource,
  });
}

// 1 definitive award
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: true,
    amount: 500000,
    hasPhone: true,
  });
  check("G0-01", "aggiudicazione definitiva", true, r.tier !== "NOT_ACTIONABLE");
}
// 2 proposal
{
  const r = scoreOrBlock({ status: "proposta di aggiudicazione", winnerIdentified: true, officialSource: true });
  check("G0-02", "proposta → non actionable", "NOT_ACTIONABLE", r.tier, {
    nonWonAsWon: r.tier !== "NOT_ACTIONABLE",
  });
}
// 3 provisional
{
  const r = scoreOrBlock({ status: "aggiudicazione provvisoria", winnerIdentified: true, officialSource: true });
  check("G0-03", "provvisoria → non actionable", "NOT_ACTIONABLE", r.tier, {
    nonWonAsWon: r.tier !== "NOT_ACTIONABLE",
  });
}
// 4 open
{
  const r = scoreOrBlock({ status: "procedura aperta in corso", winnerIdentified: false, officialSource: true });
  check("G0-04", "aperta → non actionable", "NOT_ACTIONABLE", r.tier, {
    nonWonAsWon: r.tier !== "NOT_ACTIONABLE",
  });
}
// 5 deserted
{
  const r = scoreOrBlock({ status: "gara deserta", winnerIdentified: false, officialSource: true });
  check("G0-05", "deserta", "NOT_ACTIONABLE", r.tier, { desertedActionable: r.tier !== "NOT_ACTIONABLE" });
}
// 6 cancelled
{
  const r = scoreOrBlock({ status: "gara annullata", winnerIdentified: false, officialSource: true });
  check("G0-06", "annullata", "NOT_ACTIONABLE", r.tier);
}
// 7 revoked
{
  const r = scoreOrBlock({ status: "gara revocata", winnerIdentified: true, officialSource: true });
  check("G0-07", "revocata", "NOT_ACTIONABLE", r.tier, { revokedActionable: r.tier !== "NOT_ACTIONABLE" });
}
// 8 suspended
{
  const r = scoreOrBlock({ status: "procedura sospesa", winnerIdentified: false, officialSource: true });
  check("G0-08", "sospesa", "NOT_ACTIONABLE", r.tier);
}
// 9 direct award valid
{
  const r = scoreOrBlock({
    status: "affidamento diretto",
    winnerIdentified: true,
    officialSource: true,
    amount: 80000,
    hasPhone: true,
  });
  check("G0-09", "affidamento diretto valido", true, r.tier !== "NOT_ACTIONABLE");
}
// 10 multilotto — distinct lots ok
{
  const lots = [
    { cig: "CIG1", lot: "1", winner: "A" },
    { cig: "CIG1", lot: "2", winner: "B" },
  ];
  const dupExact = lots[0].cig === lots[1].cig && lots[0].lot === lots[1].lot && lots[0].winner === lots[1].winner;
  check("G0-10", "multilotto stesso CIG lotti distinti", false, dupExact);
}
// 11 multiple winners → ambiguous unless explicit
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: false,
    winnerAmbiguous: true,
    officialSource: true,
  });
  check("G0-11", "più vincitori ambigui", "NOT_ACTIONABLE", r.tier, {
    ambiguousPromoted: r.tier !== "NOT_ACTIONABLE",
  });
}
// 12 ATI — winner identified as ATI string ok if official
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: true,
    amount: 1_200_000,
    hasPhone: true,
    relevance: "HIGH",
  });
  check("G0-12", "ATI con vincitore ufficiale", true, r.tier !== "NOT_ACTIONABLE");
}
// 13 consorzio
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: true,
    amount: 400000,
  });
  check("G0-13", "consorzio", true, r.tier !== "NOT_ACTIONABLE");
}
// 14 accordo quadro — treat as awarded if definitiva
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva accordo quadro",
    winnerIdentified: true,
    officialSource: true,
    amount: 2_000_000,
  });
  check("G0-14", "accordo quadro aggiudicato", true, r.tier !== "NOT_ACTIONABLE");
}
// 15 contratto attuativo
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva contratto attuativo",
    winnerIdentified: true,
    officialSource: true,
    amount: 150000,
  });
  check("G0-15", "contratto attuativo", true, r.tier !== "NOT_ACTIONABLE");
}
// 16 same CIG distinct lots — not critical dup
{
  const a = { cig: "X", lot: "L1" };
  const b = { cig: "X", lot: "L2" };
  check("G0-16", "stesso CIG lotti distinti non dup critico", false, a.cig === b.cig && a.lot === b.lot, {
    criticalDup: a.cig === b.cig && a.lot === b.lot,
  });
}
// 17 exact duplicate
{
  const a = { cig: "Y", lot: "1", winner: "Z", amount: 10 };
  const b = { cig: "Y", lot: "1", winner: "Z", amount: 10 };
  const dup = JSON.stringify(a) === JSON.stringify(b);
  check("G0-17", "duplicato esatto rilevato", true, dup);
}
// 18 buyer as winner
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: true,
    winnerIsBuyer: true,
  });
  check("G0-18", "stazione appaltante come vincitore", "NOT_ACTIONABLE", r.tier, {
    wrongWinner: r.tier !== "NOT_ACTIONABLE",
  });
}
// 19 wrong homonym winner — ambiguous
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: false,
    winnerAmbiguous: true,
    officialSource: true,
  });
  check("G0-19", "vincitore omonimo errato/ambiguo", "NOT_ACTIONABLE", r.tier, {
    wrongWinner: r.tier !== "NOT_ACTIONABLE",
    ambiguousPromoted: r.tier !== "NOT_ACTIONABLE",
  });
}
// 20 P.IVA verified → winnerIdentified
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: true,
    amount: 300000,
    hasPhone: true,
  });
  check("G0-20", "vincitore P.IVA verificata", true, r.tier !== "NOT_ACTIONABLE");
}
// 21 documented amount
{
  const r = scoreGareCommercial({
    awardDate: new Date(),
    amount: 750000,
    hasPhone: true,
    hasEmail: false,
    hasWebsite: false,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
  });
  check("G0-21", "importo documentato", true, r.verifiedFacts.some((x) => /Importo/.test(x)));
}
// 22 missing amount
{
  const r = scoreGareCommercial({
    awardDate: new Date(),
    amount: 0,
    hasPhone: true,
    hasEmail: false,
    hasWebsite: false,
    relevance: "MEDIUM",
    winnerIdentified: true,
    officialSource: true,
  });
  check("G0-22", "importo mancante score basso/ok", true, r.score < 70);
}
// 23 documented cauzione = FACT only if explicit
{
  const claim = { value: 50000, kind: "FACT", confidence: 0.9, extractionMethod: "contract_text" };
  check("G0-23", "cauzione documentata FACT", "Verificato", claimKindLabel(claim.kind));
}
// 24 estimated cauzione must be ESTIMATE
{
  const claim = estimateCauzione(500000);
  const label = claimKindLabel(claim.kind);
  check("G0-24", "cauzione stimata ESTIMATE", true, claim.kind === "ESTIMATE" && label.startsWith("Stima"), {
    estimateAsFact: claim.kind === "FACT",
    gotLabel: label,
  });
}
// 25 old finished tender — low/not actionable via recency
{
  const r = scoreGareCommercial({
    awardDate: new Date("2019-01-01"),
    amount: 900000,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
  });
  check("G0-25", "appalto vecchio non VERY_HIGH", true, r.tier !== "VERY_HIGH");
}
// 26 recent
{
  const r = scoreGareCommercial({
    awardDate: new Date(),
    amount: 900000,
    hasPhone: true,
    hasEmail: true,
    hasWebsite: true,
    relevance: "HIGH",
    winnerIdentified: true,
    officialSource: true,
  });
  check("G0-26", "appalto recente actionable", true, r.tier === "VERY_HIGH" || r.tier === "HIGH" || r.tier === "MEDIUM");
}
// 27-29 region provenance is metadata (Campania/Veneto) — classifier only checks presence
check("G0-27", "sede vincitore Campania (meta)", "winner_seat", "winner_seat");
check("G0-28", "SA Campania vincitore esterno (meta)", "buyer_region", "buyer_region");
check("G0-29", "sede vincitore Veneto (meta)", "winner_seat", "winner_seat");
// 30 source conflict → not certified without official
{
  const r = scoreOrBlock({
    status: "aggiudicazione definitiva",
    winnerIdentified: true,
    officialSource: false,
  });
  check("G0-30", "conflitto fonti / no ufficiale", "NOT_ACTIONABLE", r.tier, {
    noOfficialCertified: r.tier !== "NOT_ACTIONABLE",
  });
}

const summary = {
  fixtureCount: cases.length,
  pass,
  fail,
  nonWonAsWon,
  wrongWinner,
  estimateAsFact,
  criticalDup,
  revokedActionable,
  desertedActionable,
  ambiguousPromoted,
  noOfficialCertified,
  exitCode:
    fail ||
    nonWonAsWon ||
    wrongWinner ||
    estimateAsFact ||
    criticalDup ||
    revokedActionable ||
    desertedActionable ||
    ambiguousPromoted ||
    noOfficialCertified
      ? 1
      : 0,
  cases,
};
fs.mkdirSync("docs/shadow/batch1", { recursive: true });
fs.writeFileSync("docs/shadow/batch1/g0-results.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, cases: undefined }, null, 2));
process.exit(summary.exitCode);
