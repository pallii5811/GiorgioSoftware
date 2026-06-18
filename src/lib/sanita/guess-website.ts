import { externalFetch } from "@/lib/http";
import { mapsNameVariants } from "@/lib/sanita/maps-query";
import { normalizeOfficialWebsite } from "@/lib/sanita/website";

const SKIP = new Set([
  "casa",
  "cura",
  "clinica",
  "ospedale",
  "centro",
  "privata",
  "privato",
  "san",
  "santa",
  "santo",
  "di",
  "del",
  "della",
  "dei",
  "degli",
  "societa",
  "società",
  "accreditata",
  "accreditato",
  "campania",
  "veneto",
  "napoli",
  "avellino",
  "salerno",
  "caserta",
  "benevento",
  "baiano",
  "recaro",
  "thiene",
  "vicenza",
  "verona",
  "padova",
  "treviso",
  "telese",
  "termo",
  "mercogliano",
  "atripalda",
  "mirabella",
  "eclano",
]);

const PROBE_TIMEOUT_MS = 6_500;

function nameTokens(companyName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const variant of mapsNameVariants(companyName)) {
    for (const t of variant
      .toLowerCase()
      .replace(/[^a-zàèéìòù0-9\s]/g, " ")
      .split(/\s+/)) {
      const tok = t.replace(/[^a-z0-9]/g, "");
      if (tok.length < 4 || SKIP.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function acronymHosts(companyName: string): string[] {
  const out: string[] = [];
  if (/ge\.?\s*p\.?\s*o\.?\s*s|gepos/i.test(companyName)) {
    out.push("gepos");
    out.push("casadicuragepos");
  }
  const dotted = companyName.match(/\b((?:[A-Za-z]\.){2,}[A-Za-z]\.?)\b/);
  if (dotted) {
    const letters = dotted[1].replace(/\./g, "").toLowerCase();
    if (letters.length >= 4) out.push(letters);
  }
  return out;
}

function domainCandidates(tokens: string[], companyName: string): string[] {
  const hosts: string[] = [];
  const push = (host: string) => {
    if (!hosts.includes(host)) hosts.push(host);
  };
  for (const h of acronymHosts(companyName)) push(h);
  const slug = tokens.join("");
  const pair = tokens.length >= 2 ? `${tokens[0]}${tokens[1]}` : slug;

  if (tokens.includes("villa") && tokens.includes("maria")) {
    push("clinicavillamaria");
    push("casadicuravillamaria");
  }
  if (tokens.includes("villa") && tokens.includes("platani")) {
    push("villadeiplatani");
    push("clinicavilladeiplatani");
    push("malzoni");
  }
  if (tokens.includes("montevergine")) {
    push("clinicamontevergine");
    push("montevergine");
  }
  if (tokens.includes("esther") || /villa\s+esther/i.test(companyName)) {
    push("villaesther");
  }
  if (tokens.includes("rita") && /casa\s+di\s+cura|clinica/i.test(companyName)) {
    push("casadicurarita");
    push("clinicarita");
  }
  if (tokens.includes("francesco")) {
    push("casadicurasanfrancesco");
    push("clinicasanfrancesco");
  }
  if (tokens.includes("rita")) {
    push("casadicurarita");
    push("clinicarita");
  }
  if (pair.length >= 6) {
    push(`clinica${pair}`);
    push(`clinic${pair}`);
    push(`casadicura${pair}`);
  }
  if (slug.length >= 6 && slug !== pair) {
    push(`clinica${slug}`);
    push(`clinic${slug}`);
    push(`casadicura${slug}`);
  }
  if (slug.length >= 4) push(slug);

  const urls: string[] = [];
  for (const host of hosts) {
    urls.push(`https://www.${host}.it/`);
    urls.push(`https://www.${host}.com/`);
  }
  return urls;
}

async function probeUrl(url: string): Promise<string | null> {
  const normalized = normalizeOfficialWebsite(url);
  if (!normalized) return null;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await externalFetch(normalized, { method, timeoutMs: PROBE_TIMEOUT_MS });
      if (res.ok || res.status === 405 || res.status === 403 || (res.status >= 200 && res.status < 400))
        return normalized;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Probe paralleli a batch — non sprecare minuti su domini inesistenti. */
async function probeCandidatesParallel(urls: string[], deadline: number): Promise<string | null> {
  const batchSize = 4;
  for (let i = 0; i < urls.length; i += batchSize) {
    if (Date.now() >= deadline) break;
    const batch = urls.slice(i, i + batchSize);
    const hits = await Promise.all(batch.map((url) => probeUrl(url)));
    const found = hits.find(Boolean);
    if (found) return found;
  }
  return null;
}

export type GuessWebsiteOpts = { deadline?: number };

/** Domini plausibili da nome struttura (es. clinicavillamaria.it, clinicamontevergine.com). */
export async function probeGuessedOfficialWebsite(
  companyName: string,
  opts?: GuessWebsiteOpts
): Promise<string | null> {
  const tokens = nameTokens(companyName);
  if (tokens.length === 0) return null;
  const deadline = opts?.deadline ?? Date.now() + 18_000;
  return probeCandidatesParallel(domainCandidates(tokens, companyName), deadline);
}
