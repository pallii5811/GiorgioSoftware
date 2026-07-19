import { prisma } from "@/lib/prisma";
import { normalizeWebsite, type Region } from "@/lib/sanita/discovery";
import { alternateBrandTldUrls, isBlockedWebsiteHost } from "@/lib/sanita/website";
import { companyNameOnSite } from "@/lib/sanita/site-identity";
import { policyTextFromCrawl } from "@/lib/sanita/policy-verify";
import { resolveOfficialWebsite } from "@/lib/sanita/resolve-website";
import { probeGuessedOfficialWebsite } from "@/lib/sanita/guess-website";
import { resolveWebsiteViaMaps } from "@/lib/sanita/maps-discovery";
import { extractCityFromMapsAddress } from "@/lib/sanita/maps-query";
import { crawlLeadViaSlices, applyIdentityToCrawlRun } from "@/lib/sanita/lead-crawl-runtime";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "@/lib/sanita/policy-verify";
import { checkRegionalPolicy, isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { enrichContacts, findOfficialWebsite } from "@/lib/sanita/contact-enrichment";
import { tavilyFallbackForBlockedSite } from "@/lib/sanita/tavily-crawl-fallback";
import { terminalVerdictFromDiscovery } from "@/lib/sanita/discovery-gate";
import { isTransientAnalysisFailure } from "@/lib/sanita/scan-errors";
import { mergeContacts, pickBestPhone, pickOfficialWebsite } from "@/lib/sanita/contacts";
import { packEvidence, pickPolicySourceUrl, pickPolicyPdfUrl, isHotPublishedExpiredEvidence, type AuditSources } from "@/lib/sanita/audit";
import { isSiteUnderMaintenance } from "@/lib/sanita/website";
import { verdictFromSite, verdictFromRegional, readVerdictToken } from "@/lib/sanita/verdict";
import { finalizeVerdict } from "@/lib/sanita/finalize-verdict";
import { deriveCrawlComplete } from "@/lib/evidence/contract";
import {
  NOT_CHECKED_IDENTITY,
  identityBlocksTerminalVerdict,
  buildIdentityEvidence,
  type IdentityEvidence,
} from "@/lib/sanita/identity-evidence";
import { appendVersionMarker, currentMarkers } from "@/lib/sanita/evidence-version";
import { validateSiteIdentity } from "@/lib/sanita/site-identity";
import type { Verdict } from "@/lib/sanita/verdict";
import { scoreLead } from "@/lib/sanita/score";
import {
  derivePublishedSubtype,
  stampPublishedSubtype,
} from "@/lib/sanita/published-subtype";
import { assertAtomicHotPersist, HotIncompleteStopError } from "@/lib/sanita/atomic-verdict";
import {
  isTechnicalTransientError,
  resolveAfterTechnicalFailure,
  stampProcessingMeta,
} from "@/lib/sanita/processing-state";
import {
  buildPublishedEmitEvidence,
  prepareSanitaVerdictPersist,
  PublishedGateError,
} from "@/lib/sanita/verdict-gateway";
import {
  buildFrontierFromCrawl,
  stampFrontierSummary,
} from "@/lib/sanita/crawl-frontier-ledger";
import { runProductionWaterfall } from "@/lib/sanita/production-waterfall";
import { resolveRegionalIdentity } from "@/lib/sanita/regional-identity";
import type { Lead } from "@prisma/client";

import type { PolicyAnalysis } from "@/lib/sanita/detector";

export type ScanCounters = {
  analyzed: number;
  withPolicy: number;
  published: number;
  hot: number;
  review: number;
  reviewHuman: number;
  retryPending: number;
  technicalBlocked: number;
  outOfScope: number;
  regionalChecked: number;
  regionalWithPolicy: number;
};

/** Evidence tecnica senza token REVIEW (non entra in coda umana/commerciale). */
function packRetryPendingEvidence(body: string, _audit?: AuditSources): string {
  const stamped = stampProcessingMeta(body, {
    state: "RETRY_PENDING",
    businessVerdict: "NONE",
    validationStatus: "REVALIDATION_PENDING",
  });
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${stamped} — [FONTI: retry tecnico] [Verifica: ${when}] [STATE:RETRY_PENDING]`.trim();
}

function bumpCounter(
  counters: Pick<
    ScanCounters,
    "published" | "withPolicy" | "hot" | "review" | "reviewHuman" | "retryPending" | "technicalBlocked" | "outOfScope"
  >,
  kind: "published" | "hot" | "reviewHuman" | "retryPending" | "technicalBlocked" | "outOfScope"
) {
  if (kind === "published") {
    counters.published = (counters.published ?? 0) + 1;
    counters.withPolicy++;
  } else if (kind === "hot") counters.hot++;
  else if (kind === "retryPending") counters.retryPending = (counters.retryPending ?? 0) + 1;
  else if (kind === "technicalBlocked") counters.technicalBlocked = (counters.technicalBlocked ?? 0) + 1;
  else if (kind === "outOfScope") counters.outOfScope = (counters.outOfScope ?? 0) + 1;
  else {
    counters.reviewHuman = (counters.reviewHuman ?? 0) + 1;
    counters.review++;
  }
}

export const CRAWL_CONCURRENCY = 10;
export const REGIONAL_CONCURRENCY = 6;

/** Sito già salvato in DB (reenrich/Maps): non rigettare con pickOfficialWebsite (Ge.P.O.S. → gepos.it). */
function trustStoredWebsite(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const v = normalizeWebsite(raw);
  if (!v) return null;
  try {
    if (isBlockedWebsiteHost(new URL(v).hostname.replace(/^www\./i, ""))) return null;
  } catch {
    return null;
  }
  return v;
}

function acceptDiscoveredWebsite(raw: string | null | undefined, companyName: string): string | null {
  if (!raw?.trim()) return null;
  const v = normalizeWebsite(raw);
  if (!v) return null;
  return pickOfficialWebsite([v], companyName) ? v : null;
}

/** HOT: mai campi polizza. PUBLISHED (anche scaduta): conserva metadati. */
function policyDbFields(
  verdict: Verdict,
  a: Pick<
    PolicyAnalysis,
    "policyFound" | "policyObsolete" | "company" | "massimale" | "policyNumber" | "expiry" | "confidence"
  >
) {
  const keepPublished = verdict === "PUBLISHED" && Boolean(a.policyFound);
  return {
    policyFound: keepPublished,
    policyCompany: keepPublished ? a.company : null,
    policyMassimale: keepPublished ? a.massimale : null,
    policyNumber: keepPublished ? a.policyNumber : null,
    policyExpiry: keepPublished ? a.expiry : null,
    confidence: keepPublished ? (a.confidence ?? 1) : null,
  };
}

export async function runBatch<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await Promise.all(
      chunk.map((item) =>
        worker(item).catch((err) => {
          if (err instanceof HotIncompleteStopError) throw err;
          console.error(`  [runBatch] worker error:`, err instanceof Error ? err.message : err);
        })
      )
    );
  }
}

export async function analyzeLead(
  lead: {
    id: string;
    osmId?: string | null;
    category?: string | null;
    companyName: string;
    city: string | null;
    region: string;
    website: string | null;
    phone: string | null;
    email: string | null;
    pec: string | null;
    piva: string | null;
  },
  counters: Pick<
    ScanCounters,
    | "analyzed"
    | "withPolicy"
    | "published"
    | "hot"
    | "review"
    | "reviewHuman"
    | "retryPending"
    | "technicalBlocked"
    | "outOfScope"
  >
) {
  const existing = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: { evidence: true, policyFound: true },
  });
  if (
    !process.env.FORCE_RESCAN_PUB &&
    readVerdictToken(existing?.evidence) === "PUBLISHED" &&
    existing?.policyFound === true
  ) {
    counters.analyzed++;
    return;
  }
  if (
    !process.env.FORCE_RESCAN_PUB &&
    readVerdictToken(existing?.evidence) === "HOT" &&
    isHotPublishedExpiredEvidence(existing?.evidence)
  ) {
    counters.analyzed++;
    return;
  }

  const audit: AuditSources = { mapsLookup: true };
  const mapsWebsite = lead.website ? normalizeWebsite(lead.website) : null;
  let website: string | null =
    trustStoredWebsite(lead.website) ??
    (mapsWebsite && pickOfficialWebsite([mapsWebsite], lead.companyName) ? mapsWebsite : null);
  let mapsVerified = Boolean(lead.osmId?.startsWith("gmaps/") && website);

  if (!website) {
    const resolved = await resolveOfficialWebsite(
      lead.companyName,
      lead.city,
      lead.region as Region,
      { deadline: Date.now() + 120_000 }
    );

    if (resolved.source === "google") audit.googleSearch = true;
    if (resolved.source === "maps-card" || resolved.source === "maps-lookup") audit.mapsLookup = true;

    if (resolved.website) {
      if (resolved.source === "maps-card" || resolved.source === "maps-lookup") {
        website = trustStoredWebsite(resolved.website);
      } else {
        website = pickOfficialWebsite([resolved.website], lead.companyName) ? resolved.website : null;
      }
    }
    mapsVerified =
      Boolean(website) &&
      (resolved.source === "maps-card" || resolved.source === "maps-lookup");

    lead = {
      ...lead,
      companyName: resolved.companyName,
      city: resolved.city ?? lead.city,
      phone: resolved.phone ?? lead.phone,
    };

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        companyName: resolved.companyName,
        ...(website ? { website } : {}),
        city: lead.city,
        phone: lead.phone,
      },
    });
  }

  if (!website) return;

  const sliceRun = await crawlLeadViaSlices({
    leadId: lead.id,
    website,
    evidence: existing?.evidence,
    runId: process.env.SHADOW_RUN_ID || `analyze-${lead.id}`,
  });
  const crawl = sliceRun.crawl;
  let productCrawlRunId: string | null = sliceRun.crawlRunId;
  counters.analyzed++;

  if (!crawl.ok && crawl.pagesVisited.length === 0) {
    let phone = lead.phone;
    let email = lead.email;
    let pec = lead.pec;
    let verdict: Verdict = "REVIEW";
    let policyFound = false;
    const policyCompany: string | null = null;
    const policyMassimale: string | null = null;
    const policyNumber: string | null = null;
    const policyExpiry: Date | null = null;
    const confidence: number | null = null;
    let evidenceBody =
      crawl.error === "bot_blocked"
        ? "Sito protetto anti-bot (CAPTCHA/WAF) — IP datacenter bloccato. Verifica manuale sul sito (es. footer «Assicurazione RCT»)."
        : "Sito blocca crawl da server (403/WAF o timeout) — il sito può essere raggiungibile da browser domestico.";

    // Errore tecnico: non cancellare businessVerdict PUB storico → RETRY_PENDING
    const techErr = crawl.error || evidenceBody;
    if (isTechnicalTransientError(techErr) || crawl.error === "bot_blocked" || crawl.error === "retry_pending") {
      const resolved = resolveAfterTechnicalFailure({
        previousEvidence: existing?.evidence,
        error: String(techErr),
        retriesExhausted: false,
      });
      if (resolved.keepLegacyToken === "PUBLISHED") {
        verdict = "PUBLISHED";
        policyFound = existing?.policyFound === true;
        evidenceBody = stampProcessingMeta(
          `Revalidazione tecnica sospesa (${techErr}). Prova storica conservata. ${evidenceBody}`,
          {
            state: resolved.state,
            businessVerdict: resolved.businessVerdict,
            validationStatus: resolved.validationStatus,
          }
        );
        const prepared = prepareSanitaVerdictPersist({
          legacyVerdict: verdict,
          evidenceBody,
          businessVerdict: resolved.businessVerdict,
          validationStatus: resolved.validationStatus,
          processingState: resolved.state,
        });
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            website,
            city: lead.city,
            websiteReachable: false,
            evidence: packEvidence(prepared.legacyVerdict, prepared.evidenceBody, audit),
            lastScannedAt: new Date(),
          },
        });
        bumpCounter(counters, "published");
        return;
      }
      if (resolved.state === "RETRY_PENDING") {
        evidenceBody = stampProcessingMeta(evidenceBody, {
          state: "RETRY_PENDING",
          businessVerdict: "NONE",
          validationStatus: "REVALIDATION_PENDING",
        });
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            website,
            city: lead.city,
            websiteReachable: false,
            policyFound: false,
            evidence: packRetryPendingEvidence(evidenceBody, audit),
            lastScannedAt: new Date(),
          },
        });
        bumpCounter(counters, "retryPending");
        return;
      }
      if (resolved.state === "TECHNICAL_BLOCKED") {
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            website,
            city: lead.city,
            websiteReachable: false,
            policyFound: false,
            evidence: stampProcessingMeta(evidenceBody, {
              state: "TECHNICAL_BLOCKED",
              businessVerdict: "NONE",
              validationStatus: "TECHNICAL_BLOCKED",
            }),
            lastScannedAt: new Date(),
          },
        });
        bumpCounter(counters, "technicalBlocked");
        return;
      }
    }

    const tavily = await tavilyFallbackForBlockedSite(website, lead.companyName);
    if (tavily) {
      audit.contactSearch = true;
      audit.contactUrls = tavily.urls;
      // Discovery-only: snippet Tavily non può emettere PUBLISHED terminale.
      verdict = terminalVerdictFromDiscovery(Boolean(tavily.policyAnalysis.policyFound));
      policyFound = false;
      if (tavily.policyAnalysis.policyFound) {
        evidenceBody = `Candidato discovery (Tavily/WAF): possibile polizza indicizzata — fetch first-party e attribuzione richiesti prima di PUBLISHED. URLs: ${tavily.urls.slice(0, 3).join(" | ")}. ${tavily.policyAnalysis.evidence || ""}`;
      } else {
        evidenceBody = `Sito blocca IP server (WAF) — frammenti web indicizzati analizzati, polizza RC non trovata. Verifica manuale consigliata sul sito ufficiale.`;
      }
    } else if (crawl.error !== "bot_blocked" && isRegionalCheckAvailable()) {
      audit.crossCheckRegional = true;
      const regional = await checkRegionalPolicy(lead.companyName, lead.city, lead.region);
      audit.regionalQueries = regional.queryCount;
      audit.regionalUrls = regional.sourceUrls;
      if (regional.policyFound) {
        // Portale regionale senza fetch first-party del sito → REVIEW (candidato), non PUBLISHED terminale.
        verdict = "REVIEW";
        evidenceBody = `Candidato portale regionale/ASL (sito non crawlable): possibile polizza — verifica first-party obbligatoria. ${regional.evidence || ""}`;
      } else if (regional.checked) {
        verdict = "REVIEW";
        evidenceBody = `Sito non crawlable da server; portali ASL consultati — crawl sito necessario per HOT. ${regional.evidence || ""}`;
      }
      const enriched = await enrichContacts(lead.companyName, lead.city, lead.region, { skipMaps: true });
      if (enriched.checked) {
        const m = mergeContacts({ phone, email, pec, website }, enriched.contacts, lead.region);
        phone = m.phone;
        email = m.email;
        pec = m.pec;
        audit.contactSearch = true;
        audit.contactUrls = enriched.sourceUrls;
      }
    }

    const finWaf = finalizeVerdict({
      verdict,
      evidenceBody,
      pagesVisited: 0,
      websiteReachable: false,
      website,
      policyCompany,
      policyExpiry,
    });
    verdict = finWaf.verdict;
    evidenceBody = finWaf.evidenceBody;

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        website,
        city: lead.city,
        websiteReachable: false,
        policyFound,
        confidence: policyFound ? confidence : 0,
        policyCompany,
        policyMassimale,
        policyNumber,
        policyExpiry,
        pagesVisited: 0,
        phone,
        email,
        pec,
        evidence: packEvidence(verdict, evidenceBody, audit),
        leadScore: scoreLead({ verdict, phone, email, pec }),
        lastScannedAt: new Date(),
      },
    });
    if (verdict === "PUBLISHED") bumpCounter(counters, "published");
    else if (verdict === "HOT") bumpCounter(counters, "hot");
    else bumpCounter(counters, "reviewHuman");
    return;
  }

  audit.sitePages = crawl.pagesVisited;
  audit.siteRelevant = crawl.foundRelevantPage;
  audit.siteUnderMaintenance = isSiteUnderMaintenance([crawl.policyText, crawl.text].filter(Boolean).join("\n"));
  audit.policyPdfUrl = pickPolicyPdfUrl(crawl);
  audit.policySourceUrl = pickPolicySourceUrl(crawl);
  audit.policyPdfsQueued = crawl.policyPdfsQueued;
  audit.policyPdfsRead = crawl.policyPdfsRead;
  audit.needsOcrReview = crawl.needsOcrReview;

  let analysis = analyzeCrawlPolicy(crawl);
  let confidence: number | null = analysis.confidence ?? null;
  let verdict: Verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const reconciled = reconcilePolicyVerdict(crawl, analysis, verdict, {
    companyName: lead.companyName,
    website: mapsWebsite ?? website,
    city: lead.city,
    category: lead.category,
    osmId: lead.osmId,
    mapsVerified,
  });
  analysis = reconciled.analysis;
  verdict = reconciled.verdict;
  let evidenceBody = analysis.evidence ?? "";
  if (reconciled.note) {
    evidenceBody = `${reconciled.note} ${evidenceBody}`.trim();
  }

  if (verdict === "HOT" && isRegionalCheckAvailable()) {
    audit.crossCheckRegional = true;
    const regional = await checkRegionalPolicy(lead.companyName, lead.city, lead.region);
    audit.regionalQueries = regional.queryCount;
    audit.regionalUrls = regional.sourceUrls;
    if (analysis.policyObsolete) {
      evidenceBody = reconciled.note ?? analysis.evidence ?? evidenceBody;
    } else if (regional.policyFound) {
      verdict = "REVIEW";
      evidenceBody = `Portale regionale/ASL: possibile polizza ma PDF RC non sul sito — verifica manuale. ${regional.evidence || ""}`;
    } else if (regional.checked) {
      evidenceBody = `Sito: polizza non pubblicata in Trasparenza. Portali ASL/regionali: confermata assenza pubblicazione. ${analysis.evidence || ""}`;
    }
  }

  // Polizza assente su .it/.com Maps — prova il TLD gemello (stesso brand nel nome).
  if (!analysis.policyFound && (verdict === "HOT" || verdict === "REVIEW")) {
    for (const altUrl of alternateBrandTldUrls(website, lead.companyName)) {
      const altSlice = await crawlLeadViaSlices({
        leadId: lead.id,
        website: altUrl,
        evidence: existing?.evidence,
        runId: process.env.SHADOW_RUN_ID || `analyze-alt-${lead.id}`,
      });
      const altCrawl = altSlice.crawl;
      if (!altCrawl.ok) continue;
      const altAnalysis = analyzeCrawlPolicy(altCrawl);
      const altRec = reconcilePolicyVerdict(
        altCrawl,
        altAnalysis,
        verdictFromSite({
          reachable: true,
          policyFound: altAnalysis.policyFound,
          foundRelevantPage: altCrawl.foundRelevantPage,
        }),
        {
          companyName: lead.companyName,
          website: altUrl,
          city: lead.city,
          category: lead.category,
          osmId: lead.osmId,
          mapsVerified: false,
        }
      );
      if (
        altRec.verdict === "PUBLISHED" &&
        altRec.analysis.policyFound &&
        companyNameOnSite(lead.companyName, policyTextFromCrawl(altCrawl))
      ) {
        website = normalizeWebsite(altUrl) ?? altUrl;
        Object.assign(crawl, altCrawl);
        productCrawlRunId = altSlice.crawlRunId;
        analysis = altRec.analysis;
        verdict = "PUBLISHED";
        evidenceBody =
          `Polizza su dominio alternativo ${website} (Maps aveva ${lead.website}). ${altRec.note ?? ""} ${altRec.analysis.evidence ?? ""}`.trim();
        audit.sitePages = altCrawl.pagesVisited;
        audit.siteRelevant = altCrawl.foundRelevantPage;
        audit.policyPdfUrl = pickPolicyPdfUrl(altCrawl);
        audit.policySourceUrl = pickPolicySourceUrl(altCrawl);
        audit.policyPdfsQueued = altCrawl.policyPdfsQueued;
        audit.policyPdfsRead = altCrawl.policyPdfsRead;
        audit.needsOcrReview = altCrawl.needsOcrReview;
        break;
      }
    }
  }

  // Candidato PUB (anche scaduta) — mai HOT assenza su polizza trovata.
  // Persistenza passa da canEmitPublished via VerdictGateway.
  if (analysis.policyFound && verdict === "REVIEW" && crawl.ok) {
    const policySource =
      pickPolicyPdfUrl(crawl) ||
      (crawl.policyPdfsRead ?? 0) > 0 ||
      (crawl.foundRelevantPage && crawl.pagesVisited.length >= 4) ||
      crawl.pagesVisited.length >= 8;
    if (policySource) {
      verdict = "PUBLISHED";
      confidence = analysis.confidence ?? 1;
      if (analysis.policyObsolete && !/scaduta/i.test(evidenceBody)) {
        evidenceBody = `Polizza RC pubblicata sul sito ma scaduta/non aggiornata — opportunità urgente (Art. 10). ${evidenceBody}`.trim();
      }
    }
  }

  // Identità da prove (validateSiteIdentity), MAI da verdetto precedente.
  let identityEv: IdentityEvidence = NOT_CHECKED_IDENTITY;
  try {
    const idRes = validateSiteIdentity(
      lead.companyName,
      website,
      crawl,
      lead.city
    );
    if (idRes.ok) {
      identityEv = buildIdentityEvidence({
        status: "OFFICIAL_CONFIRMED",
        matchedLegalName: true,
        matchedFacilityName: true,
        matchedAddress: false,
        matchedMunicipality: Boolean(lead.city),
        matchedPhone: false,
        matchedTaxIdentifier: false,
        matchedOfficialRegistry: false,
        matchedGroupRelationship: false,
        sourceUrls: crawl.pagesVisited.slice(0, 5),
        reasons: [idRes.reason],
        conflicts: [],
      });
    } else if (/omonimia|errato|diverso|hotel|monastero|parcheggiato|ASL/i.test(idRes.reason)) {
      identityEv = buildIdentityEvidence({
        status: /omonimia|errato|diverso|hotel|monastero|ASL/i.test(idRes.reason)
          ? "MISMATCH"
          : "INSUFFICIENT",
        matchedLegalName: false,
        matchedFacilityName: false,
        matchedAddress: false,
        matchedMunicipality: false,
        matchedPhone: false,
        matchedTaxIdentifier: false,
        matchedOfficialRegistry: false,
        matchedGroupRelationship: false,
        sourceUrls: crawl.pagesVisited.slice(0, 3),
        reasons: [idRes.reason],
        conflicts: [idRes.reason],
      });
    } else {
      identityEv = buildIdentityEvidence({
        status: "INSUFFICIENT",
        matchedLegalName: false,
        matchedFacilityName: false,
        matchedAddress: false,
        matchedMunicipality: false,
        matchedPhone: false,
        matchedTaxIdentifier: false,
        matchedOfficialRegistry: false,
        matchedGroupRelationship: false,
        sourceUrls: [],
        reasons: [idRes.reason],
        conflicts: [],
      });
    }
  } catch {
    identityEv = NOT_CHECKED_IDENTITY;
  }

  const idBlock = identityBlocksTerminalVerdict(identityEv);
  if (idBlock && (verdict === "HOT" || verdict === "PUBLISHED")) {
    verdict = "REVIEW";
    evidenceBody = `${idBlock} ${evidenceBody}`.trim();
  }

  const fin = finalizeVerdict({
    verdict,
    evidenceBody,
    pagesVisited: crawl.pagesVisited.length,
    websiteReachable: true,
    website,
    policyCompany: analysis.company,
    policyExpiry: analysis.expiry,
    policyObsolete: analysis.policyObsolete,
    policyExhaustive: crawl.policyExhaustive,
    needsOcrReview: crawl.needsOcrReview,
    identityStatus: identityEv.status,
    category: lead.category,
    crawlCompleteness: deriveCrawlComplete({
      ...(crawl.completeness ?? {
        identityVerified: false,
        sitemapStatus: "NOT_DISCOVERED" as const,
        htmlQueueExhausted: false,
        relevantLinksProcessed: false,
        relevantDocumentsProcessed: false,
        jsonEndpointsProcessed: false,
        sameHostScriptsProcessed: false,
        unresolvedRelevantUrls: 0,
        failedRelevantUrls: 0,
        unreadableRelevantDocuments: 0,
        criticalOcrDoubts: 0,
        urlCapReached: false,
        timeCapReached: false,
      }),
      identityVerified: identityEv.verified,
      sitemapStatus: crawl.completeness?.sitemapStatus ?? "NOT_DISCOVERED",
    }),
  });
  verdict = fin.verdict;
  const ccStamp = deriveCrawlComplete({
    ...(crawl.completeness ?? {
      identityVerified: false,
      sitemapStatus: "NOT_DISCOVERED" as const,
      htmlQueueExhausted: false,
      relevantLinksProcessed: false,
      relevantDocumentsProcessed: false,
      jsonEndpointsProcessed: false,
      sameHostScriptsProcessed: false,
      unresolvedRelevantUrls: 0,
      failedRelevantUrls: 0,
      unreadableRelevantDocuments: 0,
      criticalOcrDoubts: 0,
      urlCapReached: false,
      timeCapReached: false,
    }),
    identityVerified: identityEv.verified,
    sitemapStatus: crawl.completeness?.sitemapStatus ?? "NOT_DISCOVERED",
  });
  evidenceBody = appendVersionMarker(fin.evidenceBody, currentMarkers("CURRENT"));
  evidenceBody = `${evidenceBody} [IDENTITY:${identityEv.status}] [CRAWL_COMPLETE:${ccStamp.complete}]`.trim();

  if (fin.processingHint === "RETRY_PENDING") {
    evidenceBody = stampProcessingMeta(evidenceBody, {
      state: "RETRY_PENDING",
      businessVerdict: "NONE",
      validationStatus: "REVALIDATION_PENDING",
    });
  } else if (fin.processingHint === "REVIEW_HUMAN") {
    evidenceBody = stampProcessingMeta(evidenceBody, {
      state: "REVIEW_HUMAN",
      businessVerdict: "REVIEW_HUMAN",
      validationStatus: "CONFLICT_FOUND",
    });
  }

  const frontier = buildFrontierFromCrawl({
    baseUrl: website,
    pagesVisited: crawl.pagesVisited,
    policyPdfsQueued: crawl.policyPdfsQueued ?? 0,
    policyPdfsRead: crawl.policyPdfsRead ?? 0,
    needsOcrReview: Boolean(crawl.needsOcrReview),
    completeness: ccStamp,
    scanKey: lead.id,
  });
  evidenceBody = stampFrontierSummary(evidenceBody, frontier);

  const crawlRunId: string | null = productCrawlRunId;
  if (crawlRunId) {
    try {
      const ccLive = applyIdentityToCrawlRun(crawlRunId, {
        identityVerified: identityEv.verified,
        scopeVerified: identityEv.verified,
      });
      Object.assign(ccStamp, ccLive);
      const wf = await runProductionWaterfall({
        website,
        crawlRunId,
      });
      evidenceBody = `${evidenceBody} [WATERFALL:${wf.traversed.length}/${wf.wiredCount}:${wf.technicalStatus}]`.trim();
    } catch (e) {
      evidenceBody = `${evidenceBody} [FRONTIER_PERSIST_ERR:${e instanceof Error ? e.message : "x"}]`.trim();
    }
  } else {
    evidenceBody = `${evidenceBody} [FRONTIER:missing]`.trim();
  }

  // Candidato PUB da polizza sul sito: resta PUB solo se gateway/canEmitPublished ok.
  if (
    verdict === "REVIEW" &&
    analysis.policyFound &&
    identityEv.verified &&
    !/dominio diverso|non attribuibile|Contaminazione critica|Identità/i.test(evidenceBody)
  ) {
    const certified =
      !!pickPolicyPdfUrl(crawl) ||
      (crawl.policyPdfsRead ?? 0) > 0 ||
      (crawl.foundRelevantPage && crawl.pagesVisited.length >= 4);
    if (certified) {
      verdict = "PUBLISHED";
      evidenceBody = appendVersionMarker(evidenceBody, currentMarkers("CURRENT"));
    }
  }

  const nonPec = crawl.emails.filter((e) => e !== crawl.pec);
  let phone = pickBestPhone([crawl.phones[0], lead.phone], lead.region);
  let email = lead.email || nonPec[0] || crawl.pec || null;
  let pec = crawl.pec || lead.pec || null;
  const piva = crawl.piva || lead.piva || null;

  if ((!phone || !email) && isRegionalCheckAvailable()) {
    const enriched = await enrichContacts(lead.companyName, lead.city, lead.region);
    if (enriched.checked) {
      const m = mergeContacts({ phone, email, pec, website: lead.website }, enriched.contacts, lead.region);
      phone = m.phone;
      email = m.email;
      pec = m.pec;
      audit.contactSearch = true;
      audit.contactUrls = enriched.sourceUrls;
    }
  }

  const policyUrl =
    pickPolicyPdfUrl(crawl) || pickPolicySourceUrl(crawl) || crawl.pagesVisited[0] || website;
  const corpus = [crawl.policyText, crawl.text, evidenceBody].filter(Boolean).join("\n");
  const hotEvidence = {
    website,
    websiteReachable: true as const,
    pagesVisited: crawl.pagesVisited.length,
    policyExhaustive: crawl.policyExhaustive === true,
    needsOcrReview: Boolean(crawl.needsOcrReview),
    crawlCompleteness: ccStamp,
    identityStatus: identityEv.status,
    category: lead.category,
    frontier,
    crawlRunId,
    requirePersistedCompleteness: Boolean(crawlRunId),
  };

  let prepared;
  try {
    if (verdict === "PUBLISHED") {
      const publishedEvidence = buildPublishedEmitEvidence({
        identityStatus: identityEv.status,
        pageUrl: policyUrl,
        facilityWebsite: website,
        contentFetched: crawl.ok,
        contentExcerpt: corpus.slice(0, 4000),
        docFingerprint: {
          facilityName: lead.companyName,
          vatId: piva,
          municipality: lead.city,
          phone,
          domain: website,
          seatPageUrl: website,
        },
        facilityFingerprint: {
          facilityName: lead.companyName,
          vatId: piva || lead.piva,
          municipality: lead.city,
          phone,
          domain: website,
          seatPageUrl: website,
          groupSeatVerified: identityEv.status === "GROUP_OFFICIAL_CONFIRMED",
        },
        policyObsolete: analysis.policyObsolete,
        hasCoverageEnd: Boolean(analysis.expiry),
        analogousMeasure: /autoassicuraz|misura analoga|gestione\s+diretta/i.test(corpus),
        category: lead.category,
      });
      prepared = prepareSanitaVerdictPersist({
        legacyVerdict: "PUBLISHED",
        evidenceBody,
        publishedEvidence,
      });
      const subtype = derivePublishedSubtype({
        policyObsolete: analysis.policyObsolete,
        policyExpiry: analysis.expiry,
        policyCompany: analysis.company,
        policyNumber: analysis.policyNumber,
        policyMassimale: analysis.massimale,
        evidenceBody: prepared.evidenceBody,
      });
      evidenceBody = stampPublishedSubtype(prepared.evidenceBody, subtype);
      verdict = prepared.legacyVerdict;
    } else if (verdict === "HOT") {
      assertAtomicHotPersist(verdict, hotEvidence);
      prepared = prepareSanitaVerdictPersist({
        legacyVerdict: "HOT",
        evidenceBody,
        hotEvidence,
      });
      evidenceBody = prepared.evidenceBody;
      verdict = prepared.legacyVerdict;
    } else {
      if (!fin.processingHint) {
        evidenceBody = stampProcessingMeta(evidenceBody, {
          state: "REVIEW_HUMAN",
          businessVerdict: "REVIEW_HUMAN",
          validationStatus: "CURRENT_VERIFIED",
        });
      }
    }
  } catch (e) {
    if (e instanceof PublishedGateError) {
      verdict = "REVIEW";
      evidenceBody = stampProcessingMeta(
        `PUBLISHED gate: ${e.reasons.join("; ")}. ${evidenceBody}`,
        {
          state: "REVIEW_HUMAN",
          businessVerdict: "REVIEW_HUMAN",
          validationStatus: "CONFLICT_FOUND",
        }
      );
    } else if (e instanceof HotIncompleteStopError) {
      throw e;
    } else {
      throw e;
    }
  }

  if (verdict === "PUBLISHED") bumpCounter(counters, "published");
  else if (verdict === "HOT") bumpCounter(counters, "hot");
  else if (fin.processingHint === "RETRY_PENDING") bumpCounter(counters, "retryPending");
  else bumpCounter(counters, "reviewHuman");

  const finalEvidence =
    fin.processingHint === "RETRY_PENDING"
      ? packRetryPendingEvidence(evidenceBody, audit)
      : packEvidence(verdict, evidenceBody, audit);

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      website,
      city: lead.city,
      websiteReachable: true,
      ...policyDbFields(verdict, analysis),
      email,
      phone,
      pec,
      piva,
      leadScore: scoreLead({
        verdict,
        phone,
        email,
        pec,
        expiry: analysis.expiry,
        obsoletePolicy: analysis.policyObsolete,
      }),
      evidence: finalEvidence,
      pagesVisited: crawl.pagesVisited.length,
      lastScannedAt: new Date(),
    },
  });
}

export async function analyzeRegional(
  lead: {
    id: string;
    osmId?: string | null;
    category?: string | null;
    companyName: string;
    city: string | null;
    website: string | null;
    phone: string | null;
    email: string | null;
    pec: string | null;
    policyFound: boolean | null;
    policyCompany: string | null;
    policyMassimale: string | null;
    policyNumber: string | null;
    policyExpiry: Date | null;
    confidence: number | null;
    evidence: string | null;
    websiteReachable?: boolean | null;
    pagesVisited?: number | null;
  },
  region: Region,
  counters: ScanCounters
) {
  const audit: AuditSources = { mapsLookup: true };

  let phone = lead.phone;
  let email = lead.email;
  let pec = lead.pec;
  const storedWebsite = trustStoredWebsite(lead.website);
  let website = storedWebsite;
  let mapsAlready = false;
  let mapsVerified = Boolean(lead.osmId?.startsWith("gmaps/") && storedWebsite);

  if (!website) {
    if (lead.website) {
      website = acceptDiscoveredWebsite(lead.website, lead.companyName);
      mapsVerified = mapsVerified && Boolean(website);
    }

    if (!website) {
      const maps = await resolveWebsiteViaMaps(lead.companyName, lead.city, region, {
        deadline: Date.now() + 120_000,
        maxQueries: 6,
      });
      if (maps) {
        mapsAlready = true;
        audit.mapsLookup = true;
        if (!phone && maps.phone) phone = maps.phone;
        const mapsCity = extractCityFromMapsAddress(maps.address);
        if (mapsCity) lead = { ...lead, city: mapsCity };
        if (maps.website) {
          website = trustStoredWebsite(maps.website) ?? acceptDiscoveredWebsite(maps.website, lead.companyName);
        }
        if (maps.website && website) mapsVerified = true;
      }
    }

    if (!website) {
      const google = await findOfficialWebsite(lead.companyName, lead.city, region);
      const w = normalizeWebsite(google.website ?? undefined);
      if (w) {
        website = acceptDiscoveredWebsite(w, lead.companyName);
        audit.googleSearch = true;
        audit.contactUrls = [...(audit.contactUrls ?? []), ...google.sourceUrls];
      }
    }

    if (!website) {
      const guessed = await probeGuessedOfficialWebsite(lead.companyName);
      if (guessed) {
        website = acceptDiscoveredWebsite(guessed, lead.companyName);
        audit.googleSearch = true;
      }
    }
  }

  // Google/Tavily per telefono/email — non sostituire sito già fidato in DB.
  if (!phone || !email) {
    const enriched = await enrichContacts(lead.companyName, lead.city, region, {
      skipMaps: Boolean(storedWebsite) || mapsAlready,
    });
    if (enriched.checked) {
      const m = mergeContacts({ phone, email, pec, website }, enriched.contacts, region);
      phone = m.phone;
      email = m.email;
      pec = m.pec;
      if (!website && m.website) website = acceptDiscoveredWebsite(m.website, lead.companyName);
      audit.contactSearch = true;
      audit.contactUrls = enriched.sourceUrls;
      audit.googleSearch = true;
    }
  }

  if (website) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        website,
        ...(phone && !lead.phone ? { phone } : {}),
        ...(lead.city ? { city: lead.city } : {}),
      },
    });
  }

  const result = await checkRegionalPolicy(lead.companyName, lead.city, region);
  audit.regionalQueries = result.queryCount;
  audit.regionalUrls = result.sourceUrls;

  if (!result.checked) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        phone,
        email,
        pec,
        website,
        lastScannedAt: new Date(),
        evidence: packEvidence("REVIEW", "Verifica portali regionali non disponibile (Tavily).", audit),
      },
    });
    return;
  }

  counters.regionalChecked++;
  if (result.policyFound) counters.regionalWithPolicy++;

  const portalContacts = mergeContacts({ phone, email, pec, website }, result.contactsFromPortals, region);
  phone = portalContacts.phone;
  email = portalContacts.email;
  pec = portalContacts.pec;
  if (!website && portalContacts.website) website = portalContacts.website;

  let policyFound = result.policyFound || lead.policyFound || false;
  let policyCompany = result.company || lead.policyCompany;
  let policyMassimale = result.massimale || lead.policyMassimale;
  let policyNumber = result.policyNumber || lead.policyNumber;
  let policyExpiry = result.expiry || lead.policyExpiry;
  let confidence = result.confidence ?? lead.confidence;
  let websiteReachable: boolean | null = lead.website ? true : null;
  let pagesVisited = 0;
  let verdict: Verdict = verdictFromRegional({
    checked: true,
    policyFound: result.policyFound,
    hasWebsite: Boolean(website),
  });
  let evidenceBody = result.evidence;
  let crawlPolicyObsolete = false;
  let crawlPolicyExhaustive = false;
  let crawlNeedsOcrReview = false;

  const priorSite = lead.website ? normalizeWebsite(lead.website) : null;
  const mustCrawlSite =
    Boolean(website) &&
    (!priorSite || priorSite !== website || lead.websiteReachable === null || (lead.pagesVisited ?? 0) === 0);

  if (website && mustCrawlSite) {
    // Directory/social scartati prima del crawl — evita falsi HOT su URL Maps errati.
    try {
      const host = new URL(website).hostname.replace(/^www\./i, "");
      if (isBlockedWebsiteHost(host)) website = null;
    } catch {
      website = null;
    }
  }

  if (website && mustCrawlSite) {
    audit.sitePages = [];
    const sliceRun = await crawlLeadViaSlices({
      leadId: lead.id,
      website,
      evidence: lead.evidence,
      runId: process.env.SHADOW_RUN_ID || `analyze-reg-${lead.id}`,
    });
    const crawl = sliceRun.crawl;
    pagesVisited = crawl.pagesVisited.length;
    if (crawl.ok || crawl.pagesVisited.length > 0) {
      websiteReachable = true;
      audit.sitePages = crawl.pagesVisited;
      audit.siteRelevant = crawl.foundRelevantPage;
      audit.siteUnderMaintenance = isSiteUnderMaintenance([crawl.policyText, crawl.text].filter(Boolean).join("\n"));
      audit.policyPdfUrl = pickPolicyPdfUrl(crawl);
      audit.policySourceUrl = pickPolicySourceUrl(crawl);
      let siteAnalysis = analyzeCrawlPolicy(crawl);
      let siteVerdict = verdictFromSite({
        reachable: true,
        policyFound: siteAnalysis.policyFound,
        foundRelevantPage: crawl.foundRelevantPage,
      });
      const siteRec = reconcilePolicyVerdict(crawl, siteAnalysis, siteVerdict, {
        companyName: lead.companyName,
        website,
        city: lead.city,
        category: lead.category,
        osmId: lead.osmId,
        mapsVerified,
      });
      siteAnalysis = siteRec.analysis;
      siteVerdict = siteRec.verdict;
      verdict = siteVerdict;
      crawlPolicyObsolete = Boolean(siteAnalysis.policyObsolete && siteAnalysis.policyFound);
      crawlPolicyExhaustive = crawl.policyExhaustive;
      crawlNeedsOcrReview = crawl.needsOcrReview;
      if (siteVerdict === "PUBLISHED" && siteAnalysis.policyFound) {
        policyFound = true;
        policyCompany = siteAnalysis.company || policyCompany;
        policyMassimale = siteAnalysis.massimale || policyMassimale;
        policyNumber = siteAnalysis.policyNumber || policyNumber;
        policyExpiry = siteAnalysis.expiry || policyExpiry;
        confidence = siteAnalysis.confidence ?? 1;
      } else if (siteVerdict === "HOT" && siteAnalysis.policyObsolete && siteAnalysis.policyFound) {
        policyFound = true;
        policyCompany = siteAnalysis.company || policyCompany;
        policyMassimale = siteAnalysis.massimale || policyMassimale;
        policyNumber = siteAnalysis.policyNumber || policyNumber;
        policyExpiry = siteAnalysis.expiry || policyExpiry;
        confidence = siteAnalysis.confidence ?? 1;
        evidenceBody = siteRec.note ?? siteAnalysis.evidence ?? evidenceBody;
      } else if (siteVerdict === "HOT") {
        policyFound = false;
        policyCompany = null;
        policyMassimale = null;
        policyNumber = null;
        policyExpiry = null;
        confidence = 0;
      } else {
        policyFound = siteAnalysis.policyFound;
        if (siteAnalysis.policyFound) {
          policyCompany = siteAnalysis.company || policyCompany;
          policyMassimale = siteAnalysis.massimale || policyMassimale;
          policyNumber = siteAnalysis.policyNumber || policyNumber;
          policyExpiry = siteAnalysis.expiry || policyExpiry;
          confidence = siteAnalysis.confidence;
        }
      }
      if (verdict === "HOT" && isRegionalCheckAvailable() && !crawlPolicyObsolete) {
        audit.crossCheckRegional = true;
        const regional = await checkRegionalPolicy(lead.companyName, lead.city, region);
        audit.regionalQueries = regional.queryCount;
        audit.regionalUrls = regional.sourceUrls;
        if (regional.policyFound) {
          verdict = "REVIEW";
          evidenceBody = `Portale regionale/ASL: possibile polizza ma PDF RC non sul sito — verifica manuale. ${regional.evidence || ""}`;
        }
      }
      const m = mergeContacts({ phone, email, pec, website }, {
        emails: crawl.emails,
        pec: crawl.pec,
        phones: crawl.phones,
        website,
      }, region);
      phone = m.phone;
      email = m.email;
      pec = m.pec;
    } else {
      websiteReachable = false;
      const tavily = await tavilyFallbackForBlockedSite(website, lead.companyName);
      if (tavily) {
        audit.contactSearch = true;
        audit.contactUrls = tavily.urls;
        verdict = terminalVerdictFromDiscovery(Boolean(tavily.policyAnalysis.policyFound));
        policyFound = false;
        if (tavily.policyAnalysis.policyFound) {
          evidenceBody = `Candidato discovery (Tavily/WAF): possibile polizza indicizzata — fetch first-party richiesto. ${tavily.urls.slice(0, 3).join(" | ")}. ${tavily.policyAnalysis.evidence || ""}`;
        } else if (result.checked) {
          evidenceBody = `Sito blocca IP server (WAF) — portali ASL consultati, crawl sito necessario. ${result.evidence ?? ""}`;
        }
      } else if (crawl.error === "bot_blocked" && result.checked && !result.policyFound) {
        verdict = "REVIEW";
        evidenceBody = `Sito protetto anti-bot — portali ASL consultati, crawl sito necessario. ${result.evidence ?? ""}`;
      } else if (result.policyFound) {
        verdict = "REVIEW";
        policyFound = false;
        evidenceBody = `Portale regionale/ASL: possibile polizza ma sito blocca crawl server (${website}). ${result.evidence ?? ""}`;
      } else if (result.checked && verdict === "HOT") {
        evidenceBody = `Sito blocca crawl server (${website}); assenza polizza su portali ASL/regionali. ${result.evidence ?? ""}`;
      }
    }
  }

  const siteWasObsolete = crawlPolicyObsolete;
  if (policyFound && !result.policyFound && website) {
    evidenceBody = `Polizza RC rilevata sul sito ufficiale (${website}) — scan multi-pass Trasparenza/PDF/HTML.`;
    if (!crawlPolicyObsolete) {
      verdict = "PUBLISHED";
      confidence = confidence ?? 1;
    }
  } else if (siteWasObsolete && result.policyFound && !policyFound) {
    evidenceBody = `Polizza su portale regionale/ASL; assente o non aggiornata sul sito. ${evidenceBody ?? ""}`;
  } else if (!policyFound && !website) {
    verdict = "REVIEW";
    evidenceBody = `Sito ufficiale non individuato automaticamente — impossibile certificare assenza polizza. Verifica manuale obbligatoria (es. Google). ${evidenceBody ?? ""}`;
  } else if (
    !policyFound &&
    website &&
    !lead.website &&
    websiteReachable !== false &&
    pagesVisited > 0
  ) {
    evidenceBody = `Sito ufficiale trovato (${website}) e analizzato. Polizza non pubblicata in Trasparenza. ${evidenceBody ?? ""}`;
  }

  const finReg = finalizeVerdict({
    verdict,
    evidenceBody: evidenceBody ?? "",
    pagesVisited,
    websiteReachable,
    website,
    policyCompany,
    policyExpiry,
    policyObsolete: crawlPolicyObsolete,
    policyExhaustive: crawlPolicyExhaustive,
    needsOcrReview: crawlNeedsOcrReview,
    category: lead.category,
  });
  verdict = finReg.verdict;
  evidenceBody = finReg.evidenceBody;

  if (finReg.processingHint === "RETRY_PENDING") {
    evidenceBody = stampProcessingMeta(evidenceBody, {
      state: "RETRY_PENDING",
      businessVerdict: "NONE",
      validationStatus: "REVALIDATION_PENDING",
    });
  } else if (finReg.processingHint === "REVIEW_HUMAN") {
    evidenceBody = stampProcessingMeta(evidenceBody, {
      state: "REVIEW_HUMAN",
      businessVerdict: "REVIEW_HUMAN",
      validationStatus: "CONFLICT_FOUND",
    });
  }

  const frontierReg =
    website && pagesVisited > 0
      ? buildFrontierFromCrawl({
          baseUrl: website,
          pagesVisited: audit.sitePages ?? [],
          policyPdfsQueued: audit.policyPdfsQueued ?? 0,
          policyPdfsRead: audit.policyPdfsRead ?? 0,
          needsOcrReview: crawlNeedsOcrReview,
          completeness: null,
          scanKey: lead.id,
        })
      : null;
  if (frontierReg) evidenceBody = stampFrontierSummary(evidenceBody, frontierReg);

  const piva = "piva" in lead ? (lead as { piva?: string | null }).piva || null : null;

    try {
    if (verdict === "PUBLISHED") {
      const regionalId = resolveRegionalIdentity({
        companyName: lead.companyName,
        city: lead.city,
        region: region ?? null,
        website,
        phone,
        vatId: piva,
        category: lead.category,
        siteText: evidenceBody,
      });
      const publishedEvidence = buildPublishedEmitEvidence({
        identityStatus: regionalId.status,
        pageUrl: audit.policyPdfUrl || audit.policySourceUrl || website,
        facilityWebsite: website,
        contentFetched: websiteReachable === true,
        contentExcerpt: evidenceBody.slice(0, 4000),
        docFingerprint: {
          facilityName: lead.companyName,
          municipality: lead.city,
          domain: website,
          seatPageUrl: website,
          vatId: piva,
          phone,
        },
        facilityFingerprint: {
          facilityName: lead.companyName,
          municipality: lead.city,
          domain: website,
          seatPageUrl: website,
          vatId: piva,
          phone,
        },
        policyObsolete: crawlPolicyObsolete,
        hasCoverageEnd: Boolean(policyExpiry),
        category: lead.category,
        criticalConflict: regionalId.status === "MISMATCH",
      });
      if (!regionalId.verified) {
        throw new PublishedGateError([`identità regionale ${regionalId.status}`]);
      }
      const prepared = prepareSanitaVerdictPersist({
        legacyVerdict: "PUBLISHED",
        evidenceBody,
        publishedEvidence,
      });
      evidenceBody = prepared.evidenceBody;
      verdict = prepared.legacyVerdict;
    } else if (verdict === "HOT") {
      const regionalId = resolveRegionalIdentity({
        companyName: lead.companyName,
        city: lead.city,
        region: region ?? null,
        website,
        category: lead.category,
        siteText: evidenceBody,
      });
      if (!regionalId.verified) {
        verdict = "REVIEW";
        evidenceBody = stampProcessingMeta(
          `Identità regionale insufficiente (${regionalId.status}). ${evidenceBody}`,
          {
            state: "REVIEW_HUMAN",
            businessVerdict: "REVIEW_HUMAN",
            validationStatus: "CONFLICT_FOUND",
          }
        );
      } else {
      const hotEvidence = {
        website,
        websiteReachable,
        pagesVisited,
        policyExhaustive: crawlPolicyExhaustive === true,
        needsOcrReview: crawlNeedsOcrReview,
        crawlCompleteness: null as null,
        identityStatus: regionalId.status,
        category: lead.category,
        frontier: frontierReg,
      };
      assertAtomicHotPersist(verdict, hotEvidence);
      const prepared = prepareSanitaVerdictPersist({
        legacyVerdict: "HOT",
        evidenceBody,
        hotEvidence,
      });
      evidenceBody = prepared.evidenceBody;
      verdict = prepared.legacyVerdict;
      }
    } else if (!finReg.processingHint) {
      evidenceBody = stampProcessingMeta(evidenceBody, {
        state: "REVIEW_HUMAN",
        businessVerdict: "REVIEW_HUMAN",
        validationStatus: "CURRENT_VERIFIED",
      });
    }
  } catch (e) {
    if (e instanceof PublishedGateError) {
      verdict = "REVIEW";
      evidenceBody = stampProcessingMeta(`PUBLISHED gate: ${e.reasons.join("; ")}. ${evidenceBody}`, {
        state: "REVIEW_HUMAN",
        businessVerdict: "REVIEW_HUMAN",
        validationStatus: "CONFLICT_FOUND",
      });
    } else if (e instanceof HotIncompleteStopError) {
      throw e;
    } else {
      throw e;
    }
  }

  if (verdict === "PUBLISHED" && policyFound) bumpCounter(counters, "published");
  else if (verdict === "HOT") bumpCounter(counters, "hot");
  else if (finReg.processingHint === "RETRY_PENDING") bumpCounter(counters, "retryPending");
  else bumpCounter(counters, "reviewHuman");

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      website,
      city: lead.city,
      phone,
      email,
      pec,
      websiteReachable,
      pagesVisited,
      ...policyDbFields(verdict, {
        policyFound,
        policyObsolete: crawlPolicyObsolete,
        company: policyCompany,
        massimale: policyMassimale,
        policyNumber,
        expiry: policyExpiry,
        confidence,
      }),
      leadScore: scoreLead({
        verdict,
        phone,
        email,
        pec,
        expiry: policyExpiry,
        obsoletePolicy: crawlPolicyObsolete,
      }),
      evidence:
        finReg.processingHint === "RETRY_PENDING"
          ? packRetryPendingEvidence(evidenceBody, audit)
          : packEvidence(verdict, evidenceBody, audit),
      lastScannedAt: new Date(),
    },
  });
}

export async function markNoWebsiteReview(
  region: Region,
  cityFilter: { city?: string },
  deadline: number
) {
  if (!isRegionalCheckAvailable() && Date.now() < deadline) {
    const pending = await prisma.lead.findMany({
      where: {
        type: "HEALTHCARE",
        region,
        ...cityFilter,
        website: null,
        lastScannedAt: null,
      },
      take: 20,
    });
    for (const lead of pending) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          lastScannedAt: new Date(),
          evidence: packEvidence(
            "REVIEW",
            "Nessun sito web in anagrafica. Tavily non attivo — configurare TAVILY_API_KEY e riavviare.",
            { mapsLookup: true }
          ),
          leadScore: scoreLead({
            verdict: "REVIEW",
            phone: lead.phone,
            email: lead.email,
            pec: lead.pec,
          }),
        },
      });
    }
  }
}

/** Pipeline per lead Maps: crawl sito dalla scheda → verdetto Gelli. */
export async function completeLeadAnalysis(lead: Lead, region: Region, counters: ScanCounters) {
  const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
  if (!fresh || fresh.lastScannedAt) return;
  lead = fresh;

  if (!lead.website) {
    const resolved = await resolveOfficialWebsite(lead.companyName, lead.city, region, {
      deadline: Date.now() + 120_000,
      mapsCardWebsite: lead.website,
      mapsCardTrusted: Boolean(lead.osmId?.startsWith("gmaps/")),
    });
    if (resolved.website) {
      const website =
        trustStoredWebsite(resolved.website) ??
        acceptDiscoveredWebsite(resolved.website, lead.companyName) ??
        normalizeWebsite(resolved.website);
      lead = {
        ...lead,
        companyName: resolved.companyName,
        city: resolved.city ?? lead.city,
        phone: resolved.phone ?? lead.phone,
        website,
      };
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          companyName: resolved.companyName,
          website,
          city: lead.city,
          phone: lead.phone,
        },
      });
    }
  }

  if (lead.website) {
    try {
      await analyzeLead({ ...lead, region, osmId: lead.osmId }, counters);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransientAnalysisFailure(msg)) throw err;
      console.error(`  [completeLeadAnalysis] analyzeLead failed for ${lead.companyName}:`, msg);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          lastScannedAt: new Date(),
          evidence: packEvidence(
            "REVIEW",
            `Errore durante analisi sito: ${err instanceof Error ? err.message : "errore sconosciuto"} — verifica manuale necessaria.`,
            { mapsLookup: true }
          ),
          leadScore: scoreLead({ verdict: "REVIEW", phone: lead.phone, email: lead.email, pec: lead.pec }),
        },
      }).catch(() => {});
      counters.review++;
      return;
    }
    const after = await prisma.lead.findUnique({
      where: { id: lead.id },
      select: { lastScannedAt: true },
    });
    if (after?.lastScannedAt) return;
  }

  const again = await prisma.lead.findUnique({ where: { id: lead.id } });
  if (!again || again.lastScannedAt) return;

  if (isRegionalCheckAvailable()) {
    try {
      await analyzeRegional(again, region, counters);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransientAnalysisFailure(msg)) throw err;
      console.error(`  [completeLeadAnalysis] analyzeRegional failed for ${lead.companyName}:`, msg);
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          lastScannedAt: new Date(),
          evidence: packEvidence(
            "REVIEW",
            `Errore durante verifica portali regionali: ${err instanceof Error ? err.message : "errore sconosciuto"} — verifica manuale.`,
            { mapsLookup: true }
          ),
          leadScore: scoreLead({ verdict: "REVIEW", phone: lead.phone, email: lead.email, pec: lead.pec }),
        },
      }).catch(() => {});
      counters.review++;
    }
    return;
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastScannedAt: new Date(),
      evidence: packEvidence(
        "REVIEW",
        "Nessun sito web individuato su Maps/ricerca — verifica manuale prima di classificare il lead.",
        { mapsLookup: true }
      ),
      leadScore: scoreLead({ verdict: "REVIEW", phone: lead.phone, email: lead.email, pec: lead.pec }),
    },
  });
  counters.review++;
}
