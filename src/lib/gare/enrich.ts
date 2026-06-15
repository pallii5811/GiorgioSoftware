import { prisma } from "@/lib/prisma";
import { buildAuditTrail, type AuditSources } from "@/lib/sanita/audit";
import { enrichContacts } from "@/lib/sanita/contact-enrichment";
import { mergeContacts } from "@/lib/sanita/contacts";
import { runBatch } from "@/lib/sanita/scan-engine";

export type TenderMeta = {
  year: number;
  cig: string;
  object: string;
  buyer: string | null;
  amount: number;
};

function buildTenderEvidence(meta: TenderMeta, audit: AuditSources): string {
  const body = [
    `Gara aggiudicata ANAC ${meta.year}`,
    `CIG ${meta.cig}`,
    meta.object.slice(0, 160),
    meta.buyer ? `Stazione appaltante: ${meta.buyer}` : null,
    `Importo €${Math.round(meta.amount).toLocaleString("it-IT")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const trail = buildAuditTrail({
    ...audit,
    anac: true,
    anacYear: meta.year,
    anacCig: meta.cig,
  });
  return `${body} — ${trail}`;
}

function scoreTenderLead(hasPhone: boolean, hasEmail: boolean, hasPec: boolean, hasWeb: boolean): number {
  let s = 40;
  if (hasPhone) s += 25;
  if (hasEmail) s += 20;
  if (hasPec) s += 10;
  if (hasWeb) s += 5;
  return Math.min(100, s);
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

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      phone,
      email,
      pec,
      website,
      leadScore: scoreTenderLead(!!phone, !!email, !!pec, !!website),
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
      select: { phone: true, email: true },
    });
    if (fresh?.phone) withPhone++;
    if (fresh?.email) withEmail++;
  });

  return { enriched, withPhone, withEmail };
}
