import { isSiteUnderMaintenance } from "@/lib/sanita/website";
import {
  analyzePolicy,
  isAccountingOrBalanceSheetText,
  isGelliComplianceReportPdf,
  isGelliComplianceReportOnly,
  isGelliComplianceReportText,
  isParmRcInsuranceDisclosure,
  type PolicyAnalysis,
} from "@/lib/sanita/detector";
import {
  companyNameOnSite,
  crawlDepthSufficient,
  crawlHostMatchesWebsite,
  validateSiteIdentity,
} from "@/lib/sanita/site-identity";
import { hostBrandMatchesName } from "@/lib/sanita/contacts";
import { pickPolicyPdfUrl } from "@/lib/sanita/audit";
import { isPolicyPublicationUrl } from "@/lib/sanita/crawler";
import type { CrawlResult } from "@/lib/sanita/crawler";
import type { Verdict } from "@/lib/sanita/verdict";

export type ReconcileContext = {
  companyName: string;
  website: string;
  city?: string | null;
  category?: string | null;
  osmId?: string | null;
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
  const pt = crawl.policyText?.trim() ?? "";
  const corpus = [pt, crawl.text].filter(Boolean).join("\n").trim();
  const rcInPt =
    /responsabilit[aà]\s+civile|\bRCT\b|\bRCO\b|polizza\s+assicurativ|contratto\s+n\.?|contraente/i.test(pt);
  if (pt.length >= 80 && rcInPt) return pt;
  return corpus.length >= 80 ? corpus : pt || crawl.text || "";
}

function crawlWithResolvedPdf(crawl: CrawlResult): CrawlResult {
  const pdf = crawl.policyPdfUrl ?? pickPolicyPdfUrl(crawl);
  if (!pdf || pdf === crawl.policyPdfUrl) return crawl;
  return { ...crawl, policyPdfUrl: pdf };
}

export function analyzeCrawlPolicy(crawl: CrawlResult): PolicyAnalysis {
  return deepScanCrawlForPolicy(crawl);
}

/** Evidenza sufficiente per PUBLISHED certo: PDF polizza RC letto, oppure pagina HTML con polizza (Trasparenza o art.10). */
function htmlPolicyPublicationCertain(
  analysis: PolicyAnalysis,
  crawl: CrawlResult
): boolean {
  if (!analysis.policyFound || analysis.policyObsolete) return false;
  const body = policyTextFromCrawl(crawl);
  if (isGelliComplianceReportOnly(body, crawl.policyPdfUrl ?? undefined)) return false;
  const { company, policyNumber, massimale, expiry } = analysis;
  const visitedPolicyPage = crawl.pagesVisited.some((u) => isPolicyPublicationUrl(u));
  const hasRcContext = /copertura\s+assicurativa|polizza\s+stipulata|numero\s+(?:della\s+)?pratica|responsabilit[aà]\s+civile|\bRCT\b|\bRCO\b|polizza\s+n/i.test(body);

  // EVIDENZA SCHIACCIANTE: company + policyNumber + massimale → PUBLISHED sempre
  // (anche se la polizza è nel footer, non serve pagina Trasparenza dedicata)
  if (company && policyNumber && massimale) return true;
  // company + (policyNumber | massimale) + contesto RC → PUBLISHED
  if (company && (policyNumber || massimale) && hasRcContext) return true;

  // Evidenza parziale: richiede pagina Trasparenza visitata
  if (!crawl.foundRelevantPage || !visitedPolicyPage) return false;
  // company + qualsiasi dato concreto su pagina Trasparenza → PUBLISHED
  if (company && (policyNumber || massimale || expiry)) return true;
  // policyNumber + massimale (senza company) su pagina Trasparenza → PUBLISHED
  if (policyNumber && massimale) return true;
  // company + contesto RC su pagina Trasparenza → PUBLISHED
  // (autoassicurazione HTML senza PDF: non sufficiente — serve documento o soft/PDF path)
  if (company && hasRcContext) {
    if (/autoassicuraz|gestione\s+diretta/i.test(company) && !crawl.policyPdfUrl) return false;
    return true;
  }
  return false;
}

