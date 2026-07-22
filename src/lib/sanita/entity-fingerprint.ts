/**
 * EntityFingerprint — attribuzione documento↔struttura.
 * Nome simile da solo non basta. Il fingerprint documento NON copia campi lead.
 */

export type EntityFingerprint = {
  legalName?: string | null;
  facilityName?: string | null;
  /** RC-08g — all legal-name candidates found in the document (deduped, filtered). */
  legalNameCandidates?: string[] | null;
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
  insuredSeats?: string[] | null;
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

/**
 * Extract entity fields ONLY from document text/metadata/URL host context.
 * Never copy lead/facility fields into the document fingerprint.
 */
export function extractDocumentEntityFingerprint(
  text: string,
  metadata?: { title?: string | null; author?: string | null } | null,
  url?: string | null
): EntityFingerprint {
  // RC-08c — never let raw URLs feed the legal-name regex (e.g. title=policyUrl
  // matches "Clinica" inside hostname clinicamontevergine.com → false nameConflict).
  const hayRaw = `${metadata?.title || ""}\n${metadata?.author || ""}\n${text || ""}`;
  const hay = hayRaw.replace(/https?:\/\/[^\s<>"']+/gi, " ");
  const vat =
    hay.match(/(?:p\.?\s*iva|partita\s+iva|vat)[^\d]{0,16}(\d{11})\b/i)?.[1] || null;
  const tax =
    hay.match(/(?:codice\s+fiscale|c\.?\s*f\.?)[^\w]{0,12}([A-Z0-9]{11,16})\b/i)?.[1] || null;
  const phone =
    hay
      .match(/(?:tel(?:efono)?|phone)[^\d+]{0,12}((?:\+39)?[\s.]?\d[\d\s./-]{7,})\b/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() || null;
  const municipality =
    hay.match(/(?:comune|citt[aà]|sede\s+(?:legale|operativa)\s+(?:in|di))\s+([A-ZÀ-Ú][a-zà-ú' ]{2,40})/i)?.[1]?.trim() ||
    hay.match(/\b(\d{5})\s+([A-ZÀ-Ú][a-zà-ú' ]{2,40})(?:\s*\(([A-Z]{2})\))?/i)?.[2]?.trim() ||
    null;
  const province =
    hay.match(/\b\d{5}\s+[A-ZÀ-Ú][a-zà-ú' ]{2,40}\s*\(([A-Z]{2})\)/i)?.[1] ||
    hay.match(/\bprovincia\s+(?:di\s+)?([A-ZÀ-Ú][a-zà-ú']{2,30})/i)?.[1] ||
    null;
  const address =
    hay.match(/(?:via|viale|piazza|corso|largo)\s+[A-ZÀ-Ú0-9][^,;\n]{4,60}/i)?.[0]?.trim() || null;

  const insured =
    hay.match(/(?:contraente|assicurato|intestatario|denominazione)[:\s]+([A-ZÀ-Ú][^,\n;]{3,80})/i)?.[1]?.trim() ||
    null;
  const manager =
    hay.match(/(?:gestore|soggetto\s+gestore|direzione)[:\s]+([A-ZÀ-Ú][^,\n;]{3,80})/i)?.[1]?.trim() ||
    null;
  // RC-08g — extract ALL legal-name candidates: keyword-prefixed forms and bare
  // "<Nome> S.p.A./S.r.l." forms. Taglines ("Casa di Cura Privata Accreditata…")
  // and insurers/brokers are filtered out. The conflict gate then fires only when
  // NO candidate matches the facility (see canAttributeEntity).
  const INSURER_OR_BROKER =
    /generali|unipol|allianz|zurich|\baxa\b|reale\s+mutua|accelerant|amtrust|berkshire|lloyd'?s|groupama|vittoria|cattolica|\bhdi\b|assicurazioni|assicuratrice|broker|intermediaz/i;
  const cleanLegalCandidate = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    let c = raw.trim();
    if (!c) return null;
    if (/https?:\/\/|www\.|\.(?:com|it|org|net|eu|info|biz)\b|@|\//i.test(c)) return null;
    if (INSURER_OR_BROKER.test(c)) return null;
    const tokens = c
      .toLowerCase()
      .replace(/[^a-z0-9àèéìòù]+/gi, " ")
      .split(/\s+/)
      .filter(
        (t) =>
          t.length >= 5 &&
          !/^(fondazione|clinica|istituto|poliambulatorio|ospedale|cooperativa|privata|gestione|clinical|management|risk|piano|annuale)$/i.test(
            t
          )
      );
    return tokens.length === 0 ? null : c;
  };
  const legalCandidates: string[] = [];
  const pushCandidate = (raw: string | null | undefined) => {
    const c = cleanLegalCandidate(raw);
    if (c && !legalCandidates.includes(c)) legalCandidates.push(c);
  };
  for (const m of hay.matchAll(
    /((?:Fondazione|Casa\s+di\s+[Cc]ura|Clinica|Istituto|Poliambulatorio|Ospedale|RSA|Cooperativa)\b[^,\n;.]{0,60}(?:S\.?\s*p\.?\s*A\.?|S\.?\s*r\.?\s*l\.?|Soc\.?\s+Coop\.?)?)/gi
  )) {
    pushCandidate(m[1]);
  }
  for (const m of hay.matchAll(
    /([A-ZÀ-Ú][A-Za-zÀ-ÿ'’.-]*(?:\s+[A-Za-zÀ-ÿ'’.-]+){0,4}\s+S\.?\s*p\.?\s*A\.?|[A-ZÀ-Ú][A-Za-zÀ-ÿ'’.-]*(?:\s+[A-Za-zÀ-ÿ'’.-]+){0,4}\s+S\.?\s*r\.?\s*l\.?)/g
  )) {
    pushCandidate(m[1]);
  }
  const legal = legalCandidates[0] || null;
  const regional =
    hay.match(/(?:codice\s+struttura|codice\s+regionale|codice\s+STS)[^\w]{0,8}([A-Z0-9/-]{4,20})/i)?.[1] ||
    null;

  const seats: string[] = [];
  for (const m of hay.matchAll(/sede\s+(?:di|operativa|secondaria)?\s*:?\s*([A-ZÀ-Ú][^\n;,]{3,50})/gi)) {
    seats.push(m[1]!.trim());
  }

  let domain: string | null = null;
  try {
    if (url) domain = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    domain = null;
  }

  return {
    facilityName: insured || legal || null,
    legalName: legal || insured || null,
    legalNameCandidates: legalCandidates.length ? legalCandidates : null,
    manager: manager || null,
    vatId: vat,
    taxCode: tax,
    address,
    municipality,
    province,
    phone,
    domain,
    seatPageUrl: url || null,
    regionalCode: regional,
    groupSeatVerified: seats.length > 0,
    insuredSeats: seats.length ? seats : null,
  };
}

/** Facility fingerprint from lead + official site signals (not from document body). */
export function buildFacilityFingerprint(input: {
  companyName: string;
  city?: string | null;
  phone?: string | null;
  piva?: string | null;
  website?: string | null;
  address?: string | null;
  taxCode?: string | null;
  groupSeatVerified?: boolean;
}): EntityFingerprint {
  let domain: string | null = null;
  try {
    domain = input.website ? new URL(input.website).hostname.replace(/^www\./i, "") : null;
  } catch {
    domain = null;
  }
  return {
    facilityName: input.companyName,
    legalName: input.companyName,
    municipality: input.city,
    phone: input.phone,
    vatId: input.piva,
    taxCode: input.taxCode,
    address: input.address,
    domain,
    seatPageUrl: input.website || null,
    groupSeatVerified: input.groupSeatVerified === true,
  };
}

/** Regola terminale: 1 forte OPPURE ≥3 medi coerenti (o combo esplicite). */
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
    medium.push("seatPage");
  }
  if (present(doc.domain) && present(facility.domain) && sameHost(doc.domain!, facility.domain!)) {
    medium.push("domain");
  }

  // RC-08g — name match/conflict on ALL extracted legal-name candidates:
  // a tagline ("Casa di Cura Privata Accreditata…") next to the real legal name
  // ("Montevergine S.p.A.") must not produce a false conflict.
  const docNameCandidates = (
    doc.legalNameCandidates?.length
      ? doc.legalNameCandidates
      : [doc.facilityName || doc.legalName].filter((c): c is string => present(c))
  ).filter((c) => present(c) && !/https?:\/\/|www\.|\.(?:com|it|org|net|eu|info|biz)\b|@|\//i.test(c!));
  const facilityName = facility.facilityName || facility.legalName;
  const anyNameOverlap =
    present(facilityName) && docNameCandidates.some((c) => nameOverlap(c, facilityName));
  if (anyNameOverlap || nameOverlap(doc.facilityName || doc.legalName, facilityName)) {
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
  if (present(doc.manager) && present(facility.manager) && softMatch(doc.manager!, facility.manager!)) {
    medium.push("manager");
  }

  const nameGeoDomain =
    medium.includes("name") && medium.includes("geo") && medium.includes("domain");
  const nameManagerSeat =
    medium.includes("name") && medium.includes("manager") && medium.includes("groupSeat");

  // RC-08 — PARM/PARS PDFs on the facility host often lack extractable name/VAT.
  // Accept first-party *policy document* URLs (pdf / polizza path) when domain matches
  // and the document does not name a conflicting entity/VAT.
  // Note: domain+seatPage alone is NOT enough — seatPage is set for any URL, so that
  // pair collapses to domain-only (rejected below).
  // RC-08g — conflict only when the doc names entities and NONE matches the facility.
  const nameConflict =
    docNameCandidates.length > 0 &&
    present(facilityName) &&
    !anyNameOverlap;
  const vatConflict =
    present(doc.vatId) &&
    present(facility.vatId) &&
    normId(doc.vatId) !== normId(facility.vatId);
  const docUrl = doc.seatPageUrl || "";
  const looksLikePolicyDoc =
    /\.pdf(\?|#|$)/i.test(docUrl) ||
    /(?:^|\/)(?:parm|pars|polizza|assicur|rc[to]|trasparen)/i.test(docUrl);
  const firstPartyPolicyDoc =
    medium.includes("domain") && looksLikePolicyDoc && !nameConflict && !vatConflict;

  if (strong.length >= 1) {
    return { ok: true, strongIds: strong, mediumIds: medium, reasons: [] };
  }
  if (firstPartyPolicyDoc || nameGeoDomain || nameManagerSeat || medium.length >= 3) {
    return { ok: true, strongIds: strong, mediumIds: medium, reasons: [] };
  }
  if (medium.length === 1 && medium[0] === "domain") {
    reasons.push("dominio first-party insufficiente senza identità estratta dal documento");
  } else {
    reasons.push(`attribuzione insufficiente (strong=${strong.length}, medium=${medium.length})`);
  }
  return { ok: false, strongIds: strong, mediumIds: medium, reasons };
}

function normId(v: string | null | undefined): string {
  return String(v || "").replace(/\s+/g, "").toUpperCase();
}
function digits(v: string): string {
  return v.replace(/\D/g, "");
}
function softMatch(a: string, b: string): boolean {
  const strip = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(casa\s+di\s+cura|clinica|istituto|fondazione|privata|spa|s\.?\s*p\.?\s*a\.?|s\.?\s*r\.?\s*l\.?)\b/gi, " ")
      .replace(/[^a-z0-9àèéìòù]/gi, "");
  const na = strip(a);
  const nb = strip(b);
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  // Distinctive token ≥5 chars shared (e.g. Montevergine vs Casa Di Cura Montevergine)
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9àèéìòù]+/gi, " ")
      .split(/\s+/)
      .filter(
        (t) =>
          t.length >= 5 &&
          !/^(della|delle|degli|dello|casa|cura|privata|fondazione|clinica|istituto|centro|medico|residenza)$/i.test(t)
      );
  const A = new Set(tokens(a));
  return tokens(b).some((t) => A.has(t));
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
