/**
 * UNICA definizione di completezza commerciale per un lead sanità.
 *
 * Regola d'oro: worker, API e UI non reimplementano questa logica —
 * chiamano evaluateLeadCompletion. Esiti commerciali conclusi ammessi:
 *
 *   PUBLISHED_CURRENT | PUBLISHED_EXPIRED | PUBLISHED_DATE_UNKNOWN |
 *   SELF_INSURANCE_VERIFIED | HOT_VERIFIED
 *
 * Tutto il resto (RETRY_PENDING, TECHNICAL_BLOCKED, FRONTIER_INCOMPLETE,
 * SITEMAP_UNRESOLVED, OCR failure, timeout, identità incerta, REVIEW_HUMAN,
 * PUBLISHED_ANALOGOUS_MEASURE) è INCOMPLETO o non commerciale.
 *
 * Fail-closed: HOT_VERIFIED è impossibile quando
 *   unresolvedRelevantNodes > 0  |  unprocessedRelevantPdfs > 0  |
 *   technicalFailures > 0        |  ocrErrors > 0                |
 *   identityConfidence < IDENTITY_CONFIDENCE_GATE | seconda verifica mancante
 */
import {
  crawlBlocksTerminalVerdict,
  type CrawlCompleteness,
} from "@/lib/evidence/contract";
import {
  canEmitPublished,
  type PublishedEmitEvidence,
} from "@/lib/sanita/can-emit-published";
import {
  explainCanEmitHot,
  MIN_PAGES_FOR_HOT,
} from "@/lib/sanita/can-emit-hot";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import { deriveCrawlCompleteness } from "@/lib/sanita/frontier-store";

export const IDENTITY_CONFIDENCE_GATE = 0.8;

export type CommercialOutcome =
  | "PUBLISHED_CURRENT"
  | "PUBLISHED_EXPIRED"
  | "PUBLISHED_DATE_UNKNOWN"
  | "SELF_INSURANCE_VERIFIED"
  | "HOT_VERIFIED";

/** Stati che contano in completedCommercial (gate / export / KPI). */
export const COMMERCIAL_COMPLETED_STATES: ReadonlySet<string> = new Set([
  "PUBLISHED_CURRENT",
  "PUBLISHED_EXPIRED",
  "PUBLISHED_DATE_UNKNOWN",
  "SELF_INSURANCE_VERIFIED",
  "HOT_VERIFIED",
]);

export function isCompletedCommercialState(state: string | null | undefined): boolean {
  return Boolean(state && COMMERCIAL_COMPLETED_STATES.has(state));
}

export type LeadCompletionInput = {
  identityStatus: IdentityStatus | "UNKNOWN" | null | undefined;
  /** 0..1 — se presente e sotto gate, HOT e PUBLISHED sono impossibili. */
  identityConfidence?: number | null;
  category?: string | null;
  website?: string | null;
  websiteReachable?: boolean | null;
  pagesVisited: number;
  policyExhaustive: boolean;
  needsOcrReview: boolean;
  /** Produzione: completeness derivata SOLO dal frontier persistito. */
  crawlRunId?: string | null;
  /** Test/override esplicito — ignorato se crawlRunId presente. */
  crawlCompleteness?: CrawlCompleteness | null;
  /** Seconda verifica indipendente conclusa (dual HOT p1+p2 concordi). */
  secondPassConfirmed?: boolean;
  /** Evidence di polizza first-party, se trovata. */
  published?: PublishedEmitEvidence | null;
  /** SHA-256 (64 hex) del PDF/pagina di polizza — obbligatorio per PUBLISHED. */
  policyDocumentHash?: string | null;
  /** Evidence row realmente persistita nel frontier store. */
  policyEvidencePersisted?: boolean;
  policyCompany?: string | null;
  policyNumber?: string | null;
  /** ISO date scadenza estratta dal documento, se presente. */
  policyExpiry?: string | null;
  runAt?: Date;
};

export type FrontierCounters = {
  unresolvedRelevantNodes: number;
  unprocessedRelevantPdfs: number;
  technicalFailures: number;
  ocrErrors: number;
};

