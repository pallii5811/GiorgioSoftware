import type { CrawlResult } from "@/lib/sanita/crawler";
import { mapsNameVariants, mapsNamesMatch } from "@/lib/sanita/maps-query";
import { isBlockedWebsiteHost } from "@/lib/sanita/website";

const PUBLIC_ENTITY = /\b(asl|aulss|ausl|distretto|presidio|poliambulatorio|ospedale\s+pubblico)\b/i;
const PRIVATE_ENTITY = /\b(casa di cura|clinica|rsa|riposo|privat|s\.?p\.?a\.?|s\.?r\.?l\.?)\b/i;
/** Siti di fondazioni/enti che gestiscono più strutture — Maps spesso mette l'URL padre. */
const PARENT_ORG_HOST =
  /fondaz|(?:^|\.)fapc\.|caritas|assistenz.*carit|onlus\.|cooperativ.*sociale|ente\s+religios|lilt\./i;

/** Domini tipici hotel/monastero/turismo — Maps li associa erroneamente a RSA. */
const HOSPITALITY_HOST =
  /(?:^|[.-])(?:hotel|albergo|resort|monastero|monastery|bb-|bnb|agritur|ostello|motel|hostel|hospitality)/i;

const HOSPITALITY_CORPUS =
  /\b(hotel|albergo|soggiorno|camera\s+e\s+colazione|suite|colazione|check[\s-]?in|prenotaz|ospiti\s+turist|monastero\s+di|convento)\b/i;

const HEALTH_CORPUS =
  /\b(sanitar|rsa|riposo|assistenz|infermier|degent|pazient|visita\s+medic|poliambulator|terapia|reparto)\b/i;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "casa", "cura", "clinica", "ospedale", "centro", "villa", "san", "santa", "santo",
  "di", "de", "del", "della", "privata", "spa", "srl", "societa", "onlus", "coop",
]);

function distinctiveTokens(name: string): string[] {
  return norm(name)
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Il testo del sito cita il nome della struttura? */
export function companyNameOnSite(companyName: string, crawlText: string): boolean {
  const text = norm(crawlText).slice(0, 12_000);
  if (!text) return false;

  for (const variant of mapsNameVariants(companyName)) {
    const v = norm(variant);
    if (v.length < 4) continue;
    if (text.includes(v)) return true;
    if (mapsNamesMatch(variant, crawlText.slice(0, 2000))) return true;
  }

  const tokens = distinctiveTokens(companyName);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => text.includes(t));
  if (tokens.length === 1) return hits.length >= 1 && hits[0].length >= 8;
  return hits.length >= 2;
}

export type SiteIdentityResult = {
  ok: boolean;
  reason: string;
};

/**
 * Il sito crawllato è quello della struttura indicata?
 * Evita HOT su domini errati (omonimie Maps, carabinieri.it, ecc.).
 */
function cityOnSite(city: string | null | undefined, crawlText: string): boolean {
  if (!city?.trim()) return true;
  const c = norm(city);
  if (c.length < 3) return true;
  const text = norm(crawlText);
  if (text.includes(c)) return true;
  // "Giugliano in Campania" → accetta "giugliano"
  const head = c.split(" ")[0];
  return head.length >= 5 && text.includes(head);
}

export function validateSiteIdentity(
  companyName: string,
  website: string,
  crawl: CrawlResult,
  city?: string | null
): SiteIdentityResult {
  let host: string;
  try {
    host = new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return { ok: false, reason: "URL sito non valido" };
  }

  if (isBlockedWebsiteHost(host)) {
    return { ok: false, reason: `Sito non istituzionale (${host})` };
  }

  const isPublicName = PUBLIC_ENTITY.test(companyName);
  const isPrivateName = PRIVATE_ENTITY.test(companyName);

  if (HOSPITALITY_HOST.test(host) && isPrivateName && !isPublicName) {
    return {
      ok: false,
      reason: "Sito alberghiero/monastero — URL Maps errato per struttura sanitaria",
    };
  }

  const isAslHost = /^(asl|aulss|ausl)/i.test(host) || /\.asl\./i.test(host) || host.includes("salute.gov");

  if (isAslHost && isPrivateName && !isPublicName) {
    return { ok: false, reason: "Portale ASL associato a struttura privata — URL errato" };
  }

  if (!crawl.ok) {
    return { ok: false, reason: "Sito non raggiungibile" };
  }

  const corpus = `${crawl.text} ${crawl.policyText}`.trim();
  if (!companyNameOnSite(companyName, corpus)) {
    return {
      ok: false,
      reason: "Nome struttura assente nel sito analizzato — probabile sito errato (omonimia Maps)",
    };
  }

  if (HOSPITALITY_CORPUS.test(corpus) && !HEALTH_CORPUS.test(corpus) && isPrivateName && !isPublicName) {
    return {
      ok: false,
      reason: "Contenuti tipici di hotel/turismo — sito non sanitario (URL Maps errato)",
    };
  }

  if (PARENT_ORG_HOST.test(host) && isPrivateName && !isPublicName) {
    return {
      ok: false,
      reason:
        "Sito di fondazione/ente padre — non il sito istituzionale della singola struttura (URL Maps errato)",
    };
  }

  if (!cityOnSite(city, corpus)) {
    // Sede legale spesso ≠ comune su Maps (es. Pineta Castel Volturno, sito dice solo "Napoli").
    // Se nome struttura + Trasparenza ok, non bloccare HOT/REVIEW solo per comune assente.
    if (crawl.foundRelevantPage && companyNameOnSite(companyName, corpus)) {
      return { ok: true, reason: "Identità sito confermata (nome + Trasparenza; comune non in homepage)" };
    }
    return {
      ok: false,
      reason: `Città attesa (${city}) non trovata sul sito — probabile omonimia o URL errato`,
    };
  }

  return { ok: true, reason: "Identità sito confermata" };
}

/** Crawl sufficiente per affermare assenza polizza (Trasparenza + PDF policy). */
export function crawlDepthSufficient(crawl: CrawlResult): { ok: boolean; reason: string } {
  if (!crawl.foundRelevantPage) {
    return { ok: false, reason: "Sezione Trasparenza/polizza non trovata sul sito" };
  }
  if (!crawl.policyExhaustive) {
    return {
      ok: false,
      reason: `Crawl non esaustivo (${crawl.policyPdfsRead}/${crawl.policyPdfsQueued} PDF)`,
    };
  }
  if (crawl.needsOcrReview) {
    return { ok: false, reason: "PDF policy scannerizzato — OCR richiesto" };
  }
  return { ok: true, reason: "Trasparenza e tutti i PDF policy analizzati" };
}
