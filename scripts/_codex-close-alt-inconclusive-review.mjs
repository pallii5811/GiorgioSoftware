import { prisma } from "@/lib/prisma";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const leads = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    evidence: {
      contains:
        "Dominio alternativo rilevato ma verifica tecnica incompleta: assenza di polizza non certificata.",
    },
  },
  select: { id: true, evidence: true },
});

let updated = 0;
for (const lead of leads) {
  if (!/\[STATE:RETRY_PENDING\]/i.test(lead.evidence || "")) continue;
  const clean = String(lead.evidence || "")
    .replace(/\[(?:STATE|BV|VS):[A-Z_]+\]/gi, "")
    .replace(/\[FONTI:\s*retry tecnico\]/gi, "[FONTI: verifica sito e dominio alternativo]")
    .replace(/\s+/g, " ")
    .trim();
  const evidence = stampProcessingMeta(clean, {
    state: "REVIEW_HUMAN",
    businessVerdict: "REVIEW_HUMAN",
    validationStatus: "CONFLICT_FOUND",
  });
  await prisma.lead.update({
    where: { id: lead.id },
    data: { evidence },
  });
  updated++;
}

console.log(JSON.stringify({ matched: leads.length, updated }));
await prisma.$disconnect();
