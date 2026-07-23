/**
 * Presentazione semantica unica Sanità — API + UI + acceptance.
 */
import { parseEvidenceSections } from "@/lib/sanita/audit";
import {
  isInActionableSalesQueue,
  passesDefaultClientQueueGate,
} from "@/lib/sanita/actionable-queue";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import {
  readBusinessVerdict,
  readProcessingState,
  readValidationStatus,
  isCommercialUiVisible,
  type BusinessVerdict,
  type SanitaProcessingState,
  type ValidationStatus,
} from "@/lib/sanita/processing-state";
import { readCrawlCompleteFromEvidence } from "@/lib/sanita/terminal-processing";
import {
  derivePublishedSubtype,
  readPublishedSubtype,
  uxLabelForPublished,
  type PublishedSubtype,
} from "@/lib/sanita/published-subtype";
import { deriveVerdict, VERDICT_META, type Verdict } from "@/lib/sanita/verdict";

export type SanitaLeadLike = {
  id: string;
  type?: string | null;
  companyName: string;
  region?: string | null;
  website?: string | null;
  city?: string | null;
  category?: string | null;
  policyFound?: boolean | null;
  policyCompany?: string | null;
  policyMassimale?: string | null;
  policyNumber?: string | null;
  policyExpiry?: Date | string | null;
  evidence?: string | null;
  lastScannedAt?: Date | string | null;
  websiteReachable?: boolean | null;
  pagesVisited?: number | null;
};

export type SanitaSemanticPresentation = {
  verdictToken: Verdict | null;
  publishedSubtype: PublishedSubtype | null;
  businessVerdict: BusinessVerdict | null;
  processingState: SanitaProcessingState | null;
  validationStatus: ValidationStatus | null;
  identityStatus: IdentityStatus | null;
  crawlComplete: boolean | null;
  completenessReasons: string[];
  policyCompany: string | null;
  policyNumber: string | null;
  policyExpiry: string | null;
  policyMassimale: string | null;
  documentUrl: string | null;
  evidenceUrls: string[];
  sourceUrl: string | null;
  actionable: boolean;
  queueStatus: "CURRENT" | "RESCAN_REQUIRED" | "HIDDEN";
  clientLabel: string;
  clientExplanation: string;
};

function readIdentityStatus(evidence: string | null | undefined): IdentityStatus | null {
  const m = evidence?.match(/\[IDENTITY:([A-Z_]+)\]/i);
  return m ? (m[1]!.toUpperCase() as IdentityStatus) : null;
}

function readCrawlComplete(evidence: string | null | undefined): boolean | null {
  return readCrawlCompleteFromEvidence(evidence);
}