export type LeadCompletion =
  | {
      complete: true;
      outcome: CommercialOutcome;
      businessVerdict: CommercialOutcome;
      counters: FrontierCounters;
      reasons: [];
    }
  | {
      complete: false;
      outcome: null;
      reasonCode: string;
      counters: FrontierCounters;
      reasons: string[];
    };

const SHA256_RE = /^[0-9a-f]{64}$/;

function countersFrom(c: CrawlCompleteness | null | undefined): FrontierCounters {
  return {
    unresolvedRelevantNodes: Math.max(0, Number(c?.unresolvedRelevantUrls || 0)),
    unprocessedRelevantPdfs: Math.max(0, Number(c?.unreadableRelevantDocuments || 0)),
    technicalFailures: Math.max(0, Number(c?.failedRelevantUrls || 0)),
    ocrErrors: Math.max(0, Number(c?.criticalOcrDoubts || 0)),
  };
}

function identityOk(input: LeadCompletionInput): boolean {
  return (
    input.identityStatus === "OFFICIAL_CONFIRMED" ||
    input.identityStatus === "GROUP_OFFICIAL_CONFIRMED"
  );
}

function incomplete(
  reasonCode: string,
  reasons: string[],
  counters: FrontierCounters
): LeadCompletion {
  return { complete: false, outcome: null, reasonCode, counters, reasons };
}

