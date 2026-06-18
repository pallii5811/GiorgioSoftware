import { PrismaClient } from "@prisma/client";
import { parseEvidenceSections } from "../src/lib/sanita/audit.ts";

const p = new PrismaClient();
const region = "Campania";

const rev = await p.lead.findMany({
  where: { type: "HEALTHCARE", region, evidence: { startsWith: "[V:REV]" } },
  select: { evidence: true, companyName: true, website: true },
});

const reasons = {};
for (const l of rev) {
  const body = parseEvidenceSections(l.evidence).body || "";
  let k = "altro";
  if (/irraggiungibile/i.test(body)) k = "irraggiungibile";
  else if (/Trasparenza non visitata|non trovata|polizza non trovata/i.test(body)) k = "no_trasparenza";
  else if (/PDF non processati|crawl incompleto/i.test(body)) k = "crawl_incompleto";
  else if (/sito errato|omonimia|assente nel sito/i.test(body)) k = "sito_errato";
  else if (/OCR/i.test(body)) k = "ocr";
  else if (/insufficienti|verifica manuale/i.test(body)) k = "policy_incerta";
  else if (/non trovato|senza sito/i.test(body)) k = "no_sito";
  reasons[k] = (reasons[k] || 0) + 1;
}
console.log("REVIEW total:", rev.length);
console.log(JSON.stringify(reasons, null, 2));
await p.$disconnect();
