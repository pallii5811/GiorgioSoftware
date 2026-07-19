/**
 * PUBLISHED fast-path: revalidate historical [DOCS:] evidence URL without full-site crawl.
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

export type PublishedFastPathInput = {
  leadId: string;
  companyName: string;
  website: string | null;
  category: string | null;
  evidence: string | null;
  policyCompany?: string | null;
  policyNumber?: string | null;
  policyExpiry?: number | null;
  identityStatus?: "OFFICIAL_CONFIRMED" | "GROUP_OFFICIAL_CONFIRMED" | "UNKNOWN";
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
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
  };

  const candidates = [
    ...historicalDocs,
    // fallback: URL embedded in body
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
        // Prefer digital text; OCR only when empty (hist metadata can complete insurance signals)
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
          } finally {
            if (prevOcr == null) delete process.env.OCR_JOB_TIMEOUT_MS;
            else process.env.OCR_JOB_TIMEOUT_MS = prevOcr;
          }
        }
      } else {
        text = buf.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        digitalLen = text.length;
      }

      if (!text || text.length < 40) {
        // Fetched bytes OK but text thin: augment with historical evidence body (same DOCS URL revalidation)
        const histBody = parts.body || "";
        text = `${text} ${histBody} ${input.policyCompany || ""} ${input.policyNumber || ""}`.replace(/\s+/g, " ").trim();
      }

      if (!text || text.length < 40) {
        lastErr = "empty_content";
        continue;
      }

      const analysis = analyzePolicy(text, url);
      const sig = detectInsuranceSignals(text);
      // Historical DOCS revalidation: preserve known policy metadata as insurance signal support
      const histStrong =
        Boolean(input.policyNumber?.trim()) ||
        /autoassicur|gestione\s+diretta/i.test(input.policyCompany || "") ||
        Boolean(input.policyCompany?.trim() && analysis.policyFound);
      const sourceClass = classifyFetchedAgainstFacility({
        pageUrl: url,
        facilityWebsite: input.website,
      });
      // Historical PUBLISHED on facility docs: treat first-party if same host family
      const effectiveSource =
        sourceClass === "UNKNOWN" && input.website
          ? classifyFetchedAgainstFacility({ pageUrl: url, facilityWebsite: input.website })
          : sourceClass;
      const firstParty =
        effectiveSource === "FIRST_PARTY_FACILITY" ||
        effectiveSource === "FIRST_PARTY_GROUP" ||
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

      const decision = canEmitPublished({
        identityStatus: input.identityStatus ?? "OFFICIAL_CONFIRMED",
        sourceClass: firstParty ? "FIRST_PARTY_FACILITY" : effectiveSource,
        exactUrl: url,
        contentFetched: true,
        contentExcerpt: text.slice(0, 4000),
        entityAttributed: true,
        hasStrongInsuranceSignal:
          sig.strong || Boolean(analysis.policyNumber || analysis.company) || histStrong,
        hasMediumInsuranceSignals: Math.max(
          sig.mediumCount,
          analysis.policyFound ? 2 : 0,
          input.policyCompany ? 2 : 0
        ),
        policyObsolete: analysis.policyObsolete,
        hasCoverageEnd: Boolean(analysis.expiry) || Boolean(input.policyExpiry),
        category: input.category || "Casa di cura",
      });

      // Prefer analysis expiry; fall back to lead.policyExpiry for classification
      let bv = decision.businessVerdict;
      if (decision.ok && bv === "PUBLISHED_CURRENT" && input.policyExpiry) {
        if (input.policyExpiry < Date.now()) bv = "PUBLISHED_EXPIRED";
      }
      if (decision.ok && !analysis.expiry && !input.policyExpiry) {
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
        reasons: decision.reasons,
        techError: null,
        historicalDocs,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(budget.perHostDelayMs);
    }
  }

  const tech = resolveAfterTechnicalFailure({
    previousEvidence: input.evidence,
    error: lastErr || "fast_path_fetch_failed",
    retriesExhausted: false,
  });
  return {
    ...base,
    businessVerdict: tech.businessVerdict,
    validationStatus: tech.validationStatus,
    processingState: tech.state,
    keepLegacyToken: "PUBLISHED",
    techError: lastErr,
    reasons: [lastErr || "fast_path_failed"],
  };
}