/** Polizza rilevata ma senza tutti i metadati — sufficiente per PUBLISHED se c'è PDF RC/PARM valido. */
function softPublicationCertain(analysis: PolicyAnalysis, crawl: CrawlResult): boolean {
  if (!analysis.policyFound || analysis.policyObsolete) return false;
  const body = policyTextFromCrawl(crawl);
  if (isGelliComplianceReportOnly(body, crawl.policyPdfUrl ?? undefined)) return false;
  if (!analysis.company) return false;
  // Autoassicurazione / misura analoga SOLO in HTML senza PDF → non CERTAIN (→ REVIEW).
  const selfInsuredOnlyHtml =
    /autoassicuraz|gestione\s+diretta/i.test(analysis.company) && !crawl.policyPdfUrl;
  if (
    crawl.foundRelevantPage &&
    isParmRcInsuranceDisclosure(body) &&
    analysis.company &&
    !selfInsuredOnlyHtml
  ) {
    return true;
  }

  if (!crawl.policyPdfUrl || !crawl.policyPdfAnalysis?.policyFound) return false;
  if (
    /carta[\-_]?dei[\-_]?servizi|carta[\-_]?servizi|service[\-_]?charter|costi[\-_]?contabilizzat|conto[\-_]?economico|bilancio/i.test(
      crawl.policyPdfUrl
    )
  ) {
    return false;
  }
  const pdfText = [crawl.policyPdfAnalysis?.evidence, crawl.policyText, body].filter(Boolean).join(" ");
  if (isAccountingOrBalanceSheetText(pdfText)) return false;
  const hasRcContext = /polizza|assicurativ|art\.?\s*10|legge\s+gelli|responsabilit[aà]\s+civile|rc\s+sanitar|\bRCT\b|\bRCO\b|massimale|autoassicuraz|gestione\s+diretta/i.test(
    pdfText
  );
  if (!hasRcContext) return false;
  if (/autoassicuraz|gestione\s+diretta/i.test(analysis.company)) return true;
  if (analysis.massimale || analysis.expiry || analysis.policyNumber) return true;
  if (isParmRcInsuranceDisclosure(pdfText)) return true;
  return false;
}

function pdfPolicyPublicationCertain(analysis: PolicyAnalysis, crawl: CrawlResult): boolean {
  const pdf = crawl.policyPdfAnalysis;
  const policyFound = Boolean(pdf?.policyFound || analysis.policyFound);
  if (!crawl.policyPdfUrl || !policyFound) return false;
  const pdfText = [pdf?.evidence, crawl.policyText].filter(Boolean).join(" ");
  if (isGelliComplianceReportOnly(pdfText, crawl.policyPdfUrl)) return false;
  if (
    /carta[\-_]?dei[\-_]?servizi|carta[\-_]?servizi|service[\-_]?charter|costi[\-_]?contabilizzat|conto[\-_]?economico|bilancio/i.test(
      crawl.policyPdfUrl
    )
  ) {
    return false;
  }

  const hasRcContext = /polizza|assicurativ|art\.?\s*10|legge\s+gelli|responsabilit[aà]\s+civile|rc\s+sanitar|appendice|codice\s+polizza|\bRCT\b|\bRCO\b|massimale|autoassicuraz|gestione\s+diretta/i.test(
    pdfText
  );
  if (!hasRcContext) return false;
  if (isAccountingOrBalanceSheetText(pdfText)) return false;

  const company = pdf?.company ?? analysis.company ?? null;
  const massimale = pdf?.massimale ?? analysis.massimale ?? null;
  const policyNumber = pdf?.policyNumber ?? analysis.policyNumber ?? null;
  const expiry = pdf?.expiry ?? analysis.expiry ?? null;
  const selfInsured = /autoassicuraz|gestione\s+diretta/i.test(company ?? "");
  const hasInsurer = Boolean(company);
  const appendix =
    /appendice\s+(?:di\s+)?rinnovo|codice\s+polizza|rc\s+sanitar/i.test(
      [pdf?.evidence, crawl.policyText].filter(Boolean).join(" ")
    );
  const hasConcrete = Boolean(massimale || policyNumber);

  if (selfInsured) return true;
  if (isParmRcInsuranceDisclosure(pdfText) && hasInsurer) return true;
  if (hasInsurer && hasConcrete) return true;
  if (appendix && policyNumber && expiry) return true;
  return false;
}

