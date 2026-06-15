import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const hot = await p.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:HOT]" } },
  select: { evidence: true, website: true, pagesVisited: true, companyName: true, category: true },
});

let sitoTrasparenza = 0;
let soloPortali = 0;
let altro = 0;
let garbage = 0;

for (const l of hot) {
  const ev = l.evidence || "";
  const name = (l.companyName || "").toLowerCase();
  if (/immobiliare|agenzia|hotel|ristorante|farmacia comunale/i.test(name + " " + (l.website || ""))) garbage++;
  if (/Polizza non pubblicata in Trasparenza/i.test(ev)) sitoTrasparenza++;
  else if (/portali regionali/i.test(ev)) soloPortali++;
  else altro++;
}

const hot1page = hot.filter((l) => l.website && (l.pagesVisited ?? 0) <= 1).length;
const privAcc = hot.filter((l) => /casa di cura|clinica|rsa|riposo/i.test((l.category || "") + l.companyName)).length;

console.log({
  hotTotale: hot.length,
  hot_sitoTrasparenzaLetta: sitoTrasparenza,
  hot_soloPortaliRegionali: soloPortali,
  hot_altro: altro,
  hot_probabileRumore: garbage,
  hot_crawl1pagina: hot1page,
  hot_categoriaPrivata: privAcc,
});

await p.$disconnect();
