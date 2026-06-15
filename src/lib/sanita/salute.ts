import { externalFetch } from "@/lib/http";
import type { Region } from "./discovery";

/**
 * Fonte AUTORITATIVA: Open Data del Ministero della Salute.
 * Dataset "Case di cura accreditate presenti nel territorio della ASL".
 *
 * Aggiunge alla discovery le strutture private accreditate (obbligate alla
 * copertura RC ai sensi della Legge Gelli), spesso assenti da OpenStreetMap.
 * Il CSV è separato da ";" e codificato in latin1 (ISO-8859-1).
 */
const CSV_URL =
  "https://www.dati.salute.gov.it/sites/default/files/2024-05/Case_di_Cura_Accreditate_presenti_nel_territorio_della_ASL.csv";

// Il portale risponde solo a User-Agent "da browser".
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const REGION_NAME: Record<Region, string> = { Veneto: "VENETO", Campania: "CAMPANIA" };

export interface SaluteFacility {
  code: string;
  name: string;
  city: string | null;
  province: string | null;
  beds: number;
  type: string;
}

// Title-case leggero per nomi tutti maiuscoli (mantiene le sigle brevi).
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-zà-ù])([a-zà-ù]*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\bS\.?R\.?L\.?\b/gi, "S.r.l.")
    .replace(/\bS\.?P\.?A\.?\b/gi, "S.p.A.")
    .trim();
}

export async function fetchAccreditedClinics(region: Region): Promise<SaluteFacility[]> {
  let res: Response;
  try {
    res = await externalFetch(CSV_URL, {
      timeoutMs: 60_000,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, Accept: "text/csv,*/*" },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("latin1");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const col = (exact: string) => header.indexOf(exact);
  const iName = col("denominazione struttura");
  const iCity = col("comune struttura");
  const iProv = col("sigla provincia struttura");
  const iBeds = col("posti letto previsti");
  const iType = col("tipo struttura");
  const iCode = col("codice struttura");
  const iRegion = col("regione");

  if (iName < 0 || iRegion < 0) return [];

  const wanted = REGION_NAME[region];
  const out: SaluteFacility[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(";");
    if (cells.length <= iRegion) continue;
    if ((cells[iRegion] || "").trim().toUpperCase() !== wanted) continue;

    const name = (cells[iName] || "").trim();
    if (!name) continue;

    out.push({
      code: (cells[iCode] || "").trim() || String(i),
      name,
      city: iCity >= 0 ? titleCase((cells[iCity] || "").trim()) || null : null,
      province: iProv >= 0 ? (cells[iProv] || "").trim() || null : null,
      beds: iBeds >= 0 ? parseInt((cells[iBeds] || "0").replace(/\D/g, ""), 10) || 0 : 0,
      type: iType >= 0 ? (cells[iType] || "").trim() : "",
    });
  }
  return out;
}

export { titleCase };
