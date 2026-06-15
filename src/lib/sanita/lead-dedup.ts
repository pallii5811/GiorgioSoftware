import { isBlockedWebsiteHost } from "@/lib/sanita/website";

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
};

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

  if (piva) keys.push(`piva|${region}|${piva}`);
  if (phone) keys.push(`phone|${region}|${phone}`);
  if (host && phone) keys.push(`site-phone|${region}|${host}|${phone}`);
  if (host && piva) keys.push(`site-piva|${region}|${host}|${piva}`);

  return keys;
}

export function pickCanonicalLead<T extends LeadIdentityFields>(list: T[]): T {
  return [...list].sort((a, b) => {
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
