/**
 * Unico gate HOT — nessun altro modulo può certificare assenza Art.10.
 * Fail-closed: qualsiasi dubbio → false.
 * Completeness deve derivare dal frontier DB quando richiesto.
 */
import {
  crawlBlocksTerminalVerdict,
  type CrawlCompleteness,
} from "@/lib/evidence/contract";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";
import {
  frontierBlocksHot,
  type CrawlFrontierLedger,
} from "@/lib/sanita/crawl-frontier-ledger";
import { deriveCrawlCompleteness, getCrawlRun } from "@/lib/sanita/frontier-store";

export const MIN_PAGES_FOR_HOT = 12;

export type HotEmitEvidence = {
  website: string | null | undefined;
  websiteReachable: boolean | null | undefined;
  pagesVisited: number;
  policyExhaustive: boolean;
  needsOcrReview: boolean;
  /** Solo se requirePersistedCompleteness=false (legacy unit tests). */
  crawlCompleteness?: CrawlCompleteness | null | undefined;
  identityStatus?: IdentityStatus | "UNKNOWN" | null;
  category?: string | null;
  frontier?: CrawlFrontierLedger | null;
  /** Run persistita — obbligatoria per HOT produzione. */
  crawlRunId?: string | null;
  /** Se true, completeness SOLO da deriveCrawlCompleteness(crawlRunId). */
  requirePersistedCompleteness?: boolean;
};

export type HotEmitResult = {
  ok: boolean;
  reasons: string[];
};

export function canEmitHot(evidence: HotEmitEvidence): boolean {
  return explainCanEmitHot(evidence).ok;
}

export function explainCanEmitHot(evidence: HotEmitEvidence): HotEmitResult {
  const reasons: string[] = [];

  if (!evidence.website?.trim()) reasons.push("sito assente");
  if (evidence.websiteReachable === false) reasons.push("sito non raggiungibile");
  if (evidence.websiteReachable == null && evidence.website?.trim()) {
    reasons.push("raggiungibilità sito sconosciuta");
  }

  const id = evidence.identityStatus ?? "UNKNOWN";
  if (id !== "OFFICIAL_CONFIRMED" && id !== "GROUP_OFFICIAL_CONFIRMED") {
    reasons.push(`identità non terminale (${id})`);
  }

  if (!evidence.category?.trim()) reasons.push("categoria sanitaria assente");

  if (evidence.pagesVisited < MIN_PAGES_FOR_HOT) {
    reasons.push(`pagine insufficienti (${evidence.pagesVisited}/${MIN_PAGES_FOR_HOT})`);
  }
  if (evidence.needsOcrReview) reasons.push("OCR critico incerto / PDF illeggibile");
  if (evidence.policyExhaustive !== true) reasons.push("crawl non esaustivo");

  let completeness: CrawlCompleteness | null | undefined = evidence.crawlCompleteness;

  if (evidence.requirePersistedCompleteness || evidence.crawlRunId) {
    if (!evidence.crawlRunId) {
      reasons.push("crawlRunId assente — HOT richiede frontier persistita");
    } else {
      const run = getCrawlRun(evidence.crawlRunId);
      if (!run) reasons.push("crawl run non trovata nel frontier store");
      completeness = deriveCrawlCompleteness(evidence.crawlRunId);
      if (run && String(run.state) !== "COMPLETED" && !completeness.complete) {
        reasons.push(`crawl run non COMPLETED (${run.state})`);
      }
    }
  }

  const block = crawlBlocksTerminalVerdict(completeness ?? null);
  if (block) reasons.push(block);

  if (evidence.frontier !== undefined) {
    const fb = frontierBlocksHot(evidence.frontier);
    if (fb) reasons.push(fb);
  }

  return { ok: reasons.length === 0, reasons };
}
