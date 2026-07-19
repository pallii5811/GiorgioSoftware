/**
 * Unico gate PUBLISHED — discovery non emette verdette terminali.
 */
import { sourceAllowsPublished, type SourceClass } from "@/lib/sanita/source-class";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import type { BusinessVerdict } from "@/lib/sanita/processing-state";

export type PublishedEmitEvidence = {
  identityStatus: IdentityStatus | "UNKNOWN" | null | undefined;
  sourceClass: SourceClass;
  exactUrl: string | null | undefined;
  contentFetched: boolean;
  contentExcerpt: string | null | undefined;
  entityAttributed: boolean;
  groupSeatVerified?: boolean;
  hasStrongInsuranceSignal: boolean;
  hasMediumInsuranceSignals: number;
  criticalConflict?: boolean;
  policyObsolete?: boolean;
  hasCoverageEnd?: boolean;
  incompletePublication?: boolean;
  analogousMeasure?: boolean;
  category?: string | null;
};

export type PublishedDecision = {
  ok: boolean;
  businessVerdict: BusinessVerdict | null;
  reasons: string[];
};

export function canEmitPublished(ev: PublishedEmitEvidence): PublishedDecision {
  const reasons: string[] = [];
  const id = ev.identityStatus ?? "UNKNOWN";
  if (id !== "OFFICIAL_CONFIRMED" && id !== "GROUP_OFFICIAL_CONFIRMED") {
    reasons.push(`identità non terminale (${id})`);
  }
  if (!sourceAllowsPublished(ev.sourceClass)) {
    reasons.push(`fonte non ammessa (${ev.sourceClass})`);
  }
  if (ev.sourceClass === "FIRST_PARTY_GROUP" && ev.groupSeatVerified !== true) {
    reasons.push("gruppo senza relazione sede verificata");
  }
  if (!ev.exactUrl?.trim()) reasons.push("URL esatto assente");
  if (!ev.contentFetched) reasons.push("contenuto non acquisito");
  if (!ev.contentExcerpt?.trim()) reasons.push("estratto assente");
  if (!ev.entityAttributed) reasons.push("attribuzione entità mancante");
  if (ev.criticalConflict) reasons.push("conflitto critico");
  if (!ev.category?.trim()) reasons.push("categoria assente");
  if (/NON_SANITARIA|SOLO_SOCIALE|NON_CLASSIFICATA/i.test(ev.category || "")) {
    reasons.push("categoria fuori perimetro");
  }

  const strong = ev.hasStrongInsuranceSignal;
  const mediumOk = (ev.hasMediumInsuranceSignals ?? 0) >= 2;
  if (!strong && !mediumOk) reasons.push("segnali assicurativi insufficienti");

  if (reasons.length) {
    return { ok: false, businessVerdict: null, reasons };
  }

  let businessVerdict: BusinessVerdict = "PUBLISHED_CURRENT";
  if (ev.analogousMeasure) businessVerdict = "PUBLISHED_ANALOGOUS_MEASURE";
  else if (ev.incompletePublication) businessVerdict = "PUBLISHED_INCOMPLETE";
  else if (ev.policyObsolete) businessVerdict = "PUBLISHED_EXPIRED";
  else if (!ev.hasCoverageEnd) businessVerdict = "PUBLISHED_DATE_UNKNOWN";

  return { ok: true, businessVerdict, reasons: [] };
}

/** Segnali da testo — usato da characterization e scan. */
export function detectInsuranceSignals(text: string): {
  strong: boolean;
  mediumCount: number;
} {
  const t = text || "";
  const strong =
    /numero\s+(?:di\s+)?polizza|polizza\s+n[°o.]?\s*[A-Z0-9\-_/]{4,}|contratto\s+assicurativ|attestazione\s+assicurativ|autoassicuraz|gestione\s+diretta\s+del\s+rischio/i.test(
      t
    );
  let medium = 0;
  if (/compagnia|unipol|generali|allianz|zurich|axa|reale\s+mutua|accelerant/i.test(t)) medium++;
  if (/massimale|€\s*\d|euro\s*\d/i.test(t)) medium++;
  if (/\bRCT\b|\bRCO\b|responsabilit[aà]\s+civile/i.test(t)) medium++;
  if (/scadenza|decorrenza|dal\s+\d{1,2}[\/.\-]/i.test(t)) medium++;
  if (/art\.?\s*10|legge\s*gelli|l\.\s*24\/2017/i.test(t)) medium++;
  return { strong, mediumCount: medium };
}
