import type { CrawlResult } from "@/lib/sanita/crawler";
import { analyzePolicy, type PolicyAnalysis } from "@/lib/sanita/detector";
import { crawlDepthSufficient, validateSiteIdentity } from "@/lib/sanita/site-identity";
import type { Verdict } from "@/lib/sanita/verdict";

export type ReconcileContext = {
  companyName: string;
  website: string;
  city?: string | null;
  /** Sito e nome dalla stessa scheda Google Maps — niente controllo omonimia OSM. */
  mapsVerified?: boolean;
};

const POLICY_HINT =
  /polizz|assicuraz|art\.?\s*10|legge\s*gelli|responsabilit[aà]\s*civile|massimale|rco\b|rct\b|risarcimenti-erogat|berkshire|generali|accelerant/i;

/** Scansione multi-pass del corpus crawl — massimizza recall polizza (zero falsi HOT). */
export function deepScanCrawlForPolicy(crawl: CrawlResult): PolicyAnalysis {
  const sources: string[] = [];
  if (crawl.policyText?.trim()) sources.push(crawl.policyText);
  if (crawl.text?.trim()) sources.push(crawl.text);
  const merged = sources.join("\n");

  // Pass 0: il PDF che ha trovato la polizza è la fonte più affidabile
  // (compagnia, scadenza, massimale estratti dal documento stesso).
  if (crawl.policyPdfAnalysis?.policyFound) {
    return backfillPolicyData(crawl.policyPdfAnalysis, merged);
  }

  // Pass 1: corpus dedicato Trasparenza
  for (const src of sources) {
    const a = analyzePolicy(src);
    if (a.policyFound) return backfillPolicyData(a, merged);
  }

  // Pass 2: corpus merge
  if (merged.length > 100) {
    const a = analyzePolicy(merged);
    if (a.policyFound) return a;
  }

  // Pass 3: finestre scorrevoli sul testo lungo (polizza in sezione HTML non taggata)
  const hay = merged;
  if (hay.length > 4000) {
    const win = 8000;
    for (let i = 0; i < hay.length; i += win / 2) {
      const slice = hay.slice(i, i + win);
      if (!POLICY_HINT.test(slice)) continue;
      const a = analyzePolicy(slice);
      if (a.policyFound) return backfillPolicyData(a, merged);
    }
  }

  return analyzePolicy(policyTextFromCrawl(crawl));
}

/** Se l'analisi vincente non ha scadenza/massimale, prova a recuperarli dal corpus completo. */
function backfillPolicyData(a: PolicyAnalysis, corpus: string): PolicyAnalysis {
  if (corpus.length < 80) return a;
  const full = analyzePolicy(corpus);
  return {
    ...a,
    expiry: a.expiry ?? full.expiry,
    massimale: a.massimale ?? full.massimale,
    policyNumber: a.policyNumber ?? full.policyNumber,
    company: a.company ?? full.company,
    confidence: a.policyFound || full.policyFound ? 1 : a.confidence,
  };
}

/** Arricchisce metadati polizza dal corpus crawl completo (PDF + HTML Trasparenza). */
function enrichPublishedAnalysis(analysis: PolicyAnalysis, crawl: CrawlResult): PolicyAnalysis {
  const corpus = [crawl.policyText, crawl.text].filter(Boolean).join("\n");
  let a = backfillPolicyData(analysis, corpus);
  const pdf = crawl.policyPdfAnalysis;
  if (pdf?.policyFound) {
    a = {
      ...a,
      expiry: a.expiry ?? pdf.expiry,
      massimale: a.massimale ?? pdf.massimale,
      policyNumber: a.policyNumber ?? pdf.policyNumber,
      company: a.company ?? pdf.company,
    };
  }
  return { ...a, policyFound: true, confidence: 1 };
}

/** Testo usato SOLO per il verdetto Gelli — mai homepage/contatti generici. */
export function policyTextFromCrawl(crawl: CrawlResult): string {
  const pt = crawl.policyText?.trim();
  if (pt && pt.length >= 80) return pt;
  return crawl.text;
}

export function analyzeCrawlPolicy(crawl: CrawlResult): PolicyAnalysis {
  return deepScanCrawlForPolicy(crawl);
}

