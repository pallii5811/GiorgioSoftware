import { prisma } from "@/lib/prisma";
import { buildAuditTrail, type AuditSources } from "@/lib/sanita/audit";
import { enrichContacts } from "@/lib/sanita/contact-enrichment";
import { mergeContacts } from "@/lib/sanita/contacts";
import { runBatch } from "@/lib/sanita/scan-engine";
import { relevanceCategory } from "@/lib/gare/display";
import {
  computeGareLeadScore,
  type GareRelevance,
} from "@/lib/gare/relevance";

export type TenderMeta = {
  datasetYear: number;
  cig: string;
  object: string;
  buyer: string | null;
  buyerCity: string | null;
  amount: number;
  awardDate: Date | null;
  relevance: GareRelevance;
};

function fmtAwardDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function buildTenderEvidence(meta: TenderMeta, audit: AuditSources): string {
  const parts = [
    `Aggiudicazione ANAC ${meta.datasetYear}`,
    `CIG ${meta.cig}`,
    meta.awardDate ? `Data aggiudicazione: ${fmtAwardDate(meta.awardDate)}` : null,
    meta.object.slice(0, 400),
    meta.buyer ? `Stazione appaltante: ${meta.buyer}` : null,
    meta.buyerCity ? `Comune stazione: ${meta.buyerCity}` : null,
    `Importo €${Math.round(meta.amount).toLocaleString("it-IT")}`,
    `Priorità broker: ${meta.relevance}`,
    meta.relevance === "HIGH"
      ? "Opportunità: RC/polizze/sanità"
      : meta.relevance === "MEDIUM"
        ? "Opportunità: cauzione definitiva + RC impresa"
        : null,
  ].filter(Boolean);

  const trail = buildAuditTrail(
    {
      ...audit,
      anac: true,
      anacYear: meta.datasetYear,
      anacCig: meta.cig,
    },
    "REVIEW",
    parts.join(" · ")
  );
  return `${parts.join(" · ")} — ${trail}`;
}

/** Arricchisce contatti dell'azienda aggiudicataria (Tavily + Maps) con trail fonti. */
export async function enrichTenderLead(
  leadId: string,
  companyName: string,
  region: string,
  meta: TenderMeta
): Promise<void> {
  const audit: AuditSources = {};

  const enriched = await enrichContacts(companyName, null, region);
  let phone: string | null = null;
  let email: string | null = null;
  let pec: string | null = null;
  let website: string | null = null;

  if (enriched.checked) {
    const m = mergeContacts({ phone: null, email: null, pec: null, website: null }, enriched.contacts);
    phone = m.phone;
    email = m.email;
    pec = m.pec;
    website = m.website;
    if (enriched.usedMaps) audit.mapsLookup = true;
    if (enriched.sourceUrls.length) {
      audit.contactSearch = true;
      audit.contactUrls = enriched.sourceUrls;
    }
  }

  const leadScore = computeGareLeadScore(meta.relevance, meta.amount, !!phone, !!(email || pec));

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      phone,
      email,
      pec,
      website,
      city: meta.buyerCity,
      category: relevanceCategory(meta.relevance),
      leadScore,
      evidence: buildTenderEvidence(meta, audit),
      lastScannedAt: new Date(),
    },
  });
}

export async function enrichTenderBatch(
  leads: { id: string; companyName: string; region: string; meta: TenderMeta }[],
  concurrency = 4
): Promise<{ enriched: number; withPhone: number; withEmail: number }> {
  let enriched = 0;
  let withPhone = 0;
  let withEmail = 0;

  await runBatch(leads, concurrency, async (item) => {
    await enrichTenderLead(item.id, item.companyName, item.region, item.meta);
    enriched++;
    const fresh = await prisma.lead.findUnique({
      where: { id: item.id },
      select: { phone: true, email: true, pec: true },
    });
    if (fresh?.phone) withPhone++;
    if (fresh?.email || fresh?.pec) withEmail++;
  });

  return { enriched, withPhone, withEmail };
}