function formatExpiry(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

export function presentSanitaLead(lead: SanitaLeadLike): SanitaSemanticPresentation {
  const evidence = lead.evidence ?? "";
  const parts = parseEvidenceSections(evidence);
  const verdictToken = deriveVerdict({
    lastScannedAt: lead.lastScannedAt ?? null,
    policyFound: lead.policyFound ?? null,
    websiteReachable: lead.websiteReachable ?? null,
    website: lead.website ?? null,
    evidence: lead.evidence ?? null,
  });
  const processingState = readProcessingState(evidence);
  const businessVerdict = readBusinessVerdict(evidence);
  const validationStatus = readValidationStatus(evidence);
  const identityStatus = readIdentityStatus(evidence);
  const crawlComplete = readCrawlComplete(evidence);

  const publishedSubtype =
    readPublishedSubtype(evidence) ??
    (verdictToken === "PUBLISHED"
      ? derivePublishedSubtype({
          policyObsolete: /scaduta|expired|policyObsolete/i.test(evidence),
          policyExpiry: lead.policyExpiry,
          policyCompany: lead.policyCompany,
          policyNumber: lead.policyNumber,
          policyMassimale: lead.policyMassimale,
          evidenceBody: evidence,
        })
      : null);

  const policyCompany = lead.policyCompany?.trim() || null;
  const policyNumber = lead.policyNumber?.trim() || null;
  const policyExpiry = formatExpiry(lead.policyExpiry);
  const policyMassimale = lead.policyMassimale?.trim() || null;
  const documentUrl = parts.docs?.[0] ?? null;
  const evidenceUrls = [...(parts.docs ?? []), ...(parts.fonti ?? [])].filter(Boolean);
  const sourceUrl = lead.website?.trim() || parts.fonti?.[0] || null;

  const actionable = isInActionableSalesQueue(lead);
  const visible = isCommercialUiVisible(processingState);
  const queueStatus: SanitaSemanticPresentation["queueStatus"] = actionable
    ? "CURRENT"
    : passesDefaultClientQueueGate(lead)
      ? "RESCAN_REQUIRED"
      : "HIDDEN";

  let clientLabel = "Non classificato";
  let clientExplanation = "Lead non ancora analizzato o in elaborazione.";

  if (processingState === "RETRY_PENDING") {
    clientLabel = "Riprova automatica in corso";
    clientExplanation = "Problema tecnico temporaneo — non in coda commerciale.";
  } else if (processingState === "TECHNICAL_BLOCKED") {
    clientLabel = "Blocco tecnico";
    clientExplanation = "Crawl o documento non completato per motivi tecnici.";
  } else if (processingState === "REVIEW_HUMAN" || businessVerdict === "REVIEW_HUMAN") {
    clientLabel = VERDICT_META.REVIEW.label;
    clientExplanation = "Conflitto o ambiguità che richiede verifica umana.";
  } else if (
    businessVerdict === "SELF_INSURANCE_VERIFIED" ||
    processingState === "SELF_INSURANCE_VERIFIED" ||
    publishedSubtype === "SELF_INSURANCE_VERIFIED"
  ) {
    clientLabel = "Autoassicurazione dichiarata";
    clientExplanation = "Gestione diretta del rischio — documento ufficiale first-party.";
  } else if (verdictToken === "HOT" || businessVerdict === "HOT_VERIFIED" || processingState === "HOT_VERIFIED") {
    clientLabel = VERDICT_META.HOT.label;
    clientExplanation = "Assenza polizza RC certificata dopo scansione completa del sito.";
  } else if (
    verdictToken === "PUBLISHED" ||
    (businessVerdict && businessVerdict.startsWith("PUBLISHED")) ||
    (processingState && String(processingState).startsWith("PUBLISHED"))
  ) {
    const subtype = publishedSubtype ?? businessVerdict;
    clientLabel = uxLabelForPublished(
      subtype as PublishedSubtype,
      VERDICT_META.PUBLISHED.label
    );
    if (publishedSubtype === "PUBLISHED_EXPIRED" || businessVerdict === "PUBLISHED_EXPIRED") {
      clientExplanation = "Polizza RC pubblicata sul sito ma scaduta — opportunità commerciale.";
    } else if (publishedSubtype === "PUBLISHED_CURRENT") {
      clientExplanation = "Polizza RC pubblicata e apparentemente valida.";
    } else if (publishedSubtype === "SELF_INSURANCE_VERIFIED") {
      clientLabel = "Autoassicurazione dichiarata";
      clientExplanation = "Gestione diretta del rischio — documento ufficiale first-party.";
    } else {
      clientExplanation = "Documento assicurativo rilevato sul sito istituzionale.";
    }
  } else if (verdictToken === "REVIEW") {
    clientLabel = VERDICT_META.REVIEW.label;
    clientExplanation = "Esito non terminale — verifica necessaria.";
  }

  const completenessReasons: string[] = [];
  if (crawlComplete === false) completenessReasons.push("Crawl frontier non completa");
  if (identityStatus === "INSUFFICIENT_TECHNICAL") {
    completenessReasons.push("Identità non valutabile per problema tecnico");
  }
  if (!visible && processingState) {
    completenessReasons.push(`Stato ${processingState} escluso dalla coda commerciale`);
  }

  return {
    verdictToken,
    publishedSubtype,
    businessVerdict,
    processingState,
    validationStatus,
    identityStatus,
    crawlComplete,
    completenessReasons,
    policyCompany,
    policyNumber,
    policyExpiry,
    policyMassimale,
    documentUrl,
    evidenceUrls,
    sourceUrl,
    actionable,
    queueStatus,
    clientLabel,
    clientExplanation,
  };
}
