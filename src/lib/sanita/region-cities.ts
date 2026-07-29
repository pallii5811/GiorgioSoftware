import fs from "node:fs";
import path from "node:path";
import type { Region } from "./discovery";
import { fetchAccreditedClinics } from "./salute";

const CAPOLUOGHI: Record<Region, string[]> = {
  Abruzzo: ["L'Aquila", "Chieti", "Pescara", "Teramo"],
  Basilicata: ["Potenza", "Matera"],
  Calabria: ["Catanzaro", "Cosenza", "Crotone", "Reggio di Calabria", "Vibo Valentia"],
  Campania: [
    "Napoli", "Salerno", "Caserta", "Avellino", "Benevento", "Castellammare di Stabia",
    "Torre del Greco", "Giugliano in Campania", "Aversa", "Battipaglia", "Castel Volturno",
    "Pozzuoli", "Ercolano", "Cava de' Tirreni", "Nocera Inferiore",
  ],
  "Emilia-Romagna": [
    "Bologna", "Ferrara", "Forlì", "Cesena", "Modena", "Parma", "Piacenza", "Ravenna",
    "Reggio nell'Emilia", "Rimini",
  ],
  "Friuli-Venezia Giulia": ["Trieste", "Gorizia", "Pordenone", "Udine"],
  Lazio: ["Roma", "Frosinone", "Latina", "Rieti", "Viterbo"],
  Liguria: ["Genova", "Imperia", "La Spezia", "Savona"],
  Lombardia: [
    "Milano", "Bergamo", "Brescia", "Como", "Cremona", "Lecco", "Lodi", "Mantova",
    "Monza", "Pavia", "Sondrio", "Varese",
  ],
  Marche: ["Ancona", "Ascoli Piceno", "Fermo", "Macerata", "Pesaro", "Urbino"],
  Molise: ["Campobasso", "Isernia"],
  Piemonte: [
    "Torino", "Alessandria", "Asti", "Biella", "Cuneo", "Novara", "Verbania", "Vercelli",
  ],
  Puglia: ["Bari", "Andria", "Barletta", "Brindisi", "Foggia", "Lecce", "Taranto", "Trani"],
  Sardegna: ["Cagliari", "Nuoro", "Oristano", "Sassari"],
  Sicilia: [
    "Palermo", "Agrigento", "Caltanissetta", "Catania", "Enna", "Messina", "Ragusa",
    "Siracusa", "Trapani",
  ],
  Toscana: [
    "Firenze", "Arezzo", "Grosseto", "Livorno", "Lucca", "Massa", "Carrara", "Pisa",
    "Pistoia", "Prato", "Siena",
  ],
  "Trentino-Alto Adige": ["Trento", "Bolzano"],
  Umbria: ["Perugia", "Terni"],
  "Valle d'Aosta": ["Aosta"],
  Veneto: [
    "Venezia", "Verona", "Padova", "Vicenza", "Treviso", "Rovigo", "Belluno",
    "Chioggia", "Bassano del Grappa", "Schio", "San Donà di Piave", "Mestre",
  ],
};

/**
 * Elenco COMPLETO comuni ISTAT (data/comuni.json) — generato da
 * scripts/download-comuni.mjs. Se assente, fallback ai capoluoghi.
 */
let fullComuniCache: Record<string, string[]> | null = null;
function loadFullComuni(): Record<string, string[]> {
  if (fullComuniCache) return fullComuniCache;
  try {
    const file = path.join(process.cwd(), "data", "comuni.json");
    fullComuniCache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fullComuniCache = {};
  }
  return fullComuniCache!;
}

/** Comuni dove 0 risultati Maps su tutte le query = probabile errore scraper (non "comune vuoto"). */
export function isMapsSignificantCity(region: Region, city: string): boolean {
  const norm = city.trim().toLowerCase();
  return (CAPOLUOGHI[region] ?? []).some((c) => c.toLowerCase() === norm);
}

/** Comuni da scansionare su Google Maps: TUTTI i comuni ISTAT + Min. Salute + capoluoghi. */
export async function getRegionCities(region: Region): Promise<string[]> {
  const set = new Set<string>(CAPOLUOGHI[region]);

  const full = loadFullComuni()[region] ?? [];
  for (const c of full) if (c?.trim()) set.add(c.trim());

  try {
    const clinics = await fetchAccreditedClinics(region);
    for (const c of clinics) if (c.city?.trim()) set.add(c.city.trim());
  } catch {
    /* ignore */
  }
  return [...set].sort((a, b) => a.localeCompare(b, "it"));
}

/** Elenco ISTAT locale, senza chiamate di rete: usato dai selettori UI/API. */
export function getStoredRegionCities(region: Region): string[] {
  return [...(loadFullComuni()[region] ?? [])].sort((a, b) => a.localeCompare(b, "it"));
}

// Discovery a copertura totale (1100+ comuni): query ridotte ma rappresentative
// dei target Gelli. Le accreditate Min. Salute coprono le case di cura per nome.
export const HEALTHCARE_MAP_QUERIES = [
  "casa di cura",
  "clinica privata",
  "poliambulatorio privato",
] as const;

/**
 * Discovery territoriale richiesta esplicitamente dall'utente: copertura più ampia
 * delle strutture cliniche, mantenuta separata dalla scansione archivio legacy.
 */
export const TERRITORY_HEALTHCARE_MAP_QUERIES = [
  ...HEALTHCARE_MAP_QUERIES,
  "centro medico",
  "centro diagnostico",
  "laboratorio analisi cliniche",
  "centro riabilitazione",
] as const;
