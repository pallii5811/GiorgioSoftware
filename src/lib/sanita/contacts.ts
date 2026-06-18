import { mapsNameVariants, mapsSubsidiaryName } from "@/lib/sanita/maps-query";
import { normalizeOfficialWebsite } from "@/lib/sanita/website";
import type { TavilyHit } from "@/lib/sanita/tavily-client";

/** Estrazione contatti da testo (sito, snippet Tavily, OSM). */

const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+39[\s.\-]?)?(?:0\d{1,3}[\s.\-\/]?\d{5,8}|3\d{2}[\s.\-]?\d{6,7})/g;

function isPec(email: string): boolean {
  const e = email.toLowerCase();
  const [local, domain = ""] = e.split("@");
  return (
    local === "pec" ||
    domain.startsWith("pec.") ||
    /pec|legalmail|postacert|arubapec|postecert|sicurezzapostale|cert\./.test(domain)
  );
}

function cleanPhone(raw: string): string {
  return raw
    .replace(/[^\d+]/g, "")
    .replace(/^\+39/, "")
    .replace(/^0039/, "")
    .replace(/^\+/, "");
}

const REGION_AREA_CODES: Record<string, string[]> = {
  Campania: ["081", "0823", "0824", "0825", "0827", "0828", "089", "0831", "0835", "0836"],
  Veneto: [
    "041", "0421", "0422", "0423", "0424", "0425", "0426", "0432", "0434", "0438",
    "0442", "0444", "0445", "045", "0461", "0464", "0465", "0471", "049",
  ],
};

function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.startsWith("39") && d.length > 10 ? d.slice(2) : d;
}

/** Preferisce numeri con prefisso coerente con la regione (es. 0825 = Avellino). */
export function phoneMatchesRegion(phone: string, region: string | null | undefined): boolean {
  if (!region) return true;
  const prefixes = REGION_AREA_CODES[region];
  if (!prefixes) return true;
  const d = phoneDigits(phone);
  return prefixes.some((p) => d.startsWith(p));
}

export function formatItalianPhone(phone: string): string {
  const d = phoneDigits(phone);
  if (!d) return phone;
  if (d.startsWith("0")) {
    const prefix = REGION_AREA_CODES.Campania.concat(REGION_AREA_CODES.Veneto)
      .filter((p) => d.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return `${prefix} ${d.slice(prefix.length)}`.trim();
    if (d.length === 10) return `${d.slice(0, 4)} ${d.slice(4)}`;
  }
  if (d.length === 10 && d.startsWith("3")) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return phone;
}

/** Sito ufficiale > Maps; in Campania/Veneto scarta prefissi fuori regione. */
export function pickBestPhone(
  candidates: (string | null | undefined)[],
  region?: string | null
): string | null {
  const list = [...new Set(candidates.filter((c): c is string => Boolean(c?.trim())))];
  if (!list.length) return null;
  const ranked = [
    ...list.filter((p) => phoneMatchesRegion(p, region)),
    ...list.filter((p) => !phoneMatchesRegion(p, region)),
  ];
  return formatItalianPhone(ranked[0]);
}

export interface ParsedContacts {
  emails: string[];
  pec: string | null;
  phones: string[];
  website: string | null;
}

export function parseContactsFromText(text: string): ParsedContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();

  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/[.,;:]+$/, "");
    if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(e)) continue;
    if (/(example|sentry|wix|wordpress|domain)\./.test(e)) continue;
    emails.add(e);
  }

  for (const m of text.matchAll(PHONE_RE)) {
    const cleaned = cleanPhone(m[0]);
    const digits = cleaned.replace(/^\+/, "");
    if (digits.length === 11 && !cleaned.startsWith("+")) continue;
    if (digits.length >= 9 && digits.length <= 13) phones.add(cleaned);
  }

  const emailList = [...emails];
  const pec = emailList.find(isPec) ?? null;

  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0].replace(/[.,;)]+$/, ""));
  const website = pickOfficialWebsite(urls, "");

  return { emails: emailList, pec, phones: [...phones], website };
}

const BLOCKED_HOST =
  /facebook|instagram|linkedin|youtube|twitter|google\.|wikipedia|paginegialle|tripadvisor|dati\.salute|regione\.|tavily|asl|aulss|soresa|^rita\.(com|it|org|net)$/i;

