import { prisma } from "@/lib/prisma";
import { normalizeWebsite, type Region } from "@/lib/sanita/discovery";
import { alternateBrandTldUrls, isBlockedWebsiteHost } from "@/lib/sanita/website";
import { companyNameOnSite } from "@/lib/sanita/site-identity";
import { policyTextFromCrawl } from "@/lib/sanita/policy-verify";
import { resolveOfficialWebsite } from "@/lib/sanita/resolve-website";
import { probeGuessedOfficialWebsite } from "@/lib/sanita/guess-website";
import { resolveWebsiteViaMaps } from "@/lib/sanita/maps-discovery";
import { extractCityFromMapsAddress } from "@/lib/sanita/maps-query";
import { crawlSite } from "@/lib/sanita/crawler";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "@/lib/sanita/policy-verify";
import { checkRegionalPolicy, isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { enrichContacts, findOfficialWebsite } from "@/lib/sanita/contact-enrichment";
import { isTransientAnalysisFailure } from "@/lib/sanita/scan-errors";
import { mergeContacts, pickBestPhone, pickOfficialWebsite } from "@/lib/sanita/contacts";
import { packEvidence, pickPolicySourceUrl, pickPolicyPdfUrl, type AuditSources } from "@/lib/sanita/audit";
import { isSiteUnderMaintenance } from "@/lib/sanita/website";
import { verdictFromSite, verdictFromRegional } from "@/lib/sanita/verdict";
import type { Verdict } from "@/lib/sanita/verdict";
import { scoreLead } from "@/lib/sanita/score";
import type { Lead } from "@prisma/client";

import type { PolicyAnalysis } from "@/lib/sanita/detector";

export type ScanCounters = {
  analyzed: number;
  withPolicy: number;
  hot: number;
  review: number;
  regionalChecked: number;
  regionalWithPolicy: number;
};

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

/** HOT/REVIEW: mai campi polizza in UI/DB. Solo PUBLISHED con polizza confermata. */
function policyDbFields(
  verdict: Verdict,
  a: Pick<
    PolicyAnalysis,
    "policyFound" | "policyObsolete" | "company" | "massimale" | "policyNumber" | "expiry" | "confidence"
  >
) {
  const keep = verdict === "PUBLISHED" && Boolean(a.policyFound);
  return {
    policyFound: keep,
    policyCompany: keep ? a.company : null,
    policyMassimale: keep ? a.massimale : null,
    policyNumber: keep ? a.policyNumber : null,
    policyExpiry: keep ? a.expiry : null,
    confidence: keep ? (a.confidence ?? 1) : null,
  };
}

export async function runBatch<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await Promise.all(
      chunk.map((item) =>
        worker(item).catch((err) => {
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
  counters: Pick<ScanCounters, "analyzed" | "withPolicy" | "hot" | "review">
) {
  const audit: AuditSources = { mapsLookup: true };
  const mapsWebsite = lead.website ? normalizeWebsite(lead.website) : null;
  let website: string | null =
    mapsWebsite && pickOfficialWebsite([mapsWebsite], lead.companyName) ? mapsWebsite : null;
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

    website =
      resolved.website && pickOfficialWebsite([resolved.website], lead.companyName)
        ? resolved.website
        : null;
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

  const crawl = await crawlSite(website);
  counters.analyzed++;

  if (!crawl.ok) {
    let phone = lead.phone;
    let email = lead.email;
    let pec = lead.pec;
    let verdict: Verdict = "REVIEW";
    let evidenceBody =
      "Sito irraggiungibile — impossibile verificare la pubblicazione Art. 10 Gelli sul sito istituzionale.";

    if (isRegionalCheckAvailable()) {
      audit.crossCheckRegional = true;
      const regional = await checkRegionalPolicy(lead.companyName, lead.city, lead.region);
      audit.regionalQueries = regional.queryCount;
      audit.regionalUrls = regional.sourceUrls;
      if (regional.policyFound) {
        verdict = "PUBLISHED";
        evidenceBody = `Polizza trovata su portale regionale/ASL; sito web non raggiungibile. ${regional.evidence || ""}`;
      } else if (regional.checked) {
        verdict = "REVIEW";
        evidenceBody = `Sito irraggiungibile — portali ASL consultati ma crawl sito necessario per certificare assenza polizza. ${regional.evidence || ""}`;
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

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        website,
        city: lead.city,
        websiteReachable: false,
        policyFound: verdict === "PUBLISHED",
        confidence: 0,
        pagesVisited: 0,
        phone,
        email,
        pec,
        evidence: packEvidence(verdict, evidenceBody, audit),
        leadScore: scoreLead({ verdict, phone, email, pec }),
        lastScannedAt: new Date(),
      },
    });
    if (verdict === "PUBLISHED") counters.withPolicy++;
    else if (verdict === "HOT") counters.hot++;
    else counters.review++;
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
  let evidenceBody = analysis.evidence;
  if (reconciled.note) {
    evidenceBody = `${reconciled.note} ${evidenceBody ?? ""}`.trim();
  }

  if (verdict === "HOT" && isRegionalCheckAvailable()) {
    audit.crossCheckRegional = true;
    const regional = await checkRegionalPolicy(lead.companyName, lead.city, lead.region);
    audit.regionalQueries = regional.queryCount;
    audit.regionalUrls = regional.sourceUrls;
    if (regional.policyFound) {
      verdict = "REVIEW";
      evidenceBody = `Portale regionale/ASL: possibile polizza ma PDF RC non sul sito — verifica manuale. ${regional.evidence || ""}`;
    } else if (regional.checked) {
      evidenceBody = `Sito: polizza non pubblicata in Trasparenza. Portali ASL/regionali: confermata assenza pubblicazione. ${analysis.evidence || ""}`;
    }
  }

  // Polizza assente su .it/.com Maps — prova il TLD gemello (stesso brand nel nome).
  if (!analysis.policyFound && (verdict === "HOT" || verdict === "REVIEW")) {
    for (const altUrl of alternateBrandTldUrls(website, lead.companyName)) {
      const altCrawl = await crawlSite(altUrl);
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

  if (verdict === "PUBLISHED") counters.withPolicy++;
  else if (verdict === "HOT") counters.hot++;
  else counters.review++;

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
      evidence: packEvidence(verdict, evidenceBody, audit),
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
    const crawl = await crawlSite(website);
    pagesVisited = crawl.pagesVisited.length;
    if (crawl.ok) {
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
      if (siteVerdict === "PUBLISHED" && siteAnalysis.policyFound) {
        policyFound = true;
        policyCompany = siteAnalysis.company || policyCompany;
        policyMassimale = siteAnalysis.massimale || policyMassimale;
        policyNumber = siteAnalysis.policyNumber || policyNumber;
        policyExpiry = siteAnalysis.expiry || policyExpiry;
        confidence = siteAnalysis.confidence ?? 1;
      } else if (siteVerdict === "HOT") {
        policyFound = false;
        policyCompany = null;
        policyMassimale = null;
        policyNumber = null;
        policyExpiry = null;
        confidence = null;
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
      if (verdict === "HOT" && isRegionalCheckAvailable()) {
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
      if (result.policyFound) {
        verdict = "REVIEW";
        policyFound = false;
        evidenceBody = `Portale regionale/ASL: possibile polizza ma sito irraggiungibile e PDF non verificato (${website}). ${result.evidence ?? ""}`;
      } else if (result.checked && verdict === "HOT") {
        evidenceBody = `Sito irraggiungibile (${website}); assenza polizza confermata su portali ASL/regionali (Art. 10 Gelli). ${result.evidence ?? ""}`;
      } else if (verdict === "HOT") {
        verdict = "REVIEW";
        evidenceBody = `Sito web non raggiungibile (${website}) — verifica portali non conclusiva. ${result.evidence ?? ""}`;
      }
    }
  }

  const siteWasObsolete = Boolean(website && !policyFound);
  if (policyFound && !result.policyFound && website) {
    // Polizza trovata sul sito: il messaggio non deve riportare l'esito negativo dei portali.
    evidenceBody = `Polizza RC rilevata sul sito ufficiale (${website}) — scan multi-pass Trasparenza/PDF/HTML.`;
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

  if (verdict === "PUBLISHED" && policyFound && !result.policyFound) counters.withPolicy++;
  else if (verdict === "HOT") counters.hot++;
  else if (verdict === "REVIEW") counters.review++;

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
        policyObsolete: !policyFound && siteWasObsolete,
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
        obsoletePolicy: !policyFound && siteWasObsolete,
      }),
      evidence: packEvidence(verdict, evidenceBody, audit),
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