function publicationIsCertain(analysis: PolicyAnalysis, crawl: CrawlResult): boolean {
  if (!analysis.policyFound || analysis.policyObsolete) return false;
  // HTML art.10 (es. Gestione Rischio Clinico) non deve essere bloccato da PDF PARM/parziali.
  if (htmlPolicyPublicationCertain(analysis, crawl)) return true;
  return pdfPolicyPublicationCertain(analysis, crawl);
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
  if (!crawl.ok) {
    return {
      verdict: "REVIEW",
      analysis: analysisIn,
      adjusted: true,
      note: "Sito non raggiungibile — impossibile verificare polizza.",
    };
  }

  const crawlCorpus = [crawl.policyText, crawl.text].filter(Boolean).join("\n");

  // ── PASSO 1: trova polizza ovunque (priorità assoluta, prima di manutenzione/WAF) ──
  const analysis = deepScanCrawlForPolicy(crawl);
  const effectiveCrawl = crawlWithResolvedPdf(crawl);
  if (analysis.policyFound) {
    const enriched = enrichPublishedAnalysis(analysis, effectiveCrawl);
    if (ctx?.website) {
      const hostMatch = crawlHostMatchesWebsite(ctx.website, crawl);
      if (!hostMatch.ok) {
        return {
          verdict: "REVIEW",
          analysis: { ...enriched, policyFound: false },
          adjusted: true,
          note: `${hostMatch.reason} — polizza non attribuibile al sito della struttura.`,
        };
      }
    }
    // Polizza pubblicata ma scaduta da >1 anno → HOT con messaggio esplicito (non "non pubblicata").
    if (enriched.policyObsolete) {
      const days =
        enriched.expiry != null
          ? Math.floor((Date.now() - enriched.expiry.getTime()) / 86_400_000)
          : null;
      return {
        verdict: "HOT",
        analysis: enriched,
        adjusted: true,
        note:
          days != null && days > 0
            ? `Polizza RC pubblicata sul sito ma scaduta da ${days} giorni — Art. 10 richiede aggiornamento.`
            : "Polizza RC pubblicata sul sito ma non aggiornata — Art. 10 richiede pubblicazione corrente.",
      };
    }
    if (!publicationIsCertain(enriched, effectiveCrawl) && !softPublicationCertain(enriched, effectiveCrawl)) {
      const selfInsuredOnlyHtml =
        !effectiveCrawl.policyPdfUrl &&
        (/autoassicuraz|gestione\s+diretta|assunzione\s+diretta/i.test(enriched.company ?? "") ||
          /autoassicuraz|gestione\s+diretta\s+del\s+rischio/i.test(
            [effectiveCrawl.policyText, effectiveCrawl.text].filter(Boolean).join(" ")
          ));
      if (selfInsuredOnlyHtml) {
        return {
          verdict: "REVIEW",
          analysis: enriched,
          adjusted: true,
          note:
            "Autoassicurazione/misura analoga dichiarata solo in HTML senza documento ufficiale attribuibile — non certificabile come PUBLISHED.",
        };
      }
      const nonPolicyDoc =
        effectiveCrawl.policyPdfUrl &&
        /carta[\-_]?dei[\-_]?servizi|carta[\-_]?servizi|service[\-_]?charter|costi[\-_]?contabilizzat|conto[\-_]?economico|bilancio/i.test(
          effectiveCrawl.policyPdfUrl
        );
      if (nonPolicyDoc) {
        return {
          verdict: "REVIEW",
          analysis: { ...enriched, policyFound: false },
          adjusted: true,
          note: "Documento non di polizza RC (carta servizi / bilancio / costi) — non certificabile come PUBLISHED.",
        };
      }
      const pdfOnTrasparenza =
        Boolean(effectiveCrawl.policyPdfUrl) ||
        (effectiveCrawl.foundRelevantPage &&
          effectiveCrawl.policyPdfsRead > 0 &&
          effectiveCrawl.pagesVisited.some((u) => /polizz|assicuraz/i.test(u.toLowerCase())));
      if (pdfOnTrasparenza && effectiveCrawl.foundRelevantPage) {
        const publishedNote = effectiveCrawl.policyPdfUrl
          ? `Polizza RC certificata da PDF: ${effectiveCrawl.policyPdfUrl}`
          : "Polizza RC certificata in sezione Amministrazione Trasparente (HTML).";
        return {
          verdict: "PUBLISHED",
          analysis: enriched,
          adjusted: true,
          note: publishedNote,
        };
      }
      // Polizza trovata + Trasparenza visitata — mai REVIEW (HOT se scaduta già gestito sopra).
      // Eccezione: autoassicurazione HTML-only e documenti non-RC già gestiti sopra.
      if (effectiveCrawl.foundRelevantPage && enriched.policyFound) {
        return {
          verdict: "PUBLISHED",
          analysis: enriched,
          adjusted: true,
          note: "Polizza RC rilevata in sezione Trasparenza — certificata.",
        };
      }
      const note = effectiveCrawl.policyPdfUrl
        ? "PDF presente ma dati polizza RC insufficienti — verifica manuale."
        : "Riferimenti assicurativi su pagina web ma PDF polizza RC non individuato — verifica manuale.";
      return {
        verdict: "REVIEW",
        analysis: enriched,
        adjusted: true,
        note,
      };
    }
    const publishedNote = effectiveCrawl.policyPdfUrl
      ? `Polizza RC certificata da PDF: ${effectiveCrawl.policyPdfUrl}`
      : "Polizza RC certificata in sezione Amministrazione Trasparente (HTML).";
    return {
      verdict: "PUBLISHED",
      analysis: enriched,
      adjusted: true,
      note: publishedNote,
    };
  }

  // ── PASSO 2: prerequisiti per certificare ASSENZA polizza (HOT) ──
  if (isSiteUnderMaintenance(crawlCorpus)) {
    return {
      verdict: "REVIEW",
      analysis,
      adjusted: true,
      note: "Sito in manutenzione — impossibile verificare pubblicazione polizza RC online.",
    };
  }

  const gates: string[] = [];
  const deepCrawlOk =
    crawl.pagesVisited.length >= 20 &&
    crawl.policyExhaustive &&
    !crawl.needsOcrReview &&
    crawl.policyPdfsQueued <= crawl.policyPdfsRead;

  if (!crawl.foundRelevantPage && !deepCrawlOk) {
    gates.push("sezione Trasparenza/polizza non trovata");
  }
  if (crawl.policyPdfsQueued > crawl.policyPdfsRead) {
    gates.push(`ERRORE CRAWL: ${crawl.policyPdfsQueued - crawl.policyPdfsRead} PDF non processati`);
  }
  if (
    crawl.needsOcrReview &&
    (crawl.policyPdfsQueued > 0 || POLICY_HINT.test(crawlCorpus))
  ) {
    gates.push("PDF scannerizzato non decodificabile — OCR insufficiente");
  }
  if (!crawl.policyExhaustive) {
    const htmlOnlyOk =
      (crawl.foundRelevantPage || deepCrawlOk) &&
      crawl.policyPdfsQueued === 0 &&
      crawl.pagesVisited.length >= 8 &&
      !crawl.needsOcrReview;
    if (!htmlOnlyOk) {
      gates.push(`crawl incompleto (${crawl.policyPdfsRead}/${crawl.policyPdfsQueued} PDF)`);
    }
  }

  // Sempre: Maps può associare il sito dell'ente padre (es. fapc.it) alla singola RSA.
  if (ctx) {
    let identity: { ok: boolean; reason: string };
    if (
      ctx.mapsVerified &&
      crawl.foundRelevantPage &&
      !crawl.needsOcrReview &&
      (companyNameOnSite(ctx.companyName, policyTextFromCrawl(crawl)) ||
        hostBrandMatchesName(ctx.companyName, ctx.website))
    ) {
      identity = { ok: true, reason: "Sito Maps + brand coerente con struttura" };
    } else if (
      (crawl.foundRelevantPage || deepCrawlOk) &&
      crawl.pagesVisited.length >= 15 &&
      !crawl.needsOcrReview &&
      hostBrandMatchesName(ctx.companyName, ctx.website)
    ) {
      identity = { ok: true, reason: "Trasparenza visitata + dominio coerente col nome" };
    } else {
      identity = validateSiteIdentity(ctx.companyName, ctx.website, crawl, ctx.city);
    }
    if (!identity.ok) gates.push(identity.reason);
    else {
      const depth = crawlDepthSufficient(crawl);
      if (!depth.ok) gates.push(depth.reason);
    }

    // RSA assistenziale / ospedale accreditato: NON bloccano HOT se crawl esaustivo
    // e identità sito OK — altrimenti il 60%+ finisce in REVIEW inutilmente.
    // REVIEW resta per: sito errato, hotel/monastero, crawl incompleto, PDF/OCR.
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

  // Crawl esaustivo (BFS + PDF) senza polizza → HOT salvo sito errato/omonimia.
  const htmlPages = crawl.pagesVisited.filter((u) => !/\.pdf(?:$|\?|#)/i.test(u)).length;
  const allPdfsRead =
    crawl.policyPdfsQueued === 0 || crawl.policyPdfsRead >= crawl.policyPdfsQueued;
  const policyOcrBlock =
    crawl.needsOcrReview &&
    crawl.pagesVisited.some((u) =>
      /\.pdf(?:$|\?|#)/i.test(u) && /polizz|assicuraz|rc|rct|parm|pars/i.test(u.toLowerCase())
    );
  const wrongSiteGate = gates.some((g) =>
    /sito errato|omonimia|URL errato|ente padre|hotel|monastero|non è un sito istituzionale|dominio parcheggiato/i.test(
      g
    )
  );
  if (
    !analysis.policyFound &&
    crawl.ok &&
    htmlPages >= 12 &&
    allPdfsRead &&
    !policyOcrBlock &&
    !wrongSiteGate
  ) {
    return {
      verdict: "HOT",
      analysis,
      adjusted: true,
      note: "Sito analizzato per intero — polizza RC non pubblicata in Trasparenza (Art. 10).",
    };
  }

  return {
    verdict: "REVIEW",
    analysis,
    adjusted: true,
    note: `Impossibile certificare assenza polizza: ${gates.join("; ")}.`,
  };
}
