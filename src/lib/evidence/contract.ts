/**
 * Evidence contract — tracciabilità per Sanità e Gare.
 * Ogni affermazione commerciale deve poter rispondere:
 * "Quale prova esatta giustifica questo campo e questo verdetto?"
 */

export type EvidenceStrength =
  | "PRIMARY_OFFICIAL"
  | "SECONDARY_OFFICIAL"
  | "OFFICIAL_DOCUMENT"
  | "COMPANY_WEBSITE"
  | "SEARCH_DISCOVERY"
  | "INFERENCE"
  | "ESTIMATE";

export type VerificationStatus =
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "CONFLICT"
  | "NOT_VERIFIED"
  | "TECHNICAL_FAILURE";

export interface LeadEvidence {
  sourceType: EvidenceStrength;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  sourcePublishedAt?: string;
  documentDate?: string;
  contentHash?: string;
  exactEvidence?: string;
  evidenceLocator?: string;
  verificationStatus: VerificationStatus;
  supportsFields: string[];
  notes?: string;
}

export type ClaimKind = "FACT" | "INFERENCE" | "ESTIMATE" | "MISSING";

export interface FieldClaim<T = string | number | boolean | null> {
  value: T;
  kind: ClaimKind;
  evidence?: LeadEvidence[];
  confidence: number;
  extractionMethod?: string;
  conflict?: string;
  needsHumanReview?: boolean;
}

export type SitemapStatus =
  | "NOT_DISCOVERED"
  | "NOT_PRESENT"
  | "DISCOVERED_COMPLETE"
  | "DISCOVERED_PARTIAL"
  | "DISCOVERED_FAILED"
  | "ROBOTS_REFERENCED_COMPLETE"
  | "ROBOTS_REFERENCED_FAILED";

/** Completezza crawl — `complete` è SEMPRE derivato, mai impostato a mano. */
export interface CrawlCompleteness {
  identityVerified: boolean;
  /** @deprecated usare sitemapStatus — true solo se DISCOVERED_COMPLETE | NOT_PRESENT | ROBOTS_REFERENCED_COMPLETE */
  sitemapExhausted: boolean;
  sitemapStatus: SitemapStatus;
  htmlQueueExhausted: boolean;
  relevantLinksProcessed: boolean;
  relevantDocumentsProcessed: boolean;
  jsonEndpointsProcessed: boolean;
  sameHostScriptsProcessed: boolean;
  unresolvedRelevantUrls: number;
  failedRelevantUrls: number;
  unreadableRelevantDocuments: number;
  criticalOcrDoubts: number;
  urlCapReached: boolean;
  timeCapReached: boolean;
  /** Derivato: true solo se tutti i gate sotto sono soddisfatti. */
  complete: boolean;
}

export function sitemapStatusAllowsHot(status: SitemapStatus): boolean {
  // NOT_DISCOVERED / PARTIAL / FAILED / ROBOTS_*_FAILED → bloccano HOT.
  // NOT_PRESENT (404 senza altri riferimenti) e COMPLETE → ok.
  return (
    status === "NOT_PRESENT" ||
    status === "DISCOVERED_COMPLETE" ||
    status === "ROBOTS_REFERENCED_COMPLETE"
  );
}

export function deriveCrawlComplete(
  c: Omit<CrawlCompleteness, "complete" | "sitemapExhausted"> & {
    sitemapExhausted?: boolean;
    sitemapStatus: SitemapStatus;
  }
): CrawlCompleteness {
  const sitemapOk = sitemapStatusAllowsHot(c.sitemapStatus);
  const sitemapExhausted =
    c.sitemapStatus === "DISCOVERED_COMPLETE" ||
    c.sitemapStatus === "NOT_PRESENT" ||
    c.sitemapStatus === "ROBOTS_REFERENCED_COMPLETE";
  const complete =
    c.identityVerified &&
    sitemapOk &&
    c.htmlQueueExhausted &&
    c.relevantLinksProcessed &&
    c.relevantDocumentsProcessed &&
    c.jsonEndpointsProcessed &&
    c.sameHostScriptsProcessed &&
    c.unresolvedRelevantUrls === 0 &&
    c.failedRelevantUrls === 0 &&
    c.unreadableRelevantDocuments === 0 &&
    c.criticalOcrDoubts === 0 &&
    !c.urlCapReached &&
    !c.timeCapReached;
  return { ...c, sitemapExhausted, complete };
}

