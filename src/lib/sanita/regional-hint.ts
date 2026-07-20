/**
 * Regional cross-check hints — captured early, applied after final frontier completeness.
 */
import type { RegionalCheckResult } from "@/lib/sanita/regional-check";
import type { Verdict } from "@/lib/sanita/verdict";

export type RegionalHintCapture = {
  regionalChecked: boolean;
  regionalPolicyFound: boolean;
  regionalEvidence: string | null;
  regionalSourceUrls: string[];
};

export function captureRegionalHint(regional: RegionalCheckResult): RegionalHintCapture {
  return {
    regionalChecked: regional.checked,
    regionalPolicyFound: regional.policyFound,
    regionalEvidence: regional.evidence,
    regionalSourceUrls: regional.sourceUrls,
  };
}

/** Host istituzionali regionali/ASL — esclude blog commerciali e approfondimenti generici. */
const INSTITUTIONAL_SOURCE =
  /(?:regione\.(?:campania|veneto)\.it|soresa\.it|asl[a-z0-9.-]+\.it|aulss\d+\.veneto\.it|aziendazero\.it)/i;

/** Official insurance document attributed on regional/ASL portal (not a generic mention). */
export function isOfficialRegionalPolicyDocument(regional: RegionalCheckResult): boolean {
  if (!regional.policyFound) return false;

  const urls = regional.sourceUrls ?? [];
  const institutional = urls.some((u) => INSTITUTIONAL_SOURCE.test(u));
  const structuredProof = Boolean(
    regional.company?.trim() || regional.policyNumber?.trim() || regional.expiry
  );

  if (structuredProof && institutional) return true;

  const ev = regional.evidence || "";
  if (
    institutional &&
    /documento\s+ufficial|estremi\s+(?:di\s+)?polizza|polizza\s+rc\s+n\.|n\.?\s*\d+\/\d+/i.test(ev)
  ) {
    return true;
  }

  return false;
}

export type RegionalVerdictAdjustment = {
  verdict: Verdict;
  evidenceAppend: string | null;
  humanConflict: boolean;
};

/**
 * Apply regional hint AFTER identity + waterfall + deriveCrawlCompleteness final.
 */
export function applyRegionalHintAfterFinalCompleteness(opts: {
  candidateVerdict: Verdict;
  policyFoundOnSite: boolean;
  policyObsolete: boolean;
  identityVerified: boolean;
  finalComplete: boolean;
  hint: RegionalHintCapture | null;
  regionalFull: RegionalCheckResult | null;
}): RegionalVerdictAdjustment {
  const hint = opts.hint;
  if (!hint?.regionalChecked || !opts.regionalFull) {
    return { verdict: opts.candidateVerdict, evidenceAppend: null, humanConflict: false };
  }

  if (isOfficialRegionalPolicyDocument(opts.regionalFull) && !opts.policyFoundOnSite) {
    return {
      verdict: "REVIEW",
      evidenceAppend: `Documento assicurativo su portale regionale/ASL attribuito alla struttura — conflitto con assenza first-party. ${hint.regionalEvidence || ""}`.trim(),
      humanConflict: true,
    };
  }

  if (
    opts.candidateVerdict === "HOT" &&
    !opts.policyFoundOnSite &&
    !opts.policyObsolete &&
    opts.identityVerified &&
    opts.finalComplete
  ) {
    if (hint.regionalPolicyFound) {
      return {
        verdict: "HOT",
        evidenceAppend:
          "Possibile polizza rilevata su portale regionale, ma non pubblicata sul sito first-party completamente analizzato. " +
          (hint.regionalEvidence || ""),
        humanConflict: false,
      };
    }
    if (hint.regionalChecked) {
      return {
        verdict: "HOT",
        evidenceAppend:
          "Portali ASL/regionali consultati: assenza pubblicazione confermata. " +
          (hint.regionalEvidence || opts.regionalFull.evidence || ""),
        humanConflict: false,
      };
    }
  }

  if (hint.regionalPolicyFound && !opts.finalComplete) {
    return {
      verdict: opts.candidateVerdict === "HOT" ? "REVIEW" : opts.candidateVerdict,
      evidenceAppend: `Hint regionale non bloccante ma crawl first-party incompleto. ${hint.regionalEvidence || ""}`.trim(),
      humanConflict: false,
    };
  }

  if (hint.regionalPolicyFound && opts.candidateVerdict === "HOT" && !opts.finalComplete) {
    return { verdict: "REVIEW", evidenceAppend: hint.regionalEvidence, humanConflict: false };
  }

  if (hint.regionalPolicyFound && opts.candidateVerdict !== "HOT") {
    return {
      verdict: "REVIEW",
      evidenceAppend: `Portale regionale/ASL: possibile polizza ma PDF RC non sul sito — verifica manuale. ${hint.regionalEvidence || ""}`,
      humanConflict: true,
    };
  }

  return { verdict: opts.candidateVerdict, evidenceAppend: null, humanConflict: false };
}
