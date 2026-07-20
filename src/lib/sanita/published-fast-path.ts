/**
 * PUBLISHED fast-path: revalidate historical [DOCS:] evidence URL without full-site crawl.
 * Historical metadata MUST NOT certify an unrelated / non-insurance document.
 */
import { createHash } from "node:crypto";
import { externalFetch } from "@/lib/http";
import { parseEvidenceSections } from "@/lib/sanita/audit";
import { canEmitPublished, detectInsuranceSignals } from "@/lib/sanita/can-emit-published";
import { classifyFetchedAgainstFacility } from "@/lib/sanita/source-class";
import { extractPdfFullText } from "@/lib/sanita/ocr";
import { analyzePolicy } from "@/lib/sanita/detector";
import {
  resolveAfterTechnicalFailure,
  type BusinessVerdict,
  type ValidationStatus,
  type SanitaProcessingState,
} from "@/lib/sanita/processing-state";
import { readCrawlBudgetConfig } from "@/lib/sanita/crawl-budget";
import { classifyNegativeInsuranceDocument } from "@/lib/sanita/negative-document";
import { canAttributeEntity, extractDocumentEntityFingerprint, buildFacilityFingerprint, type EntityFingerprint } from "@/lib/sanita/entity-fingerprint";

export type PublishedFastPathInput = {
  leadId: string;
  companyName: string;
  website: string | null;
  category: string | null;
  evidence: string | null;
  policyCompany?: string | null;
  policyNumber?: string | null;
  policyExpiry?: number | null;
  /** Only when derived from real identity engine — never default OFFICIAL_CONFIRMED. */
  identityStatus?: "OFFICIAL_CONFIRMED" | "GROUP_OFFICIAL_CONFIRMED" | "UNKNOWN" | "INSUFFICIENT";
  city?: string | null;
  phone?: string | null;
  piva?: string | null;
  facilityFingerprint?: EntityFingerprint;
};

