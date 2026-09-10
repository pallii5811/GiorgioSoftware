import { prisma } from "@/lib/prisma";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";

const id = "cmsc1cdrs00031h7iuts7hiz7";
const lead = await prisma.lead.findUnique({ where: { id }, select: { evidence: true } });
if (!lead) throw new Error(`lead not found: ${id}`);
if (!/\[STATE:HOT_VERIFIED\]/i.test(lead.evidence || "")) {
  throw new Error("lead is no longer HOT_VERIFIED; refusing stale update");
}

const clean = String(lead.evidence || "")
  .replace(/^\[V:HOT\]\s*/i, "")
  .replace(/\[(?:STATE|BV|VS):[A-Z_]+\]/gi, "")
  .replace(/\s+/g, " ")
  .trim();
const evidence = stampProcessingMeta(
  `Escluso dagli HOT: il record è un call center collegato alla Casa di Cura San Giorgio, non una struttura sanitaria autonoma; la scansione del sito della struttura è ancora incompleta. ${clean}`,
  {
    state: "REVIEW_HUMAN",
    businessVerdict: "REVIEW_HUMAN",
    validationStatus: "CONFLICT_FOUND",
  },
);

await prisma.lead.update({ where: { id }, data: { evidence } });
console.log(JSON.stringify({ id, state: "REVIEW_HUMAN", quarantined: true }));
await prisma.$disconnect();
