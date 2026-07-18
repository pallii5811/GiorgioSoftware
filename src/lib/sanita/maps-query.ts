/** Nome operativo dopo " - " (es. "Cdic Villa Esther" da "Pineta Grande - Cdic Villa Esther"). */
export function mapsSubsidiaryName(companyName: string): string | null {
  const parts = companyName.split(/\s+-\s+/);
  if (parts.length < 2) return null;
  const sub = parts
    .slice(1)
    .join(" - ")
    .replace(/\bcdic\b/gi, "casa di cura")
    .replace(/\s+/g, " ")
    .trim();
  // Scarta suffissi legali puri (es. "S.r.l..", "S.p.A.") — non sono nomi di sede operativa.
  const withoutLegal = sub
    .replace(/\b(s\.?p\.?a\.?|s\.?r\.?l\.?s?\.?|societ[aà][^-]*)\b/gi, "")
    .replace(/[.\s]+/g, " ")
    .trim();
  if (withoutLegal.length <= 3) return null;
  return sub.length > 4 ? sub : null;
}

/** Brand tra apici nel nome Min. Salute (es. 'Meluccio', 'Clinica S.Antimo'). */
export function mapsQuotedBrand(companyName: string): string | null {
  const m = companyName.match(/['"]([^'"]{3,})['"]/);
  if (!m?.[1]) return null;
  const brand = m[1]
    .replace(/\b(s\.?p\.?a\.?|s\.?r\.?l\.?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return brand.length >= 3 ? brand : null;
}

/** Rimuove prefissi operatore/gruppo Min. Salute (es. Tiepido, Ios -). */
export function stripOperatorPrefix(name: string): string {
  return name
    .replace(/^(?:tiepido|ios|cdm|cdis|fondazione)\s+/i, "")
    .replace(/^ex\s+/i, "")
    .trim();
}

/** Nome da usare per ricerca sito/Maps — preferisce brand tra apici o sede operativa. */
export function mapsFacilitySearchName(companyName: string): string {
  const quoted = mapsQuotedBrand(companyName);
  if (quoted && !/^casa di cura$/i.test(quoted)) return quoted;
  const sub = mapsSubsidiaryName(companyName);
  if (sub && !/^casa di cura$/i.test(sub)) {
    const q = mapsQuotedBrand(sub);
    if (q) return q;
    return stripOperatorPrefix(sub);
  }
  return stripOperatorPrefix(mapsPrimaryName(companyName));
}

/** Normalizza il nome struttura per ricerche Maps (Min. Salute usa nomi lunghi con filiali). */
export function mapsPrimaryName(companyName: string): string {
  const raw = companyName.trim();
  const beforeDash = raw.split(/\s+-\s+/)[0]?.trim();
  return beforeDash && beforeDash.length > 3 ? beforeDash : raw;
}

export function mapsNameVariants(companyName: string): string[] {
  const raw = companyName.trim();
  const beforeDash = mapsPrimaryName(raw);
  const subsidiary = mapsSubsidiaryName(raw);
  const quoted = mapsQuotedBrand(raw);
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (s: string) => {
    const v = stripOperatorPrefix(s.replace(/\s+/g, " ").trim());
    if (v.length > 3 && !seen.has(v)) {
      out.push(v);
      seen.add(v);
    }
  };

  if (quoted) add(quoted);
  if (subsidiary) {
    add(subsidiary);
    const sq = mapsQuotedBrand(subsidiary);
    if (sq) add(sq);
  }
  if (beforeDash.length > 3 && !seen.has(beforeDash)) {
    out.push(beforeDash);
    seen.add(beforeDash);
  }
  if (raw !== beforeDash && !seen.has(raw)) {
    out.push(raw);
    seen.add(raw);
  }

  const cleaned = raw
    .replace(/\s+-\s+.*$/, "")
    .replace(/\b(s\.?p\.?a\.?|s\.?r\.?l\.?|societ[aà]\s+per\s+azioni)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 3 && !seen.has(cleaned)) {
    out.push(cleaned);
    seen.add(cleaned);
  }

  const tokenSource = subsidiary || cleaned;
  const tokens = tokenSource
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["casa", "cura", "clinica", "ospedale", "centro", "cdic"].includes(w));
  if (tokens.length >= 2) {
    const tokenName = tokens.slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (!seen.has(tokenName)) {
      out.push(tokenName);
      seen.add(tokenName);
    }
  }

  return out;
}

/** Punteggio match Maps — evita filiali errate ma accetta sede operativa locale. */
export function mapsMatchScore(companyName: string, cardName: string): number {
  const primary = mapsPrimaryName(companyName);
  const subsidiary = mapsSubsidiaryName(companyName) ?? "";
  const primaryMatch = mapsNamesMatch(primary, cardName);
  const fullMatch = mapsNamesMatch(companyName, cardName);
  const subMatch = subsidiary ? mapsNamesMatch(subsidiary, cardName) : false;

  let score = 0;
  if (primaryMatch) score += 10;
  else if (subMatch) score += 8;
  else if (fullMatch) score += 5;
  else return -1;

  // Penalizza solo match sul gruppo quando la scheda è chiaramente un'altra sede del gruppo
  if (primaryMatch && subsidiary && subMatch && !mapsNamesMatch(primary, cardName)) {
    score -= 2;
  }
  return score;
}

export type MapsSearchQuery = { query: string; loc: string };

export function mapsSearchQueries(
  companyName: string,
  city: string | null,
  region: string
): MapsSearchQuery[] {
  const out: MapsSearchQuery[] = [];
  const seen = new Set<string>();
  const push = (query: string, loc: string) => {
    const k = `${query}|${loc}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ query, loc });
  };

  const names = mapsNameVariants(companyName);

  if (city) {
    for (const name of names) {
      push(`"${name}" ${city}`, city);
      push(`${name} ${city} ${region}`, city);
    }
  }

  // Fallback: sede reale spesso ≠ comune anagrafica Min. Salute (es. Pineta Grande → Avellino vs Castel Volturno)
  for (const name of names) {
    push(`"${name}" ${region}`, region);
    push(`${name} ${region} Italia`, region);
  }

  return out;
}

/** Estrae il comune da un indirizzo Maps (es. "81030 Castel Volturno CE"). */
export function extractCityFromMapsAddress(address: string | null | undefined): string | null {
  if (!address?.trim()) return null;
  const capCity = address.match(/\b(\d{5})\s+([^,]+)/);
  if (capCity) {
    return capCity[2]
      .trim()
      .replace(/\s+[A-Z]{2}\s*$/i, "")
      .trim();
  }
  const parts = address.split(",").map((p) => p.trim());
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/\s+[A-Z]{2}$/i, "").trim();
    if (p.length < 3 || p.length > 45) continue;
    if (/^\d/.test(p) || /italia|italy/i.test(p)) continue;
    if (/^via |^viale |^corso |^piazza /i.test(p)) continue;
    return p;
  }
  return null;
}

export function mapsNamesMatch(expected: string, found: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/\./g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const a = norm(expected);
  const b = norm(found);
  if (!a || !b) return false;
  // Prefix-include solo se la stringa più corta è significativa (evita "s r l" ⊂ "tecnoedil s r l showroom").
  if (a.length >= 6 && b.includes(a.slice(0, Math.min(a.length, 10)))) return true;
  if (b.length >= 6 && a.includes(b.slice(0, Math.min(b.length, 10)))) return true;

  const stop = new Set(["casa", "cura", "clinica", "ospedale", "centro", "villa", "cdic", "spa", "srl", "di", "de"]);
  const tokens = (s: string) => s.split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const ta = tokens(a);
  const tb = tokens(b);
  const overlap = ta.filter((w) => tb.some((t) => t.includes(w) || w.includes(t)));
  if (overlap.length >= 2) return true;

  const distinctive = (arr: string[]) => arr.filter((w) => w.length >= 5);
  const da = distinctive(ta);
  const db = distinctive(tb);
  return da.some((w) => db.some((t) => t.includes(w) || w.includes(t)));
}