export function evaluateLeadCompletion(input: LeadCompletionInput): LeadCompletion {
  const runAt = input.runAt ?? new Date();

  // Completeness: mai inventata — dal frontier persistito o override esplicito.
  let completeness: CrawlCompleteness | null | undefined = null;
  if (input.crawlRunId) completeness = deriveCrawlCompleteness(input.crawlRunId);
  else if (input.crawlCompleteness !== undefined) completeness = input.crawlCompleteness;

  const counters = countersFrom(completeness);
  const reasons: string[] = [];

  // ---- gate duri condivisi (valgono per QUALSIASI esito terminale) --------
  if (!identityOk(input)) reasons.push(`identità non terminale (${input.identityStatus ?? "UNKNOWN"})`);
  if (
    input.identityConfidence != null &&
    Number.isFinite(input.identityConfidence) &&
    input.identityConfidence < IDENTITY_CONFIDENCE_GATE
  ) {
    reasons.push(
      `identityConfidence ${input.identityConfidence} < gate ${IDENTITY_CONFIDENCE_GATE}`
    );
  }
  if (!input.category?.trim()) reasons.push("categoria sanitaria assente");
  if (counters.unresolvedRelevantNodes > 0) {
    reasons.push(`${counters.unresolvedRelevantNodes} nodi rilevanti irrisolti`);
  }
  if (counters.unprocessedRelevantPdfs > 0) {
    reasons.push(`${counters.unprocessedRelevantPdfs} PDF rilevanti non processati`);
  }
  if (counters.technicalFailures > 0) {
    reasons.push(`${counters.technicalFailures} fallimenti tecnici su nodi rilevanti`);
  }
  if (counters.ocrErrors > 0) reasons.push(`${counters.ocrErrors} errori/dubbi OCR critici`);
  const crawlBlock = crawlBlocksTerminalVerdict(completeness ?? null);
  if (crawlBlock) reasons.push(crawlBlock);

  // ---- ramo PUBLISHED: evidence di polizza esiste → mai degradare a HOT ----
  if (input.published) {
    const pubReasons = [...reasons];
    const gate = canEmitPublished(input.published);
    pubReasons.push(...gate.reasons);
    if (!SHA256_RE.test(input.policyDocumentHash || "")) {
      pubReasons.push("hash SHA-256 documento/pagina polizza mancante");
    }
    if (input.policyEvidencePersisted !== true) {
      pubReasons.push("evidence polizza non persistita nel frontier");
    }
    if (pubReasons.length) {
      return incomplete("PUBLISHED_GATE_FAILED", pubReasons, counters);
    }
    // Autoassicurazione first-party: terminale commerciale distinto (≠ CURRENT/EXPIRED).
    if (input.published.selfInsurance || gate.businessVerdict === "SELF_INSURANCE_VERIFIED") {
      return {
        complete: true,
        outcome: "SELF_INSURANCE_VERIFIED",
        businessVerdict: "SELF_INSURANCE_VERIFIED",
        counters,
        reasons: [],
      };
    }
    // ANALOGOUS non è commerciale concluso — fail-closed come incompleto.
    if (
      input.published.analogousMeasure ||
      gate.businessVerdict === "PUBLISHED_ANALOGOUS_MEASURE"
    ) {
      return incomplete("PUBLISHED_ANALOGOUS_NOT_COMMERCIAL", [
        "PUBLISHED_ANALOGOUS_MEASURE escluso da completedCommercial",
      ], counters);
    }
    // Sottotipo SOLO dagli esiti commerciali ammessi su polizza tradizionale.
    const expiry = input.policyExpiry ? Date.parse(input.policyExpiry) : NaN;
    if (Number.isFinite(expiry)) {
      const outcome = expiry >= runAt.getTime() ? "PUBLISHED_CURRENT" : "PUBLISHED_EXPIRED";
      return {
        complete: true,
        outcome,
        businessVerdict: outcome,
        counters,
        reasons: [],
      };
    }
    return {
      complete: true,
      outcome: "PUBLISHED_DATE_UNKNOWN",
      businessVerdict: "PUBLISHED_DATE_UNKNOWN",
      counters,
      reasons: [],
    };
  }

  // ---- ramo HOT: nessuna evidence di polizza → serve il perimetro completo --
  const hotReasons = [...reasons];
  if (!input.website?.trim()) hotReasons.push("sito ufficiale assente");
  if (input.websiteReachable === false) hotReasons.push("sito non raggiungibile");
  if (input.websiteReachable == null && input.website?.trim()) {
    hotReasons.push("raggiungibilità sito sconosciuta");
  }
  if (input.pagesVisited < MIN_PAGES_FOR_HOT) {
    hotReasons.push(`pagine insufficienti (${input.pagesVisited}/${MIN_PAGES_FOR_HOT})`);
  }
  if (input.needsOcrReview) hotReasons.push("OCR critico incerto / PDF illeggibile");
  if (input.policyExhaustive !== true) hotReasons.push("crawl non esaustivo");
  if (input.secondPassConfirmed !== true) {
    hotReasons.push("seconda verifica indipendente non conclusa");
  }
  if (input.crawlRunId) {
    const hot = explainCanEmitHot({
      website: input.website,
      websiteReachable: input.websiteReachable,
      pagesVisited: input.pagesVisited,
      policyExhaustive: input.policyExhaustive,
      needsOcrReview: input.needsOcrReview,
      identityStatus: input.identityStatus,
      category: input.category,
      crawlRunId: input.crawlRunId,
      requirePersistedCompleteness: true,
    });
    hotReasons.push(...hot.reasons);
  }
  if (hotReasons.length) {
    // Reason code operativo dominante (per retry queue / diagnostica).
    let reasonCode = "FRONTIER_INCOMPLETE";
    const blob = hotReasons.join(" | ");
    if (/identità|identityConfidence/i.test(blob)) reasonCode = "IDENTITY_UNRESOLVED";
    else if (/PDF rilevanti non processati|OCR/i.test(blob)) reasonCode = "PDF_OCR_INCOMPLETE";
    else if (/fallimenti tecnici/i.test(blob)) reasonCode = "TECHNICAL_FAILURES";
    else if (/sitemap/i.test(blob)) reasonCode = "SITEMAP_UNRESOLVED";
    else if (/seconda verifica/i.test(blob)) reasonCode = "DUAL_PASS_PENDING";
    return incomplete(reasonCode, hotReasons, counters);
  }

  return {
    complete: true,
    outcome: "HOT_VERIFIED",
    businessVerdict: "HOT_VERIFIED",
    counters,
    reasons: [],
  };
}