/** Evidenza sufficiente per PUBLISHED certo (no falsi positivi). Scadenza opzionale. */
function publicationIsCertain(analysis: PolicyAnalysis, crawl: CrawlResult): boolean {
  if (!analysis.policyFound || analysis.policyObsolete) return false;
  if (crawl.policyPdfAnalysis?.policyFound) return true;
  if (/autoassicuraz|gestione\s+diretta/i.test(analysis.company ?? "")) return true;
  const hasInsurer = Boolean(analysis.company);
  const hasConcrete = Boolean(analysis.massimale || analysis.policyNumber || analysis.expiry);
  if (hasInsurer && hasConcrete) return true;
  if (hasInsurer && crawl.foundRelevantPage) return true;
  if (analysis.massimale && crawl.foundRelevantPage && /art\.?\s*10|gelli|legge\s*24/i.test(crawl.policyText || ""))
    return true;
  return false;
}

export type ReconcileResult = {
  verdict: Verdict;
  analysis: PolicyAnalysis;
  adjusted: boolean;
  note: string | null;
};

/**
 * Unico gate per il verdetto sito.
 * REGOLA: polizza trovata → PUBLISHED. Assenza certificata → HOT. Altro → REVIEW.
 * HOT non esce MAI da verdictFromSite — solo da qui dopo crawl esaustivo.
 */
export function reconcilePolicyVerdict(
  crawl: CrawlResult,
  analysisIn: PolicyAnalysis,
  _verdictIn: Verdict,
  ctx?: ReconcileContext
): ReconcileResult {
  let note: string | null = null;

  if (!crawl.ok) {
    return {
      verdict: "REVIEW",
      analysis: analysisIn,
      adjusted: true,
      note: "Sito non raggiungibile — impossibile verificare polizza.",
    };
  }

  // ── PASSO 1: trova polizza ovunque (priorità assoluta) ──
  const analysis = deepScanCrawlForPolicy(crawl);
  if (analysis.policyFound) {
    const enriched = enrichPublishedAnalysis(analysis, crawl);
    if (!publicationIsCertain(enriched, crawl)) {
      return {
        verdict: "REVIEW",
        analysis: enriched,
        adjusted: true,
        note: "Riferimenti assicurativi deboli — verifica manuale prima di considerare in regola.",
      };
    }
    return {
      verdict: "PUBLISHED",
      analysis: enriched,
      adjusted: true,
      note: "Polizza RC certificata su sito (Trasparenza/PDF/HTML).",
    };
  }

  // ── PASSO 2: prerequisiti per certificare ASSENZA polizza (HOT) ──
  const gates: string[] = [];

  if (!crawl.foundRelevantPage) {
    gates.push("sezione Trasparenza/polizza non trovata");
  }
  if (crawl.policyPdfsQueued > crawl.policyPdfsRead) {
    gates.push(`ERRORE CRAWL: ${crawl.policyPdfsQueued - crawl.policyPdfsRead} PDF non processati`);
  }
  if (crawl.needsOcrReview) {
    gates.push("PDF scannerizzato non decodificabile — OCR insufficiente");
  }
  if (!crawl.policyExhaustive) {
    gates.push(`crawl incompleto (${crawl.policyPdfsRead}/${crawl.policyPdfsQueued} PDF)`);
  }

  // Sempre: Maps può associare il sito dell'ente padre (es. fapc.it) alla singola RSA.
  if (ctx) {
    const identity = validateSiteIdentity(ctx.companyName, ctx.website, crawl, ctx.city);
    if (!identity.ok) gates.push(identity.reason);
    else {
      const depth = crawlDepthSufficient(crawl);
      if (!depth.ok) gates.push(depth.reason);
    }
  }

  if (POLICY_HINT.test(crawl.text) && !crawl.foundRelevantPage) {
    gates.push("riferimenti polizza in homepage ma Trasparenza non visitata");
  }

  if (gates.length === 0) {
    return {
      verdict: "HOT",
      analysis,
      adjusted: true,
      note: "Assenza polizza certificata: sito corretto, Trasparenza visitata, tutti i PDF analizzati.",
    };
  }

  return {
    verdict: "REVIEW",
    analysis,
    adjusted: true,
    note: `Impossibile certificare assenza polizza: ${gates.join("; ")}.`,
  };
}
