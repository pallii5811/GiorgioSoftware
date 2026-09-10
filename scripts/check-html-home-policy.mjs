#!/usr/bin/env node
/**
 * Self-check: HTML home/footer policy must set policyFound (no false HOT).
 * Run: node --import tsx scripts/check-html-home-policy.mjs
 */
import assert from "node:assert/strict";
import { analyzePolicy } from "../src/lib/sanita/detector.ts";
import { reconcilePolicyVerdict } from "../src/lib/sanita/policy-verify.ts";

const iatreion =
  "Polizza n. 747217409 Polizza di Assicurazione di Responsabilità civile verso terzi Descrizione Condizioni generali";
const galdiero =
  "Copertura assicurativa della responsabilità civile verso terzi e verso i prestatori d opera di Reale Mutua • Polizza 2022/03/2475660";

const a1 = analyzePolicy(iatreion, "http://www.iatreion.net/");
assert.equal(a1.policyFound, true, "IATREION must policyFound");
assert.equal(a1.policyNumber, "747217409");

const a2 = analyzePolicy(galdiero, "http://www.galdiero.it/");
assert.equal(a2.policyFound, true, "Galdiero must policyFound");
assert.equal(a2.policyNumber, "2022/03/2475660");
assert.equal(a2.company, "Reale Mutua");

const crawl = {
  ok: true,
  text: iatreion,
  policyText: iatreion,
  pagesVisited: ["http://www.iatreion.net/", "http://www.iatreion.net/polizza-responsabilita--civile.html"],
  foundRelevantPage: true,
  policyPdfUrl: null,
  policyPdfsRead: 0,
  policyPdfAnalysis: null,
};
const rec = reconcilePolicyVerdict(crawl, a1, "HOT", { website: "http://www.iatreion.net/" });
assert.equal(rec.verdict, "PUBLISHED", `IATREION reconcile must PUBLISHED, got ${rec.verdict}`);
assert.notEqual(rec.verdict, "HOT");

console.log("OK html-home-policy self-check");
