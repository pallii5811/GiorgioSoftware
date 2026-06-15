import { mapsPrimaryName } from "@/lib/sanita/maps-query";
import { normalizeOfficialWebsite } from "@/lib/sanita/website";

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
  /facebook|instagram|linkedin|youtube|twitter|google\.|wikipedia|paginegialle|tripadvisor|dati\.salute|regione\.|tavily|asl|aulss|soresa/i;

/** Sceglie il sito istituzionale più probabile tra gli URL Tavily/snippet. */
export function pickOfficialWebsite(urls: string[], companyName: string): string | null {
  const tokens = mapsPrimaryName(companyName)
    .toLowerCase()
    .replace(/srl|spa|s\.p\.a\.?|s\.r\.l\.?/gi, "")
    .replace(/[^a-zàèéìòù0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  let best: { url: string; score: number } | null = null;

  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (BLOCKED_HOST.test(host)) continue;

      let score = 0;
      let tokenHits = 0;
      const hostCompact = host.replace(/[^a-z0-9]/g, "");
      for (const t of tokens) {
        const tc = t.replace(/[^a-z0-9]/g, "");
        if (tc.length >= 4 && hostCompact.includes(tc.slice(0, Math.min(tc.length, 8)))) {
          score += 4;
          tokenHits++;
        }
      }
      if (tokenHits === 0) continue;
      if (/\.(it|com)$/.test(host)) score += 1;
      if (u.pathname === "/" || u.pathname.length < 20) score += 1;

      const normalized = normalizeOfficialWebsite(u.toString());
      if (!normalized) continue;
      if (!best || score > best.score) best = { url: normalized, score };
    } catch {
      /* ignore */
    }
  }

  if (!best) return null;
  if (tokens.length === 0) return best.score >= 1 ? best.url : null;
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
