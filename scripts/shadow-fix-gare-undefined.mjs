#!/usr/bin/env node
/**
 * Repair GARE_undefined on shadow DB only + attach CONTRACT_TYPE markers.
 * Fail-closed shadow env required. Does not touch live.
 */
import fs from "node:fs";
import { requireShadowIsolation } from "../src/lib/shadow/guard.ts";
import { prisma } from "../src/lib/sanita/db-ready.ts";
import {
  classifyGareContractType,
  formatContractTypeMarker,
  normalizeGareRelevanceCategory,
  parseContractTypeMarker,
} from "../src/lib/gare/contract-type.ts";

requireShadowIsolation();

const out = {
  scanned: 0,
  undefinedBefore: 0,
  undefinedAfter: 0,
  relevanceFixed: 0,
  contractTyped: 0,
  nonClassificato: 0,
};

const leads = await prisma.lead.findMany({ where: { type: "TENDER" } });
out.scanned = leads.length;
out.undefinedBefore = leads.filter((l) => /undefined/i.test(l.category || "") || !l.category).length;

for (const lead of leads) {
  const relevanceCat = normalizeGareRelevanceCategory(
    lead.category,
    lead.tenderObject,
    lead.companyName,
    lead.tenderAmount
  );
  const ct = classifyGareContractType({
    object: lead.tenderObject,
    tenderMeta: lead.evidence,
  });
  if (ct.type === "NON_CLASSIFICATO") out.nonClassificato++;

  let evidence = lead.evidence || "";
  if (!parseContractTypeMarker(evidence)) {
    evidence = `${evidence} ${formatContractTypeMarker(ct.type)}`.trim();
    out.contractTyped++;
  }

  const changed = relevanceCat !== lead.category || evidence !== (lead.evidence || "");
  if (changed) {
    if (relevanceCat !== lead.category) out.relevanceFixed++;
    await prisma.lead.update({
      where: { id: lead.id },
      data: { category: relevanceCat, evidence },
    });
  }
}

const after = await prisma.lead.findMany({
  where: { type: "TENDER" },
  select: { category: true },
});
out.undefinedAfter = after.filter((l) => /undefined/i.test(l.category || "") || !l.category).length;

fs.mkdirSync("docs/shadow/batch1-completion", { recursive: true });
fs.writeFileSync(
  "docs/shadow/batch1-completion/gare-undefined-fix.json",
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
if (out.undefinedAfter !== 0) process.exit(1);
