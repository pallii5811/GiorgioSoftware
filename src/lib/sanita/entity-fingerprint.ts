/**
 * EntityFingerprint — attribuzione documento↔struttura.
 * Nome simile da solo non basta.
 */

export type EntityFingerprint = {
  legalName?: string | null;
  facilityName?: string | null;
  manager?: string | null;
  vatId?: string | null;
  taxCode?: string | null;
  address?: string | null;
  municipality?: string | null;
  province?: string | null;
  phone?: string | null;
  domain?: string | null;
  seatPageUrl?: string | null;
  regionalCode?: string | null;
  groupSeatVerified?: boolean;
};

export type AttributionDecision = {
  ok: boolean;
  strongIds: string[];
  mediumIds: string[];
  reasons: string[];
};

function present(v: string | null | undefined): boolean {
  return Boolean(v && String(v).trim().length >= 2);
}

/** Regola terminale: 1 forte OPPURE ≥3 medi coerenti. */
export function canAttributeEntity(doc: EntityFingerprint, facility: EntityFingerprint): AttributionDecision {
  const strong: string[] = [];
  const medium: string[] = [];
  const reasons: string[] = [];

  if (present(doc.vatId) && present(facility.vatId) && normId(doc.vatId) === normId(facility.vatId)) {
    strong.push("vatId");
  }
  if (present(doc.taxCode) && present(facility.taxCode) && normId(doc.taxCode) === normId(facility.taxCode)) {
    strong.push("taxCode");
  }
  if (
    present(doc.regionalCode) &&
    present(facility.regionalCode) &&
    normId(doc.regionalCode) === normId(facility.regionalCode)
  ) {
    strong.push("regionalCode");
  }
  if (present(doc.seatPageUrl) && present(facility.seatPageUrl) && sameHost(doc.seatPageUrl!, facility.seatPageUrl!)) {
    strong.push("seatPage");
  }
  if (present(doc.domain) && present(facility.domain) && sameHost(doc.domain!, facility.domain!)) {
    medium.push("domain");
  }

  if (nameOverlap(doc.facilityName || doc.legalName, facility.facilityName || facility.legalName)) {
    medium.push("name");
  }
  if (
    (present(doc.address) && present(facility.address) && softMatch(doc.address!, facility.address!)) ||
    (present(doc.municipality) &&
      present(facility.municipality) &&
      softMatch(doc.municipality!, facility.municipality!))
  ) {
    medium.push("geo");
  }
  if (present(doc.phone) && present(facility.phone) && digits(doc.phone!) === digits(facility.phone!)) {
    medium.push("phone");
  }
  if (facility.groupSeatVerified === true && doc.groupSeatVerified === true) {
    medium.push("groupSeat");
  }

  if (strong.length >= 1) {
    return { ok: true, strongIds: strong, mediumIds: medium, reasons: [] };
  }
  if (medium.length >= 3) {
    return { ok: true, strongIds: strong, mediumIds: medium, reasons: [] };
  }
  reasons.push(
    strong.length === 0 && medium.length < 3
      ? `attribuzione insufficiente (strong=${strong.length}, medium=${medium.length})`
      : "attribuzione fallita"
  );
  return { ok: false, strongIds: strong, mediumIds: medium, reasons };
}

function normId(v: string | null | undefined): string {
  return String(v || "").replace(/\s+/g, "").toUpperCase();
}
function digits(v: string): string {
  return v.replace(/\D/g, "");
}
function softMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9àèéìòù]/gi, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9àèéìòù]/gi, "");
  return na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na));
}
function nameOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!present(a) || !present(b)) return false;
  return softMatch(a!, b!);
}
function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a.startsWith("http") ? a : `https://${a}`).hostname.replace(/^www\./i, "");
    const hb = new URL(b.startsWith("http") ? b : `https://${b}`).hostname.replace(/^www\./i, "");
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch {
    return false;
  }
}
