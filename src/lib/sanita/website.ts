/** Validazione e normalizzazione URL sito istituzionale. */

const BLOCKED_HOST =
  /facebook|instagram|linkedin|youtube|twitter|google\.|support\.google|wikipedia|paginegialle|paginesi\.it|pagineinformazioni|tripadvisor|dati\.salute|tavily|booking\.|trip\.com|carabinieri\.it|governo\.it$|doctolib|miodottore|dottori\.it|idoctors|paginemediche|paginebianche|prontopro|trustpilot|cylex|misterimprese|virgilio\.it|yelp\.|poliambulatorio\.com|clinicamedicalcenter\.com|^felice\.com$|^delta\.it$|^salus\.com$|^salus\.it$|^quiete\.it$|^siti\.it$|^food\.it$|navigarefacile\.it|^telefono\.it$|^telefono\.com$|^sale\.it$|^oasi\.com$|^srls\.com$|^suap\.com$|^roccarainola\.com$|^clinicamedica\.it$|^morcone\.com$|^gallomatese\.com$|^villafiori\.it$|\.comune\.|aslnapoli|aslnapo|grupposandonato|retesolidale|servizionline\.i|fedcp\.org|studiomedicoprivato/i;

/** Host di parking / marketplace domini — non sono siti istituzionali. */
const PARKED_HOST =
  /(?:^|\.)(?:forsale|sedoparking|sedo|afternic|hugedomains|dan\.com|undevelopeddomains|parked|godaddy|namecheap|domainmarket|buydomains|fabulous)\./i;

const PARKED_PAGE_TEXT =
  /domain\s+(?:is\s+)?for\s+sale|this\s+domain|buy\s+this\s+domain|get\s+this\s+domain|domain\s+parked|parked\s+free|in\s+vendita|dominio\s+in\s+vendita|acquista\s+questo\s+dominio|registered\s+with\s+godaddy|forsale\.godaddy|is\s+available\s+for\s+purchase/i;

export function isBlockedWebsiteHost(host: string): boolean {
  const h = host.replace(/^www\./i, "").toLowerCase();
  return BLOCKED_HOST.test(h) || PARKED_HOST.test(h);
}

export function isParkedWebsiteHost(host: string): boolean {
  const h = host.replace(/^www\./i, "").toLowerCase();
  return PARKED_HOST.test(h);
}

/** Pagina HTML di dominio parcheggiato / in vendita / redirect stub (non sito clinica). */
export function isParkedOrForSalePage(html: string, pageUrl?: string): boolean {
  if (pageUrl) {
    try {
      if (isParkedWebsiteHost(new URL(pageUrl).hostname)) return true;
    } catch {
      /* URL malformato */
    }
  }
  const raw = html.slice(0, 24_000);
  if (PARKED_PAGE_TEXT.test(raw)) return true;
  if (/forsale\.godaddy|sedo\.com|afternic\.com|hugedomains\.com/i.test(raw)) return true;
  if (/window\.(?:onload|location)[\s\S]{0,80}["']\/lander["']/i.test(raw)) return true;
  if (/window\.location\.href\s*=\s*["']https?:\/\/forsale/i.test(raw)) return true;

  const visible = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (visible.length < 60 && /\/lander|godaddy|sedo|parked|for\s*sale/i.test(raw)) return true;
  return false;
}

/** WAF/CAPTCHA (BitNinja ecc.) — il sito esiste ma il crawler datacenter è bloccato. */
export function isBotBlockedPage(html: string, pageUrl?: string): boolean {
  const raw = html.slice(0, 32_000);
  if (/bitninja|anti-robot|visitor anti-robot|risolvere il captcha|controlo di sicurezza di bitninja/i.test(raw))
    return true;
  if (/cf-browser-verification|challenge-platform|just a moment\.\.\.|attention required.*cloudflare/i.test(raw))
    return true;
  return false;
}

/** Placeholder "sito in manutenzione" — non è contenuto istituzionale analizzabile. */
export function isSiteUnderMaintenance(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 30) return false;
  const maintenance =
    /sito\s+(?:web\s+)?in\s+(?:manutenzione|costruzione)|under\s+construction|coming\s+soon|temporaneamente\s+(?:non\s+)?disponibile|sito\s+in\s+aggiornamento|sar[aà]\s+presto\s+disponibile/i.test(
      t
    );
  if (!maintenance) return false;
  return !/art\.?\s*10|legge\s+gelli|polizza\s+(?:n\.?|numero)|copertura\s+assicurativa|responsabilit[aà]\s+civile.{0,80}(?:massimale|rct|rco|€)/i.test(
    t
  );
}

/**
 * Stesso brand su TLD diverso (es. nepheocare.it ↔ nepheocare.com).
 * Solo se l'host compare nel nome azienda — evita omonimie tra domini diversi.
 */
export function alternateBrandTldUrls(website: string, companyName: string): string[] {
  const norm = normalizeOfficialWebsite(website);
  if (!norm) return [];
  try {
    const host = new URL(norm).hostname.replace(/^www\./i, "").toLowerCase();
    const dot = host.lastIndexOf(".");
    if (dot <= 0) return [];
    const label = host.slice(0, dot);
    const tld = host.slice(dot + 1);
    if (tld !== "it" && tld !== "com") return [];
    if (!/^[a-z0-9][a-z0-9-]{4,}[a-z0-9]$/i.test(label)) return [];
    const labelFlat = label.replace(/-/g, "");
    const co = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (labelFlat.length < 6 || co.length < 4) return [];
    if (!co.includes(labelFlat) && !labelFlat.includes(co.slice(0, Math.min(labelFlat.length, co.length)))) {
      return [];
    }
    const altTld = tld === "it" ? "com" : "it";
    const out: string[] = [];
    for (const h of [`www.${label}.${altTld}`, `${label}.${altTld}`]) {
      const candidate = normalizeOfficialWebsite(`https://${h}/`);
      if (candidate && candidate !== norm) out.push(candidate);
    }
    return out;
  } catch {
    return [];
  }
}

export function normalizeOfficialWebsite(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\./i, "");
    if (isBlockedWebsiteHost(host)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
