/** Corregge blocker noti prima di certify:delivery */
import { prisma } from "../src/lib/prisma.ts";
import { encodeEvidence, readVerdictToken } from "../src/lib/sanita/verdict.ts";
import { isGelliSubjectStructure } from "../src/lib/sanita/gelli-scope.ts";
import { leadIdentityKeys, pickCanonicalLead } from "../src/lib/sanita/lead-dedup.ts";

// 1) PUBLISHED → confidence 1.0 (fix dati pre-detector)
const pub = await prisma.lead.updateMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:PUB]" } },
  data: { confidence: 1 },
});
console.log("PUB confidence → 1.0:", pub.count);

// 2) Numeri polizza OCR spuri
const badNums = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", policyNumber: { not: null } },
  select: { id: true, policyNumber: true },
});
let nFixed = 0;
for (const l of badNums) {
  if (/^(prodotto|sostituisce)$/i.test(l.policyNumber ?? "")) {
    await prisma.lead.update({ where: { id: l.id }, data: { policyNumber: null } });
    nFixed++;
  }
}
console.log("Numeri polizza spuri rimossi:", nFixed);

// 3) HOT con sito giù → REVIEW
const hotDown = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    websiteReachable: false,
  },
});
for (const l of hotDown) {
  const body = (l.evidence || "").replace(/^\[V:HOT\]\s*/i, "");
  await prisma.lead.update({
    where: { id: l.id },
    data: {
      evidence: encodeEvidence(
        "REVIEW",
        `Sito irraggiungibile — impossibile certificare HOT. ${body}`
      ),
      policyCompany: null,
      policyMassimale: null,
      policyNumber: null,
      policyExpiry: null,
      confidence: null,
    },
  });
}
console.log("HOT sito giù → REVIEW:", hotDown.length);

// 3b) HOT non certificato (crawl <3 pagine o Trasparenza non documentata) → REVIEW.
// Un HOT deve essere assenza CERTIFICATA: senza crawl esaustivo è un potenziale falso HOT.
const hotUncertified = await prisma.lead.findMany({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    website: { not: null },
  },
  select: { id: true, evidence: true, pagesVisited: true },
});
let hotDowngraded = 0;
for (const l of hotUncertified) {
  const ev = (l.evidence || "").toLowerCase();
  const crawlInsufficient = (l.pagesVisited ?? 0) < 3;
  const noTrasparenza = !ev.includes("trasparenza") && !ev.includes("documenti");
  if (!crawlInsufficient && !noTrasparenza) continue;
  const motivo = crawlInsufficient
    ? `Crawl insufficiente (${l.pagesVisited ?? 0} pagine) — assenza polizza non certificabile.`
    : "Sezione Trasparenza non raggiunta — assenza polizza non certificabile.";
  await prisma.lead.update({
    where: { id: l.id },
    data: {
      evidence: encodeEvidence("REVIEW", motivo),
      policyCompany: null,
      policyMassimale: null,
      policyNumber: null,
      policyExpiry: null,
      confidence: null,
    },
  });
  hotDowngraded++;
}
console.log("HOT non certificato → REVIEW:", hotDowngraded);

// 4) Rimuovi lead fuori scope Gelli (non strutture art. 10)
const scopeAll = await prisma.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: { id: true, companyName: true, category: true, osmId: true },
});
let scopeRemoved = 0;
for (const l of scopeAll) {
  if (!isGelliSubjectStructure(l.companyName, l.category, l.osmId)) {
    await prisma.lead.delete({ where: { id: l.id } });
    scopeRemoved++;
  }
}
console.log("Fuori scope Gelli rimossi:", scopeRemoved);

// 5) Deduplica per identità reale (stesso sito+telefono, P.IVA, telefono)
const all = await prisma.lead.findMany({
  where: { type: "HEALTHCARE" },
  select: {
    id: true,
    companyName: true,
    region: true,
    city: true,
    website: true,
    phone: true,
    piva: true,
    osmId: true,
    lastScannedAt: true,
    createdAt: true,
    leadScore: true,
  },
});
const groups = new Map();
for (const l of all) {
  for (const key of leadIdentityKeys(l)) {
    if (!groups.has(key)) groups.set(key, []);
    const list = groups.get(key);
    if (!list.some((x) => x.id === l.id)) list.push(l);
  }
}
const toDelete = new Set();
for (const [, list] of groups) {
  if (list.length < 2) continue;
  const keep = pickCanonicalLead(list);
  for (const l of list) {
    if (l.id !== keep.id) toDelete.add(l.id);
  }
}
let deduped = 0;
for (const id of toDelete) {
  await prisma.lead.delete({ where: { id } });
  deduped++;
}
console.log("Duplicati identità eliminati:", deduped);

// 5b) Stesso nome esatto in regione
const byName = new Map();
for (const l of all) {
  if (toDelete.has(l.id)) continue;
  const k = `${l.region}|${l.companyName.toLowerCase().trim()}`;
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(l);
}
for (const [, list] of byName) {
  if (list.length < 2) continue;
  const keep = pickCanonicalLead(list);
  for (const l of list) {
    if (l.id === keep.id || toDelete.has(l.id)) continue;
    await prisma.lead.delete({ where: { id: l.id } });
    deduped++;
  }
}
console.log("Duplicati totali eliminati:", deduped);

// 6) HOT con compagnia spuria (Generali/autoassicurazione nel testo ma verdetto HOT)
const hotSpurious = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    evidence: { startsWith: "[V:HOT]" },
    NOT: { policyCompany: null },
  },
  data: {
    policyCompany: null,
    policyMassimale: null,
    policyNumber: null,
    policyExpiry: null,
    confidence: null,
    policyFound: false,
  },
});
console.log("HOT compagnia spuria rimossa:", hotSpurious.count);

// 7) PUBLISHED deboli → REVIEW (manca policyFound o target fuori scope)
const weakPub = await prisma.lead.findMany({
  where: { type: "HEALTHCARE", evidence: { startsWith: "[V:PUB]" } },
  select: { id: true, companyName: true, policyFound: true, evidence: true },
});
let pubDown = 0;
for (const l of weakPub) {
  if (!l.policyFound) {
    const body = (l.evidence || "").replace(/^\[V:PUB\]\s*/i, "");
    await prisma.lead.update({
      where: { id: l.id },
      data: {
        evidence: encodeEvidence(
          "REVIEW",
          `Pubblicazione non certificata dal motore — verifica manuale. ${body}`
        ),
        policyFound: false,
        policyCompany: null,
        policyMassimale: null,
        policyNumber: null,
        policyExpiry: null,
        confidence: null,
      },
    });
    pubDown++;
  }
}
console.log("PUBLISHED deboli → REVIEW:", pubDown);

await prisma.$disconnect();
