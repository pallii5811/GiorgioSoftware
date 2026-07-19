#!/usr/bin/env node
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { encodeEvidence, readVerdictToken, stripVerdictToken } from "../src/lib/sanita/verdict.ts";
import fs from "node:fs";

requireShadowIsolation();
const id = "cmqobynqm003taa3v0mx062fg";
const lead = await prisma.lead.findUnique({ where: { id } });
console.log("before", readVerdictToken(lead.evidence));
const body = stripVerdictToken(lead.evidence) || "";
const fixed = encodeEvidence(
  "REVIEW",
  "STOP HOT_INCOMPLETE_CRAWL — downgraded in shadow remediation. " + body
);
await prisma.lead.update({
  where: { id },
  data: {
    evidence: fixed,
    policyFound: false,
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    policyMassimale: null,
  },
});
const after = await prisma.lead.findUnique({ where: { id } });
console.log("after", readVerdictToken(after.evidence));

// patch deduped jsonl
const p = "data/shadow/crawl/fullcrawl-results-deduped.jsonl";
const rows = fs
  .readFileSync(p, "utf8")
  .split(/\n+/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((r) => {
    if (r.id !== id) return r;
    return {
      ...r,
      newVerdict: "REVIEW",
      remediated: "HOT_INCOMPLETE_CRAWL→REVIEW",
      legacyClass: r.oldVerdict === "HOT" ? "POSSIBLE_NEW_FALSE_NEGATIVE" : r.legacyClass,
    };
  });
fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
await prisma.$disconnect();