export type PublishedFastPathResult = {
  contentAcquired: boolean;
  exactUrl: string | null;
  contentHash: string | null;
  excerpt: string;
  digitalLen: number;
  ocrLen: number;
  ocrUsed: boolean;
  analysis: ReturnType<typeof analyzePolicy>;
  publishedOk: boolean;
  businessVerdict: BusinessVerdict | null;
  validationStatus: ValidationStatus;
  processingState: SanitaProcessingState;
  keepLegacyToken: "PUBLISHED" | null;
  reasons: string[];
  techError: string | null;
  historicalDocs: string[];
  negativeKind: string | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function facilityFp(input: PublishedFastPathInput): EntityFingerprint {
  if (input.facilityFingerprint) return input.facilityFingerprint;
  return buildFacilityFingerprint({
    companyName: input.companyName,
    city: input.city,
    phone: input.phone,
    piva: input.piva,
    website: input.website,
  });
}

export async function runPublishedFastPath(
  input: PublishedFastPathInput
): Promise<PublishedFastPathResult> {
  const budget = readCrawlBudgetConfig();
  const parts = parseEvidenceSections(input.evidence);
  const historicalDocs = parts.docs ?? [];
  const base: PublishedFastPathResult = {
    contentAcquired: false,
    exactUrl: null,
    contentHash: null,
    excerpt: "",
    digitalLen: 0,
    ocrLen: 0,
    ocrUsed: false,
    analysis: analyzePolicy(""),
    publishedOk: false,
    businessVerdict: null,
    validationStatus: "REVALIDATION_PENDING",
    processingState: "RETRY_PENDING",
    keepLegacyToken: "PUBLISHED",
    reasons: [],
    techError: null,
    historicalDocs,
    negativeKind: null,
  };

  const candidates = [
    ...historicalDocs,
    ...((input.evidence || "").match(/https?:\/\/[^\s\]]+\.pdf/gi) ?? []),
  ].filter(Boolean);

  if (candidates.length === 0) {
    base.reasons.push("nessun URL storico [DOCS:]");
    const tech = resolveAfterTechnicalFailure({
      previousEvidence: input.evidence,
      error: "no_historical_docs_url",
      retriesExhausted: false,
    });
    return {
      ...base,
      businessVerdict: tech.businessVerdict,
      validationStatus: tech.validationStatus,
      processingState: tech.state,
      keepLegacyToken: tech.keepLegacyToken === "PUBLISHED" ? "PUBLISHED" : "PUBLISHED",
      techError: "no_historical_docs_url",
    };
  }

  const facility = facilityFp(input);
  let lastErr: string | null = null;

  for (const rawUrl of candidates) {
    const url = rawUrl.trim();
    try {
      const res = await externalFetch(url, {
        timeoutMs: /\.pdf/i.test(url) ? budget.pdfFetchTimeoutMs : budget.httpRequestTimeoutMs,
        redirect: "follow",
      });
      if (!res.ok) {
        lastErr = `http_${res.status}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash("sha256").update(buf).digest("hex");
      let text = "";
      let digitalLen = 0;
      let ocrLen = 0;
      let ocrUsed = false;

      if (/\.pdf/i.test(url) || (res.headers.get("content-type") || "").includes("pdf")) {
        let digital = "";
        try {
          const { PDFParse } = await import("pdf-parse");
          const parser = new PDFParse({ data: buf });
          try {
            const result = await parser.getText();
            digital = (result?.text || "").replace(/\s+/g, " ").trim();
          } finally {
            await parser.destroy().catch(() => {});
          }
        } catch {
          digital = "";
        }
        digitalLen = digital.length;
        text = digital;
        if (digitalLen < 80) {
          process.env.OCR_ENABLED = "1";
          const prevOcr = process.env.OCR_JOB_TIMEOUT_MS;
          process.env.OCR_JOB_TIMEOUT_MS = String(Math.min(budget.ocrTimeoutMs, 90_000));
          try {
            const extracted = await extractPdfFullText(buf);
            digitalLen = extracted.digital?.length || digitalLen;
            ocrLen = extracted.ocr?.length || 0;
            ocrUsed = Boolean(extracted.ocr && digitalLen < 200);
            text = extracted.text || extracted.digital || extracted.ocr || digital;
            if (
              extracted.status === "OCR_RENDERER_MISSING" ||
              extracted.status === "OCR_TIMEOUT" ||
              extracted.status === "OCR_EXTRACTION_FAILED"
            ) {
              const exhausted = extracted.status === "OCR_RENDERER_MISSING";
              const tech = resolveAfterTechnicalFailure({
                previousEvidence: input.evidence,
                error: extracted.reasonCode || extracted.status,
                retriesExhausted: exhausted,
              });
              return {
                ...base,
                contentAcquired: false,
                exactUrl: url,
                contentHash: hash,
                excerpt: text.slice(0, 500),
                digitalLen,
                ocrLen,
                ocrUsed,
                analysis: analyzePolicy(text, url),
                publishedOk: false,
                businessVerdict: tech.businessVerdict,
                validationStatus: "TECHNICAL_BLOCKED",
                processingState: "TECHNICAL_BLOCKED",
                keepLegacyToken: tech.keepLegacyToken === "PUBLISHED" ? "PUBLISHED" : null,
                reasons: [extracted.reasonCode || extracted.status],
                techError: extracted.reasonCode || extracted.status,
                negativeKind: null,
              };
            }
          } finally {
            if (prevOcr == null) delete process.env.OCR_JOB_TIMEOUT_MS;
            else process.env.OCR_JOB_TIMEOUT_MS = prevOcr;
          }
        }
      } else {
        text = buf.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        digitalLen = text.length;
      }

      // Current document only — do NOT inject historical policyCompany/policyNumber into text
      if (!text || text.length < 40) {
        lastErr = "empty_content";
        continue;
      }

      const negative = classifyNegativeInsuranceDocument(text, url);
      if (negative.blocked) {
        return {
          ...base,
          contentAcquired: true,
          exactUrl: url,
          contentHash: hash,
          excerpt: text.slice(0, 2000),
          digitalLen,
          ocrLen,
          ocrUsed,
          analysis: analyzePolicy(text, url),
          publishedOk: false,
          businessVerdict: null,
          validationStatus: "CONFLICT_FOUND",
          processingState: "REVIEW_HUMAN",
          keepLegacyToken: "PUBLISHED",
          reasons: [...negative.reasons, "documento_non_assicurativo"],
          techError: null,
          negativeKind: negative.kind,
        };
      }

      const analysis = analyzePolicy(text, url);
      const sig = detectInsuranceSignals(text);
      // Strong signal must come from CURRENT document body — not historical lead fields alone
      const currentStrong =
        sig.strong ||
        Boolean(analysis.policyNumber?.trim()) ||
        (Boolean(analysis.company?.trim()) && /rct|rco|polizza|assicur/i.test(text));

      const sourceClass = classifyFetchedAgainstFacility({
        pageUrl: url,
        facilityWebsite: input.website,
      });
      const firstParty =
        sourceClass === "FIRST_PARTY_FACILITY" ||
        sourceClass === "FIRST_PARTY_GROUP" ||
        (input.website &&
          (() => {
            try {
              const a = new URL(url).hostname.replace(/^www\./i, "");
              const b = new URL(input.website!).hostname.replace(/^www\./i, "");
              return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
            } catch {
              return false;
            }
          })());

      const docFp = extractDocumentEntityFingerprint(text, { title: url }, url);
      const attr = canAttributeEntity(docFp, facility);
      const identityStatus =
        input.identityStatus === "OFFICIAL_CONFIRMED" ||
        input.identityStatus === "GROUP_OFFICIAL_CONFIRMED"
          ? input.identityStatus
          : "INSUFFICIENT";

      const decision = canEmitPublished({
        identityStatus,
        sourceClass: firstParty ? "FIRST_PARTY_FACILITY" : sourceClass,
        exactUrl: url,
        contentFetched: true,
        contentExcerpt: text.slice(0, 4000),
        entityAttributed: attr.ok,
        hasStrongInsuranceSignal: currentStrong,
        hasMediumInsuranceSignals: sig.mediumCount,
        policyObsolete: analysis.policyObsolete,
        hasCoverageEnd: Boolean(analysis.expiry),
        category: input.category || "Casa di cura",
      });

      let bv = decision.businessVerdict;
      if (decision.ok && bv === "PUBLISHED_CURRENT" && analysis.expiry) {
        if (analysis.expiry.getTime() < Date.now()) bv = "PUBLISHED_EXPIRED";
      }
      if (decision.ok && !analysis.expiry) {
        bv = "PUBLISHED_DATE_UNKNOWN";
      }

      return {
        contentAcquired: true,
        exactUrl: url,
        contentHash: hash,
        excerpt: text.slice(0, 2000),
        digitalLen,
        ocrLen,
        ocrUsed,
        analysis,
        publishedOk: decision.ok,
        businessVerdict: decision.ok ? bv : null,
        validationStatus: decision.ok ? "CURRENT_VERIFIED" : "CONFLICT_FOUND",
        processingState: decision.ok
          ? bv === "PUBLISHED_EXPIRED"
            ? "PUBLISHED_EXPIRED"
            : bv === "PUBLISHED_DATE_UNKNOWN"
              ? "PUBLISHED_DATE_UNKNOWN"
              : "PUBLISHED_CURRENT"
          : "REVIEW_HUMAN",
        keepLegacyToken: "PUBLISHED",
        reasons: decision.ok ? decision.reasons : [...decision.reasons, ...attr.reasons],
        techError: null,
        historicalDocs,
        negativeKind: null,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(50);
    }
  }

  const tech = resolveAfterTechnicalFailure({
    previousEvidence: input.evidence,
    error: lastErr || "fetch_failed",
    retriesExhausted: false,
  });
  return {
    ...base,
    businessVerdict: tech.businessVerdict,
    validationStatus: tech.validationStatus,
    processingState: tech.state,
    keepLegacyToken: "PUBLISHED",
    reasons: [lastErr || "fetch_failed"],
    techError: lastErr,
  };
}
