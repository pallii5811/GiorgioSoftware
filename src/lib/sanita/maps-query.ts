/** Normalizza il nome struttura per ricerche Maps (Min. Salute usa nomi lunghi con filiali). */
export function mapsPrimaryName(companyName: string): string {
  const raw = companyName.trim();
  const beforeDash = raw.split(/\s+-\s+/)[0]?.trim();
  return beforeDash && beforeDash.length > 3 ? beforeDash : raw;
}

export function mapsNameVariants(companyName: string): string[] {
  const raw = companyName.trim();
  const beforeDash = mapsPrimaryName(raw);
  const out: string[] = [];
  if (beforeDash.length > 3) out.push(beforeDash);
  if (raw !== beforeDash) out.push(raw);
  const seen = new Set(out);

  const cleaned = raw
    .replace(/\s+-\s+.*$/, "")
    .replace(/\b(s\.?p\.?a\.?|s\.?r\.?l\.?|societ[aà]\s+per\s+azioni)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 3 && !seen.has(cleaned)) {
    out.push(cleaned);
    seen.add(cleaned);
  }

  const tokens = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["casa", "cura", "clinica", "ospedale", "centro"].includes(w));
  if (tokens.length >= 2) {
    const tokenName = tokens.slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (!seen.has(tokenName)) {
      out.push(tokenName);
      seen.add(tokenName);
    }
  }

  return out;
}

/** Punteggio match Maps — evita filiali errate (es. Villa Esther vs Pineta Grande). */
export function mapsMatchScore(companyName: string, cardName: string): number {
  const primary = mapsPrimaryName(companyName);
  const subsidiary = companyName.includes(" - ") ? companyName.split(/\s+-\s+/).slice(1).join(" - ") : "";
  let score = 0;
  if (mapsNamesMatch(primary, cardName)) score += 10;
  else if (mapsNamesMatch(companyName, cardName)) score += 5;
  else return -1;
  if (subsidiary && mapsNamesMatch(subsidiary, cardName) && !mapsNamesMatch(primary, cardName)) score -= 12;
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
  if (a.includes(b.slice(0, 10)) || b.includes(a.slice(0, 10))) return true;

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
