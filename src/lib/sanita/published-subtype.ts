/**
 * Sottostati PUBLISHED — prova positiva con etichette oneste (mai "in regola" se scaduta).
 */

export type PublishedSubtype =
  | "PUBLISHED_CURRENT"
  | "PUBLISHED_EXPIRED"
  | "PUBLISHED_DATE_UNKNOWN"
  | "PUBLISHED_INCOMPLETE"
  | "PUBLISHED_ANALOGOUS_MEASURE"
  | "PUBLISHED_STALE_DOCUMENT";

export const PUBLISHED_SUBTYPE_META: Record<
  PublishedSubtype,
  { label: string; urgency: "none" | "low" | "high"; actionablePriority: 0 | 1 | 2 }
> = {
  PUBLISHED_CURRENT: {
    label: "Polizza pubblicata e valida",
    urgency: "none",
    actionablePriority: 0,
  },
  PUBLISHED_EXPIRED: {
    label: "Polizza pubblicata ma scaduta",
    urgency: "high",
    actionablePriority: 1,
  },
  PUBLISHED_DATE_UNKNOWN: {
    label: "Polizza trovata — scadenza da verificare",
    urgency: "low",
    actionablePriority: 2,
  },
  PUBLISHED_INCOMPLETE: {
    label: "Pubblicazione assicurativa incompleta",
    urgency: "high",
    actionablePriority: 1,
  },
  PUBLISHED_ANALOGOUS_MEASURE: {
    label: "Misura analoga pubblicata",
    urgency: "low",
    actionablePriority: 2,
  },
  PUBLISHED_STALE_DOCUMENT: {
    label: "Documento pubblicato ma non aggiornato",
    urgency: "high",
    actionablePriority: 1,
  },
};

const TOKEN_RE = /\[PS:(PUBLISHED_[A-Z_]+)\]/i;

export function formatPublishedSubtypeToken(subtype: PublishedSubtype): string {
  return `[PS:${subtype}]`;
}

export function readPublishedSubtype(evidence: string | null | undefined): PublishedSubtype | null {
  if (!evidence) return null;
  const m = evidence.match(TOKEN_RE);
  if (!m) return null;
  const raw = m[1]!.toUpperCase() as PublishedSubtype;
  return raw in PUBLISHED_SUBTYPE_META ? raw : null;
}

export function stampPublishedSubtype(body: string, subtype: PublishedSubtype): string {
  const cleaned = body.replace(TOKEN_RE, "").trim();
  return `${formatPublishedSubtypeToken(subtype)} ${cleaned}`.trim();
}

export function derivePublishedSubtype(input: {
  policyObsolete?: boolean | null;
  policyExpiry?: Date | string | null;
  policyCompany?: string | null;
  policyNumber?: string | null;
  policyMassimale?: string | null;
  analogousMeasure?: boolean | null;
  staleDocument?: boolean | null;
  evidenceBody?: string | null;
}): PublishedSubtype {
  if (input.analogousMeasure) return "PUBLISHED_ANALOGOUS_MEASURE";
  if (input.staleDocument) return "PUBLISHED_STALE_DOCUMENT";
  if (input.policyObsolete) return "PUBLISHED_EXPIRED";
  if (
    input.evidenceBody &&
    /scaduta\s+da\s+\d+|policyObsolete|non aggiornata/i.test(input.evidenceBody)
  ) {
    return "PUBLISHED_EXPIRED";
  }
  if (
    input.evidenceBody &&
    /autoassicuraz|gestione\s+diretta|misura\s+analoga/i.test(input.evidenceBody)
  ) {
    return "PUBLISHED_ANALOGOUS_MEASURE";
  }
  const hasCompany = Boolean(input.policyCompany?.trim());
  const hasNumber = Boolean(input.policyNumber?.trim());
  const hasExpiry = Boolean(input.policyExpiry);
  if (hasCompany && !hasNumber && !input.policyMassimale) return "PUBLISHED_INCOMPLETE";
  if (hasCompany && !hasExpiry) return "PUBLISHED_DATE_UNKNOWN";
  if (hasCompany && (hasNumber || input.policyMassimale) && hasExpiry) return "PUBLISHED_CURRENT";
  if (hasCompany) return "PUBLISHED_DATE_UNKNOWN";
  return "PUBLISHED_INCOMPLETE";
}

/** Impedisce card che mostrano "in regola" insieme a scadenza passata. */
export function uxLabelForPublished(
  subtype: PublishedSubtype | null,
  fallbackPublishedLabel: string
): string {
  if (!subtype) return fallbackPublishedLabel;
  return PUBLISHED_SUBTYPE_META[subtype].label;
}

export function publishedAllowsInRegolaBadge(subtype: PublishedSubtype | null): boolean {
  return subtype === "PUBLISHED_CURRENT";
}
