import { prisma } from "@/lib/prisma";
import { isBlockedWebsiteHost } from "@/lib/sanita/website";
import {
  buildScanMergePayload,
  pickBestScannedLead,
  shouldMergeScanIntoKeeper,
} from "@/lib/sanita/lead-dedup-merge";

export type LeadIdentityFields = {
  id: string;
  region: string;
  companyName: string;
  city?: string | null;
  website?: string | null;
  phone?: string | null;
  piva?: string | null;
  osmId?: string | null;
  lastScannedAt?: Date | null;
  createdAt?: Date;
  leadScore?: number | null;
  evidence?: string | null;
  pagesVisited?: number | null;
};

function nameMatchesWebsiteHost(lead: LeadIdentityFields): number {
  const host = websiteHostKey(lead.website);
  if (!host) return 0;
  const stem = host.split(".")[0].replace(/[^a-z0-9]/g, "");
  const name = (lead.companyName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (stem.length < 5 || name.length < 5) return 0;
  if (name.includes(stem.slice(0, Math.min(stem.length, 12)))) return 1;
  if (stem.includes(name.slice(0, Math.min(name.length, 10)))) return 1;
  return 0;
}

function evidenceQualityScore(evidence: string | null | undefined): number {
  if (!evidence) return 0;
  if (/\[V:PUB\].*costi[\-_]?contabilizzat|autoassicuraz/i.test(evidence)) return 0;
  if (evidence.includes("[V:PUB]")) return 3;
  if (evidence.includes("[V:HOT]")) return 2;
  if (evidence.includes("[V:REV")) return 1;
  return 0;
}

export function websiteHostKey(website: string | null | undefined): string | null {
  if (!website?.trim()) return null;
  try {
    const host = new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || isBlockedWebsiteHost(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function phoneIdentityKey(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-10);
}

export function pivaIdentityKey(piva: string | null | undefined): string | null {
  if (!piva?.trim()) return null;
  const digits = piva.replace(/\D/g, "");
  if (digits.length !== 11) return null;
  return digits;
}

export function nameCityKey(name: string, city: string | null | undefined): string {
  const n = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const c = (city || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${n}|${c}`;
}

/** Chiavi di identità per deduplica (regione + segnale forte). */
export function leadIdentityKeys(lead: LeadIdentityFields): string[] {
  const keys: string[] = [];
  const region = lead.region;
  const piva = pivaIdentityKey(lead.piva);
  const phone = phoneIdentityKey(lead.phone);
  const host = websiteHostKey(lead.website);

  if (host) keys.push(`site|${region}|${host}`);
  if (piva) keys.push(`piva|${region}|${piva}`);
  if (phone) keys.push(`phone|${region}|${phone}`);
  if (host && phone) keys.push(`site-phone|${region}|${host}|${phone}`);
  if (host && piva) keys.push(`site-piva|${region}|${host}|${piva}`);

  return keys;
}

export function pickCanonicalLead<T extends LeadIdentityFields>(list: T[]): T {
  return [...list].sort((a, b) => {
    const aNameMatch = nameMatchesWebsiteHost(a);
    const bNameMatch = nameMatchesWebsiteHost(b);
    if (bNameMatch !== aNameMatch) return bNameMatch - aNameMatch;

    const aEv = evidenceQualityScore(a.evidence);
    const bEv = evidenceQualityScore(b.evidence);
    if (bEv !== aEv) return bEv - aEv;

    const aPages = a.pagesVisited ?? 0;
    const bPages = b.pagesVisited ?? 0;
    if (bPages !== aPages) return bPages - aPages;

    const aWeb = a.website ? 1 : 0;
    const bWeb = b.website ? 1 : 0;
    if (bWeb !== aWeb) return bWeb - aWeb;

    const aMaps = a.osmId?.startsWith("gmaps/") ? 1 : 0;
    const bMaps = b.osmId?.startsWith("gmaps/") ? 1 : 0;
    if (bMaps !== aMaps) return bMaps - aMaps;

    const aSalute = a.osmId?.startsWith("min-salute/") ? 1 : 0;
    const bSalute = b.osmId?.startsWith("min-salute/") ? 1 : 0;
    if (bSalute !== aSalute) return bSalute - aSalute;

    const ta = a.lastScannedAt?.getTime() ?? 0;
    const tb = b.lastScannedAt?.getTime() ?? 0;
    if (tb !== ta) return tb - ta;

    const sa = a.leadScore ?? 0;
    const sb = b.leadScore ?? 0;
    if (sb !== sa) return sb - sa;

    const ca = a.createdAt?.getTime() ?? 0;
    const cb = b.createdAt?.getTime() ?? 0;
    if (cb !== ca) return cb - ca;

    return b.companyName.length - a.companyName.length;
  })[0];
}

export function buildLeadIdentityIndex<T extends LeadIdentityFields>(
  leads: T[]
): Map<string, T> {
  const index = new Map<string, T>();
  for (const lead of leads) {
    for (const key of leadIdentityKeys(lead)) {
      const prev = index.get(key);
      if (!prev) {
        index.set(key, lead);
        continue;
      }
      index.set(key, pickCanonicalLead([prev, lead]));
    }
  }
  return index;
}

export function findMatchingLead<T extends LeadIdentityFields>(
  index: Map<string, T>,
  candidate: LeadIdentityFields
): T | undefined {
  for (const key of leadIdentityKeys(candidate)) {
    const hit = index.get(key);
    if (hit && hit.id !== candidate.id) return hit;
  }
  return undefined;
}

const DEDUP_SELECT = {
  id: true,
  companyName: true,
  city: true,
  website: true,
  osmId: true,
  phone: true,
  piva: true,
  lastScannedAt: true,
  createdAt: true,
  leadScore: true,
  evidence: true,
  pagesVisited: true,
  policyFound: true,
  policyCompany: true,
  policyMassimale: true,
  policyNumber: true,
  policyExpiry: true,
  confidence: true,
  websiteReachable: true,
  email: true,
  pec: true,
} as const;

/** Copia l'analisi migliore sul canonical prima di cancellare duplicati — il conteggio non scende. */
async function mergeBestScanOntoKeeper(
  keepId: string,
  group: Array<{
    id: string;
    companyName: string;
    city?: string | null;
    website?: string | null;
    osmId?: string | null;
    phone?: string | null;
    piva?: string | null;
    lastScannedAt?: Date | null;
    createdAt?: Date;
    leadScore?: number | null;
    evidence?: string | null;
    pagesVisited?: number | null;
  }>
): Promise<void> {
  const keeper = group.find((l) => l.id === keepId);
  if (!keeper) return;

  const best = pickBestScannedLead(group);
  if (!best?.lastScannedAt || !shouldMergeScanIntoKeeper(keeper, best)) return;

  const full = await prisma.lead.findUnique({
    where: { id: best.id },
    select: {
      lastScannedAt: true,
      policyFound: true,
      policyCompany: true,
      policyMassimale: true,
      policyNumber: true,
      policyExpiry: true,
      confidence: true,
      evidence: true,
      websiteReachable: true,
      pagesVisited: true,
      leadScore: true,
      phone: true,
      email: true,
      pec: true,
      website: true,
    },
  });
  if (!full?.lastScannedAt) return;

  await prisma.lead.update({
    where: { id: keepId },
    data: buildScanMergePayload(keeper, full),
  });
}

async function consolidateDuplicateGroup(
  group: Array<{
    id: string;
    companyName: string;
    city?: string | null;
    website?: string | null;
    osmId?: string | null;
    phone?: string | null;
    piva?: string | null;
    lastScannedAt?: Date | null;
    createdAt?: Date;
    leadScore?: number | null;
    evidence?: string | null;
    pagesVisited?: number | null;
  }>
): Promise<number> {
  if (group.length <= 1) return 0;

  const keep = pickCanonicalLead(group);
  await mergeBestScanOntoKeeper(keep.id, group);

  let removed = 0;
  for (const loser of group) {
    if (loser.id === keep.id) continue;
    await prisma.lead.delete({ where: { id: loser.id } }).catch(() => {});
    removed++;
  }
  return removed;
}

/** Elimina schede duplicate con lo stesso sito ufficiale (es. Villa Maria Baiano vs Mirabella). */
export async function absorbWebsiteDuplicates(
  leadId: string,
  website: string | null | undefined,
  region: string
): Promise<string> {
  const host = websiteHostKey(website);
  if (!host) return leadId;

  const peers = await prisma.lead.findMany({
    where: { type: "HEALTHCARE", region, website: { not: null } },
    select: DEDUP_SELECT,
  });
  const group = peers.filter((p) => websiteHostKey(p.website) === host);
  if (group.length <= 1) return leadId;

  const keep = pickCanonicalLead(group);
  await mergeBestScanOntoKeeper(keep.id, group);
  for (const loser of group) {
    if (loser.id === keep.id) continue;
    await prisma.lead.delete({ where: { id: loser.id } }).catch(() => {});
  }
  return keep.id;
}

/** Unifica lead con lo stesso dominio sito prima/dopo la scansione. */
export async function dedupeRegionByWebsite(region: string): Promise<number> {
  const leads = await prisma.lead.findMany({
    where: { type: "HEALTHCARE", region, website: { not: null } },
    select: DEDUP_SELECT,
  });

  const byHost = new Map<string, typeof leads>();
  for (const lead of leads) {
    const host = websiteHostKey(lead.website);
    if (!host) continue;
    const group = byHost.get(host) ?? [];
    group.push(lead);
    byHost.set(host, group);
  }

  let removed = 0;
  for (const group of byHost.values()) {
    removed += await consolidateDuplicateGroup(group);
  }
  return removed;
}

/** Unifica schede con stesso nome struttura (es. Villa Maria Baiano + Mirabella Eclano). */
export async function dedupeRegionByCompanyName(region: string): Promise<number> {
  const leads = await prisma.lead.findMany({
    where: { type: "HEALTHCARE", region },
    select: DEDUP_SELECT,
  });

  const byName = new Map<string, typeof leads>();
  for (const lead of leads) {
    const key = (lead.companyName || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\b(s\.?p\.?a\.?|s\.?r\.?l\.?)\b/gi, "")
      .trim();
    if (key.length < 8) continue;
    const group = byName.get(key) ?? [];
    group.push(lead);
    byName.set(key, group);
  }

  let removed = 0;
  for (const group of byName.values()) {
    removed += await consolidateDuplicateGroup(group);
  }
  return removed;
}
