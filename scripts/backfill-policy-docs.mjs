/** Aggiunge [DOCS: url] ai lead PUBLISHED che hanno PDF in evidenza ma non in allegati UI. */
import { prisma } from "../src/lib/sanita/db-ready.ts";
import { parseEvidenceSections } from "../src/lib/sanita/audit.ts";
import { encodeEvidence } from "../src/lib/sanita/verdict.ts";

const leads = await prisma.lead.findMany({
  where: { evidence: { startsWith: "[V:PUB]" } },
  select: { id: true, companyName: true, evidence: true },
});

let fixed = 0;
for (const l of leads) {
  const { body, fonti, docs } = parseEvidenceSections(l.evidence);
  if (docs?.length) continue;

  const pdf =
    body?.match(/certificata da PDF:\s*(https?:\/\/\S+)/i)?.[1] ??
    body?.match(/(https?:\/\/\S+\.pdf\S*)/i)?.[1];
  if (!pdf) continue;

  const text = [body?.trim(), `[DOCS: ${pdf}]`, fonti].filter(Boolean).join(" — ");
  await prisma.lead.update({
    where: { id: l.id },
    data: { evidence: encodeEvidence("PUBLISHED", text) },
  });
  console.log("FIXED", l.companyName?.slice(0, 45), pdf.slice(-50));
  fixed++;
}

console.log("TOTALE", fixed, "/", leads.length);
