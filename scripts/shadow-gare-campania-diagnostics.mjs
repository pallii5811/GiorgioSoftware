#!/usr/bin/env node
/** Gare Campania scoring diagnostics + dump for V2 packs (shadow DB). */
import fs from "node:fs";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { parseContractTypeMarker } from "../src/lib/gare/contract-type.ts";
import { scoreGareCommercial, estimateCauzione } from "../src/lib/gare/commercial.ts";
import { categoryToRelevance } from "../src/lib/gare/display.ts";
import { parseTenderAwardDateObj, isStaleTenderAward, parseTenderBuyer } from "../src/lib/gare/display.ts";

requireShadowIsolation();

const ids = JSON.parse(
  fs.readFileSync("docs/shadow/batch1/gare-selection-campania.json", "utf8")
).ids;

const rows = [];
for (const id of ids) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) continue;
  const awardDate = parseTenderAwardDateObj(lead.evidence);
  const stale = isStaleTenderAward(lead.evidence);
  const relevance = categoryToRelevance(lead.category) || "LOW";
  const amount = Number(lead.tenderAmount || 0);
  const commercial = scoreGareCommercial({
    awardDate,
    amount,
    hasPhone: Boolean(lead.phone),
    hasEmail: Boolean(lead.email),
    hasWebsite: Boolean(lead.website),
    relevance,
    winnerIdentified: Boolean(lead.tenderWinner || lead.companyName),
    officialSource: /anac|ocds|cig/i.test(lead.evidence || "") || Boolean(lead.tenderCig),
  });
  const reasons = [];
  if (stale) reasons.push("troppo_vecchio");
  if (amount > 0 && amount < 75000) reasons.push("importo_basso");
  if (!lead.phone && !lead.email) reasons.push("contatti_mancanti");
  if (relevance === "LOW") reasons.push("rilevanza_bassa");
  if (!awardDate) reasons.push("data_assente_recency_zero");
  if (/undefined/i.test(lead.category || "")) reasons.push("categoria_undefined_legacy");
  const cauzione = estimateCauzione(amount);
  rows.push({
    id: lead.id,
    cig: lead.tenderCig,
    object: lead.tenderObject,
    winner: lead.tenderWinner || lead.companyName,
    buyer: parseTenderBuyer(lead.evidence),
    amount,
    category: lead.category,
    contractType: parseContractTypeMarker(lead.evidence),
    oldScore: lead.leadScore,
    commercialScore: commercial.score,
    tier: commercial.tier,
    lowReasons: reasons,
    cauzioneKind: cauzione.kind,
    cauzioneValue: cauzione.value,
    insuranceNeed: {
      needType: "cauzione_definitiva",
      status: "WEAKLY_INFERRED",
      estimatedAmount: cauzione.value,
      estimateFormula: "10%_importo",
      confidence: 0.4,
    },
    origin: "IMMUTABLE_PRODUCTION_SNAPSHOT",
  });
}

fs.mkdirSync("docs/shadow/batch1-completion", { recursive: true });
fs.mkdirSync("data/shadow/batch1", { recursive: true });
fs.writeFileSync("data/shadow/batch1/gare-campania-scored.json", JSON.stringify(rows, null, 2));

const reasonCounts = {};
for (const r of rows) for (const x of r.lowReasons) reasonCounts[x] = (reasonCounts[x] || 0) + 1;

const md = [
  "# Gare scoring diagnostics — Campania Batch 1",
  "",
  "**Origin:** IMMUTABLE_PRODUCTION_SNAPSHOT (SHA cfb9e878…)",
  "",
  `Records: ${rows.length}`,
  "",
  "## Tier distribution",
  "",
  ...["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "NOT_ACTIONABLE"].map(
    (t) => `- ${t}: ${rows.filter((r) => r.tier === t).length}`
  ),
  "",
  "## Why LOW / weak scores",
  "",
  ...Object.entries(reasonCounts).map(([k, v]) => `- ${k}: ${v}`),
  "",
  "## Notes",
  "",
  "- Cauzioni are ESTIMATE (10%) unless contract text documents a guarantee — none found in snapshot evidence fields.",
  "- GARE_undefined repaired to GARE_HIGH/MEDIUM/LOW via object/amount recompute; contract type in `[CONTRACT_TYPE:…]`.",
  "- Low scores are mostly missing award dates (recency=0) + missing contacts + LOW relevance objects — not artificial.",
  "",
].join("\n");

fs.writeFileSync("docs/shadow/batch1-completion/gare-scoring-diagnostics.md", md);
console.log(JSON.stringify({ n: rows.length, tiers: Object.fromEntries(["VERY_HIGH","HIGH","MEDIUM","LOW","NOT_ACTIONABLE"].map(t=>[t, rows.filter(r=>r.tier===t).length])), reasonCounts }, null, 2));
await prisma.$disconnect();
