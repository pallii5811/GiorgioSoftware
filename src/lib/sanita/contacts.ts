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
  found: ParsedContacts
) {
  const nonPec = found.emails.filter((e) => e !== found.pec);
  return {
    phone: existing.phone || found.phones[0] || null,
    email: existing.email || nonPec[0] || found.pec || null,
    pec: existing.pec || found.pec || null,
    website: existing.website || found.website || null,
  };
}