function nameTokens(companyName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const variant of mapsNameVariants(companyName)) {
    for (const t of variant
      .toLowerCase()
      .replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "")
      .replace(/[^a-zàèéìòù0-9]+/g, " ")
      .split(/\s+/)) {
      if (t.length > 3 && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

function contentNameScore(companyName: string, text: string): number {
  const body = text.toLowerCase().slice(0, 2000);
  if (!body) return 0;
  let score = 0;
  for (const variant of mapsNameVariants(companyName)) {
    const v = variant.toLowerCase().replace(/[^a-zàèéìòù0-9\s]/g, " ").trim();
    if (v.length >= 6 && body.includes(v)) {
      score += 8;
      break;
    }
  }
  for (const t of nameTokens(companyName)) {
    const tc = t.replace(/[^a-z0-9]/g, "");
    if (tc.length >= 5 && body.includes(tc)) score += 3;
  }
  if (/sito\s+ufficiale|home\s?page|www\./i.test(body)) score += 1;
  if (/casa di cura|clinica|rsa|riposo|ospedale|centro\s+medico/i.test(body)) score += 1;
  return score;
}

function scoreWebsiteUrl(raw: string, companyName: string, content = ""): { url: string; score: number } | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (BLOCKED_HOST.test(host)) return null;

    const tokens = nameTokens(companyName);
    let score = contentNameScore(companyName, content);
    let tokenHits = 0;
    const hostCompact = host.replace(/[^a-z0-9]/g, "");
    for (const t of tokens) {
      const tc = t.replace(/[^a-z0-9]/g, "");
      if (tc.length >= 4 && hostCompact.includes(tc.slice(0, Math.min(tc.length, 8)))) {
        score += 4;
        tokenHits++;
      }
    }
    // Acronimo nel dominio (es. CDS per Centro Diagnostico Sanitario)
    if (tokenHits === 0 && tokens.length >= 2) {
      const acronym = tokens.map((t) => t[0]).join("");
      if (acronym.length >= 3 && hostCompact.includes(acronym)) {
        score += 5;
        tokenHits = 1;
      }
    }
    if (tokenHits === 0 && score < 6) return null;
    const sub = mapsSubsidiaryName(companyName);
    if (sub) {
      for (const t of sub
        .toLowerCase()
        .replace(/[^a-zàèéìòù0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 4)) {
        const tc = t.replace(/[^a-z0-9]/g, "");
        if (tc.length >= 5 && hostCompact.includes(tc)) score += 8;
      }
    }
    if (/\.(it|com)$/.test(host)) score += 1;
    if (u.pathname === "/" || u.pathname.length < 24) score += 1;

    const normalized = normalizeOfficialWebsite(u.toString());
    if (!normalized) return null;
    return { url: normalized, score };
  } catch {
    return null;
  }
}

/** Sceglie il sito istituzionale più probabile tra gli URL Tavily/snippet. */
export function pickOfficialWebsite(urls: string[], companyName: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const raw of urls) {
    const scored = scoreWebsiteUrl(raw, companyName);
    if (!scored) continue;
    if (!best || scored.score > best.score) best = scored;
  }
  if (!best) return null;
  const tokens = nameTokens(companyName);
  if (tokens.length === 0) return best.score >= 1 ? best.url : null;
  return best.score >= 5 ? best.url : null;
}

/** Come pickOfficialWebsite ma usa anche il testo degli snippet Tavily (Google web). */
export function pickOfficialWebsiteFromHits(hits: TavilyHit[], companyName: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const hit of hits) {
    if (!hit.url) continue;
    const scored = scoreWebsiteUrl(hit.url, companyName, `${hit.content} ${hit.url}`);
    if (!scored) continue;
    if (!best || scored.score > best.score) best = scored;
  }
  if (!best) return null;
  return best.score >= 5 ? best.url : null;
}

export function mergeContacts(
  existing: { phone?: string | null; email?: string | null; pec?: string | null; website?: string | null },
  found: ParsedContacts,
  region?: string | null
) {
  const nonPec = found.emails.filter((e) => e !== found.pec);
  return {
    phone: pickBestPhone([...found.phones, existing.phone], region),
    email: existing.email || nonPec[0] || found.pec || null,
    pec: existing.pec || found.pec || null,
    website: existing.website || found.website || null,
  };
}
