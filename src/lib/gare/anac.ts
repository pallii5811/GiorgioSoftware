import { gunzipSync } from "node:zlib";
import { externalFetch } from "@/lib/http";

/**
 * Client per i dati ANAC (appalti pubblici italiani) in formato OCDS.
 *
 * Fonte: mirror ufficiale dell'Open Contracting Partnership, che pubblica i
 * dataset BDNCP di ANAC come JSONL compresso (gzip). A differenza del portale
 * dati.anticorruzione.it (protetto da WAF), questo endpoint è accessibile via API.
 * Ogni riga del file è un "contracting process" in standard OCDS.
 *
 * Vantaggio: dati AUTORITATIVI e strutturati (CIG, aggiudicatario, importo),
 * senza bisogno di OpenAI/Tavily e senza rischio di falsi positivi.
 */

const DATASET_URL = (year: number) =>
  `https://data.open-contracting.org/en/publication/117/download?name=${year}.jsonl.gz`;

export interface AnacAward {
  cig: string;
  companyName: string;
  amount: number;
  object: string;
  buyer: string | null;
}

// Mappa il CAP (postalCode del buyer) alla regione. ANAC non espone la regione
// in chiaro: la deduciamo dal prefisso del CAP della stazione appaltante.
const CAP_REGION: Record<string, string[]> = {
  Veneto: ["30", "31", "32", "35", "36", "37", "45"],
  Campania: ["80", "81", "82", "83", "84"],
};

function regionFromCap(cap: string): string | null {
  if (!/^\d{5}$/.test(cap)) return null;
  const p = cap.slice(0, 2);
  for (const [region, prefixes] of Object.entries(CAP_REGION)) {
    if (prefixes.includes(p)) return region;
  }
  return null;
}

// Il CIG (10 caratteri alfanumerici) sta a livello di aggiudicazione/lotto,
// in award.relatedLots o award.items[].id (NON in tender.id, che è un id interno).
interface OcdsAward {
  status?: string;
  relatedLots?: string[];
  items?: { id?: string; description?: string }[];
  suppliers?: { name?: string }[];
  value?: { amount?: number };
}

interface OcdsParty {
  roles?: string[];
  name?: string;
  address?: { postalCode?: string };
}

interface OcdsRelease {
  awards?: OcdsAward[];
  parties?: OcdsParty[];
  tender?: { description?: string };
  buyer?: { name?: string };
}

interface OcdsLine {
  compiledRelease?: OcdsRelease;
  releases?: OcdsRelease[];
}

function pickCig(award: OcdsAward): string | null {
  const candidates: unknown[] = [];
  if (Array.isArray(award?.relatedLots)) candidates.push(...award.relatedLots);
  if (Array.isArray(award?.items)) for (const it of award.items) candidates.push(it?.id);
  for (const c of candidates) {
    if (typeof c === "string") {
      const v = c.trim().toUpperCase();
      if (/^[A-Z0-9]{10}$/.test(v)) return v;
    }
  }
  return null;
}

function bestAward(
  awards: OcdsAward[]
): { supplier: string; amount: number; cig: string; object: string } | null {
  let best: { supplier: string; amount: number; cig: string; object: string } | null = null;
  for (const a of awards) {
    if (!a || (a.status && a.status !== "active")) continue;
    const supplier = a.suppliers?.[0]?.name;
    const amount = Number(a.value?.amount);
    if (typeof supplier !== "string" || supplier.trim().length < 3) continue;
    if (!(amount > 0)) continue;
    const cig = pickCig(a);
    if (!cig) continue;
    const object = a.items?.[0]?.description || "";
    if (!best || amount > best.amount) best = { supplier: supplier.trim(), amount, cig, object };
  }
  return best;
}

async function downloadDataset(year: number): Promise<string | null> {
  try {
    const res = await externalFetch(DATASET_URL(year), { timeoutMs: 90_000, redirect: "follow" });
    if (!res.ok) return null;
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz.length === 0) return null;
    return gunzipSync(gz).toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Scarica le aggiudicazioni ANAC per una regione, estraendo solo gare
 * realmente aggiudicate (con aggiudicatario e importo). Prova l'anno corrente
 * e, se non disponibile, l'anno precedente.
 */
export async function fetchAnacAwards(
  region: string,
  opts: { max?: number } = {}
): Promise<{ awards: AnacAward[]; year: number | null; scanned: number }> {
  const max = opts.max ?? 60;
  const unlimited = max <= 0;
  const now = new Date().getFullYear();
  const allAwards: AnacAward[] = [];
  const seen = new Set<string>();
  let totalScanned = 0;
  let lastYear: number | null = null;

  for (const year of [now, now - 1]) {
    const jsonl = await downloadDataset(year);
    if (!jsonl) continue;

    const lines = jsonl.split("\n");
    let scanned = 0;

    for (const line of lines) {
      if (!unlimited && allAwards.length >= max) break;
      if (!line) continue;

      let obj: OcdsLine & OcdsRelease;
      try {
        obj = JSON.parse(line) as OcdsLine & OcdsRelease;
      } catch {
        continue;
      }

      const release: OcdsRelease = obj.compiledRelease ?? obj.releases?.[0] ?? obj;
      const awardsArr = Array.isArray(release.awards) ? release.awards : [];
      if (awardsArr.length === 0) continue;

      const buyerParty =
        release.parties?.find((p) => p.roles?.includes("buyer")) ?? release.parties?.[0];
      const cap = typeof buyerParty?.address?.postalCode === "string" ? buyerParty.address.postalCode.trim() : "";
      if (regionFromCap(cap) !== region) continue;
      scanned++;

      const winner = bestAward(awardsArr);
      if (!winner || seen.has(winner.cig)) continue;

      const object = (winner.object || release?.tender?.description || "Appalto pubblico").trim();
      const buyer = buyerParty?.name ?? release?.buyer?.name ?? null;

      seen.add(winner.cig);
      allAwards.push({
        cig: winner.cig,
        companyName: winner.supplier,
        amount: winner.amount,
        object: String(object).slice(0, 300),
        buyer: buyer ? String(buyer).slice(0, 200) : null,
      });
    }

    totalScanned += scanned;
    lastYear = year;
    if (!unlimited && allAwards.length >= max) break;
  }

  return { awards: allAwards, year: lastYear, scanned: totalScanned };
}
