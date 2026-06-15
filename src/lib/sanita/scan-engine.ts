import { prisma } from "@/lib/prisma";
import { normalizeWebsite, type Region } from "@/lib/sanita/discovery";
import { isBlockedWebsiteHost } from "@/lib/sanita/website";
import { resolveOfficialWebsite } from "@/lib/sanita/resolve-website";
import { resolveWebsiteViaMaps } from "@/lib/sanita/maps-discovery";
import { extractCityFromMapsAddress } from "@/lib/sanita/maps-query";
import type { MapsPlace } from "@/lib/sanita/playwright-maps";
import { crawlSite } from "@/lib/sanita/crawler";
import { analyzeCrawlPolicy, reconcilePolicyVerdict } from "@/lib/sanita/policy-verify";
import { checkRegionalPolicy, isRegionalCheckAvailable } from "@/lib/sanita/regional-check";
import { enrichContacts } from "@/lib/sanita/contact-enrichment";
import { mergeContacts, pickBestPhone } from "@/lib/sanita/contacts";
import { packEvidence, type AuditSources } from "@/lib/sanita/audit";
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

function applyMapsEnrichment<
  T extends { phone: string | null; city: string | null },
>(lead: T, maps: MapsPlace, audit: AuditSources): { lead: T; website: string | null } {
  audit.mapsLookup = true;
  const website = normalizeWebsite(maps.website ?? undefined);
  const patched = { ...lead };
  if (!patched.phone && maps.phone) patched.phone = maps.phone;
  const mapsCity = extractCityFromMapsAddress(maps.address);
  if (mapsCity) patched.city = mapsCity;
  return { lead: patched, website };
}

export async function runBatch<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await Promise.all(chunk.map(worker));
  }
}

export async function analyzeLead(
  lead: {
    id: string;
    osmId?: string;
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
  const mapsCardTrusted = Boolean(lead.osmId?.startsWith("gmaps/") && lead.website);

  const resolved = await resolveOfficialWebsite(
    lead.companyName,
    lead.city,
    lead.region as Region,
    {
      deadline: Date.now() + 65_000,
      mapsCardWebsite: lead.website,
      mapsCardTrusted: mapsCardTrusted,
    }
  );

  if (resolved.source === "google") audit.googleSearch = true;
  if (resolved.source === "maps-card" || resolved.source === "maps-lookup") audit.mapsLookup = true;

  const website = resolved.website;
  const mapsVerified =
    resolved.source === "maps-card" || resolved.source === "maps-lookup";

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

  let analysis = analyzeCrawlPolicy(crawl);
  let verdict: Verdict = verdictFromSite({
    reachable: true,
    policyFound: analysis.policyFound,
    foundRelevantPage: crawl.foundRelevantPage,
  });
  const reconciled = reconcilePolicyVerdict(crawl, analysis, verdict, {
    companyName: lead.companyName,
    website,
    city: lead.city,
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
      verdict = "PUBLISHED";
      analysis = { ...analysis, ...regional, policyFound: true };
      evidenceBody = `Polizza trovata su portale regionale/ASL ma non sul sito web — sito non aggiornato. ${regional.evidence || ""}`;
    } else if (regional.checked) {
      evidenceBody = `Sito: polizza non pubblicata in Trasparenza. Portali ASL/regionali: confermata assenza pubblicazione. ${analysis.evidence || ""}`;
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
  let website = lead.website;
  let mapsAlready = false;

  if (!website) {
    const maps = await resolveWebsiteViaMaps(lead.companyName, lead.city, region, {
      deadline: Date.now() + 40_000,
      maxQueries: 4,
    });
    if (maps) {
      mapsAlready = true;
      const applied = applyMapsEnrichment({ phone, email, pec, city: lead.city }, maps, audit);
      phone = applied.lead.phone;
      website = applied.website;
      if (applied.lead.city) lead = { ...lead, city: applied.lead.city };
    }
  }

  if (!website || !phone || !email) {
    const enriched = await enrichContacts(lead.companyName, lead.city, region, { skipMaps: mapsAlready });
    if (enriched.checked) {
      const m = mergeContacts({ phone, email, pec, website }, enriched.contacts, region);
      phone = m.phone;
      email = m.email;
      pec = m.pec;
      if (!website && m.website) website = m.website;
      audit.contactSearch = true;
      audit.contactUrls = enriched.sourceUrls;
    }
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
  let verdict: Verdict = verdictFromRegional({ checked: true, policyFound: result.policyFound });
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
          verdict = "PUBLISHED";
          policyFound = true;
          policyCompany = regional.company || policyCompany;
          policyMassimale = regional.massimale || policyMassimale;
          policyNumber = regional.policyNumber || policyNumber;
          policyExpiry = regional.expiry || policyExpiry;
          confidence = regional.confidence ?? confidence;
        }
      }
      const m = mergeContacts({ phone, email, pec, website }, {
        emails: crawl.emails,
        pec: crawl.pec,
        phones: crawl.phones,
        website,
      });
      phone = m.phone;
      email = m.email;
      pec = m.pec;
    } else {
      websiteReachable = false;
      if (result.policyFound) {
        verdict = "PUBLISHED";
        policyFound = true;
        evidenceBody = `Polizza su portale regionale/ASL; sito web non raggiungibile (${website}). ${result.evidence ?? ""}`;
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
    evidenceBody = `Sito web non trovato in anagrafica né via ricerca. Portali ASL consultati: polizza RC non pubblicata (Art. 10 Gelli). ${evidenceBody ?? ""}`;
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

  if (lead.website) {
    await analyzeLead({ ...lead, region, osmId: lead.osmId }, counters);
    const after = await prisma.lead.findUnique({
      where: { id: lead.id },
      select: { lastScannedAt: true },
    });
    if (after?.lastScannedAt) return;
  }

  const again = await prisma.lead.findUnique({ where: { id: lead.id } });
  if (!again || again.lastScannedAt) return;

  if (isRegionalCheckAvailable()) {
    await analyzeRegional(again, region, counters);
    return;
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastScannedAt: new Date(),
      evidence: packEvidence(
        "HOT",
        "Nessun sito web su Google Maps — obbligo pubblicazione Art. 10 non rispettato online.",
        { mapsLookup: true }
      ),
      leadScore: scoreLead({ verdict: "HOT", phone: lead.phone, email: lead.email, pec: lead.pec }),
    },
  });
  counters.hot++;
}