/** Incompletezza strutturale → mai HOT/PUBLISHED terminali. */
export function crawlBlocksTerminalVerdict(c: CrawlCompleteness | null | undefined): string | null {
  if (!c) return "CrawlCompleteness assente — impossibile certificare.";
  if (c.complete) return null;
  const reasons: string[] = [];
  if (!c.identityVerified) reasons.push("identità sito non verificata");
  if (!c.htmlQueueExhausted) reasons.push("coda HTML non esaurita");
  if (!sitemapStatusAllowsHot(c.sitemapStatus)) {
    reasons.push(`sitemap ${c.sitemapStatus}`);
  }
  if (!c.relevantDocumentsProcessed) reasons.push("documenti rilevanti non tutti processati");
  if (c.unresolvedRelevantUrls > 0) reasons.push(`${c.unresolvedRelevantUrls} URL rilevanti irrisolti`);
  if (c.failedRelevantUrls > 0) reasons.push(`${c.failedRelevantUrls} URL rilevanti falliti`);
  if (c.unreadableRelevantDocuments > 0) reasons.push(`${c.unreadableRelevantDocuments} PDF illeggibili`);
  if (c.criticalOcrDoubts > 0) reasons.push("OCR critico incerto");
  if (c.urlCapReached) reasons.push("cap URL raggiunto (≠ crawl completo)");
  if (c.timeCapReached) reasons.push("cap tempo raggiunto");
  if (!c.jsonEndpointsProcessed) reasons.push("JSON non tutti processati");
  if (!c.sameHostScriptsProcessed) reasons.push("script same-host non tutti processati");
  if (!c.relevantLinksProcessed) reasons.push("link rilevanti non tutti processati");
  return `Crawl incompleto: ${reasons.join("; ") || "gate falliti"}.`;
}

export interface SourceCoverage {
  sourceId: string;
  sourceName: string;
  region: "CAMPANIA" | "VENETO";
  sourceUrl: string;
  sourceVersion?: string;
  sourcePublishedAt?: string;
  retrievedAt: string;
  pagesExpected?: number;
  pagesProcessed: number;
  rawRecords: number;
  parsedRecords: number;
  uniqueFacilitiesAdded: number;
  duplicatesMatched: number;
  exclusions: number;
  unresolvedRecords: number;
  failures: number;
  checkpoint?: string;
  completed: boolean;
}

export type CommercialTier = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "NOT_ACTIONABLE";

export interface CommercialOpportunity {
  score: number;
  tier: CommercialTier;
  reasons: string[];
  verifiedFacts: string[];
  inferences: string[];
  missingInformation: string[];
  recommendedAction: string;
  urgencyReason?: string;
}

export function commercialTierFromScore(score: number): CommercialTier {
  if (score <= 0) return "NOT_ACTIONABLE";
  if (score >= 85) return "VERY_HIGH";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MEDIUM";
  return "LOW";
}

/** Marker serializzabile in evidence string (compat DB senza migrazione). */
export const EVIDENCE_JSON_MARKER = "[EVIDENCE_JSON:";

export function appendEvidenceJson(evidenceBody: string, payload: unknown): string {
  const json = JSON.stringify(payload);
  const cleaned = evidenceBody.replace(/\s*\[EVIDENCE_JSON:[\s\S]*?\]\s*$/i, "").trim();
  return `${cleaned} ${EVIDENCE_JSON_MARKER}${json}]`.trim();
}

export function parseEvidenceJson<T = unknown>(evidence: string | null | undefined): T | null {
  if (!evidence) return null;
  const m = evidence.match(/\[EVIDENCE_JSON:([\s\S]*?)\]\s*$/i);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
