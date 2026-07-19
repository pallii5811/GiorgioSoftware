/**
 * finalizeVerdict — server-side HOT gate (non importare da client components).
 */
import type { CrawlCompleteness } from "@/lib/evidence/contract";
import {
  canEmitHot,
  explainCanEmitHot,
  MIN_PAGES_FOR_HOT,
} from "@/lib/sanita/can-emit-hot";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import type { Verdict } from "@/lib/sanita/verdict";

export { MIN_PAGES_FOR_HOT };

export type FinalizeVerdictInput = {
  verdict: Verdict;
  evidenceBody: string;
  pagesVisited: number;
  websiteReachable: boolean | null;
  website: string | null;
  policyCompany?: string | null;
  policyExpiry?: Date | null;
  policyObsolete?: boolean;
  policyExhaustive?: boolean;
  needsOcrReview?: boolean;
  crawlCompleteness?: CrawlCompleteness | null;
  identityStatus?: IdentityStatus | "UNKNOWN" | null;
  category?: string | null;
};

/**
 * Ultimo gate prima del DB: HOT solo via canEmitHot.
 * Incompletezza tecnica → REVIEW + RETRY_PENDING hint.
 */
export function finalizeVerdict(input: FinalizeVerdictInput): {
  verdict: Verdict;
  evidenceBody: string;
  downgraded: boolean;
  processingHint: "RETRY_PENDING" | "REVIEW_HUMAN" | null;
} {
  let verdict = input.verdict;
  let evidenceBody = input.evidenceBody;

  if (
    verdict === "HOT" &&
    input.policyObsolete &&
    (input.policyCompany || input.policyExpiry || /polizza\s+rc\s+pubblicata|scaduta\s+da/i.test(evidenceBody))
  ) {
    verdict = "PUBLISHED";
    return { verdict, evidenceBody, downgraded: false, processingHint: null };
  }

  if (verdict !== "HOT") return { verdict, evidenceBody, downgraded: false, processingHint: null };

  const hotEv = {
    website: input.website,
    websiteReachable: input.websiteReachable,
    pagesVisited: input.pagesVisited,
    policyExhaustive: input.policyExhaustive === true,
    needsOcrReview: Boolean(input.needsOcrReview),
    crawlCompleteness: input.crawlCompleteness ?? null,
    identityStatus: input.identityStatus ?? "UNKNOWN",
    category: input.category,
  };

  if (!canEmitHot(hotEv)) {
    const { reasons } = explainCanEmitHot(hotEv);
    const tech = reasons.some((r) =>
      /OCR|incompleto|cap |URL rilevanti|PDF|JSON|script|sitemap|esaustiv|pagine insufficienti/i.test(r)
    );
    const identityHuman = reasons.some((r) =>
      /identità non terminale|categoria sanitaria assente|sito assente/i.test(r)
    );
    const hint = tech && !identityHuman ? ("RETRY_PENDING" as const) : ("REVIEW_HUMAN" as const);
    evidenceBody = `HOT bloccato (canEmitHot): ${reasons.join("; ")}. ${evidenceBody}`;
    return {
      verdict: "REVIEW",
      evidenceBody,
      downgraded: true,
      processingHint: hint,
    };
  }
  return { verdict, evidenceBody, downgraded: false, processingHint: null };
}
