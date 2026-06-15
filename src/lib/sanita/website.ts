/** Validazione e normalizzazione URL sito istituzionale. */

const BLOCKED_HOST =
  /facebook|instagram|linkedin|youtube|twitter|google\.|support\.google|wikipedia|paginegialle|paginesi\.it|pagineinformazioni|tripadvisor|dati\.salute|tavily|booking\.|trip\.com|carabinieri\.it|governo\.it$|doctolib|miodottore|dottori\.it|idoctors|paginemediche|paginebianche|prontopro|trustpilot|cylex|misterimprese|virgilio\.it|yelp\./i;

export function isBlockedWebsiteHost(host: string): boolean {
  const h = host.replace(/^www\./i, "").toLowerCase();
  return BLOCKED_HOST.test(h);
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
