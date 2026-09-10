/**
 * Detector rule-based della copertura assicurativa RC Professionale
 * pubblicata ai sensi della Legge Gelli-Bianco (L. 24/2017, art. 10).
 *
 * Analizza il testo estratto dal sito di una struttura sanitaria e cerca
 * evidenze di pubblicazione della polizza: compagnia, massimale, scadenza.
 *
 * Non richiede OpenAI: usa liste di compagnie e pattern regex calibrati
 * sul linguaggio normativo/assicurativo italiano.
 */

import {
  extractSchedaPolizzaFields,
  stripQuietanzaDates,
} from "./policy-scheda-extract";
import { detectSelfInsuranceDeclaration } from "./self-insurance";

export interface PolicyAnalysis {
  policyFound: boolean;
  confidence: number; // 0..1
  company: string | null;
  massimale: string | null;
  expiry: Date | null;
  policyNumber: string | null;
  evidence: string | null; // estratto di testo che giustifica il match
  policyObsolete?: boolean; // true se expiry scaduta da >365gg — irregolarità Legge Gelli
}

// Principali compagnie assicurative attive in Italia, con focus sul ramo sanità
const INSURERS = [
  "UnipolSai",
  "Unipol",
  "Generali Italia",
  "Assicurazioni Generali",
  "Generali",
  "Allianz",
  "AXA",
  "Italiana Assicurazioni",
  "Reale Mutua",
  "Cattolica",
  "Zurich",
  "Groupama",
  "ITAS",
  "Vittoria Assicurazioni",
  "Vittoria",
  "HDI",
  "HDI Global",
  "HDI Global SE",
  "AmTrust",
  "Lloyd's",
  "Lloyds",
  "QBE",
  "Sham",
  "Relyens",
  "Berkshire Hathaway",
  "BHItalia",
  "Accelerant Insurance",
  "Accelerant",
  "Arch Insurance",
  "Tokio Marine",
  "Helvetia",
  "Net Insurance",
  "MAPFRE",
  "Sara Assicurazioni",
  "Nobis",
  "RBM Salute",
  "Poste Assicura",
  "Intesa Sanpaolo Assicura",
  "Aviva",
  "Chubb",
  "AIG",
  "Markel",
  "Coface",
  "Elba Assicurazioni",
  "Tua Assicurazioni",
  "ITAS Mutua",
  "Assimoco",
  "Amissima",
  "Revo",
  "Società Cattolica di Assicurazione",
  "Reale Group",
  "Greenval",
  "Roland",
  "Beazley",
  "Liberty Mutual",
  "Liberty Specialty Markets",
  "CNA Hardy",
];

// Riferimenti alla Legge Gelli
const GELLI_PATTERNS = [
  /legge\s+gelli/i,
  /gelli[\s-]*bianco/i,
  /legge\s+(?:n\.?\s*)?24\s*\/\s*2017/i,
  /l\.?\s*24\/2017/i,
  /24\s+del\s+2017/i,
  /art(?:icolo)?\.?\s*10\b/i,
];

// Contesto assicurativo / RC professionale
const INSURANCE_CONTEXT = [
  /responsabilit[àa]\s+civile/i,
  /r\.?c\.?\s*professionale/i,
  /r\.?c\.?\s*terzi/i,
  /\bR\.?C\.?T\.?\b/,
  /\bR\.?C\.?O\.?\b/,
  /copertura\s+assicurativa/i,
  /polizza\s+assicurativa/i,
  /estremi\s+della\s+polizza/i,
  /coperture\s+assicurative/i,
  /\bpolizza\b/i,
  /\bmassimale\b/i,
];

const TRANSPARENCY = [
  /amministrazione\s+trasparente/i,
  /societ[àa]\s+trasparente/i,
];

function isGeneraliFalsePositive(text: string, index: number): boolean {
  const ctx = text.slice(Math.max(0, index - 80), index + 30).toLowerCase();
  return (
    /notizie|servizi|risorse|informazioni|condizioni|disposizioni|norme|dati|aree|spazi|reparti|medicina|chirurgia|linee|indicazioni|coassicuraz|direzione|direttore|aspetti|caratteristiche|principi|obiettivi|prestazion|struttur[ae]|regole|requisiti|documenti|modalit[aà]|criteri|misure|obblighi|procedure/.test(
      ctx
    )
  );
}

function isRejectedInsurerName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (/^(alcuna|nessuna|nessun|eventuale|la|il|lo|le|una|un|del|della|di|che|non|ma|per)$/i.test(n)) {
    return true;
  }
  return (
    /ulss|asl\s|azienda\s+(?:sanit|ulss)|regione\s|budget|accordi?\s+contrattual|di\s+servizio|variazioni\s+e|tra\s+azienda|ynil\s+tra|ospedale\s+pubbl/i.test(
      n
    ) || n.length > 60
  );
}

function sanitizeInsurerCapture(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 3 || isRejectedInsurerName(name)) return null;
  return name;
}

function findInsurer(text: string): string | null {
  if (/(?:\bITALIANA\b|\bI?TAL\s*IAN\s*A\b)[\s\S]{0,100}\bASSICURAZIONI\b/i.test(text)) {
    return "Italiana Assicurazioni";
  }
  // AM Trust — molte varianti su siti reali
  if (/AM\s*TRUST|AmTrust|Am\s+Trust|AM[\s\-_]*TRUST\s*(?:ASSICURAZIONI|ITALIA|INTERNATIONAL|EUROPE|CLINICS)?/i.test(text)) return "AmTrust";
  if (/\bBH\s*ITALIA\b/i.test(text)) return "Berkshire Hathaway";
  for (const insurer of INSURERS) {
    const re = new RegExp(`\\b${insurer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const m = re.exec(text);
    if (!m) continue;
    if (insurer.toLowerCase() === "cattolica" && /universit[aà]\s+cattolic/i.test(text.slice(Math.max(0, m.index - 40), m.index + 60))) {
      continue;
    }
    if (insurer.toLowerCase() === "generali" && isGeneraliFalsePositive(text, m.index)) continue;
    return insurer;
  }
  // Fallback: "compagnia assicurativa: X" o "stipulat[ao] ... con X"
  const free = text.match(
    /compagnia\s+(?:di\s+)?assicurazion[ei]\s*[:\s]+([A-Z][A-Za-z0-9\s.&'()/\-]{3,80}?)(?:\s+N\.?\s*Polizza|\s+Scadenza|\s+Massimal|\s+SIR\b|\s+Polizza\s+n|$)/i
  );
  if (free?.[1]) {
    const captured = sanitizeInsurerCapture(free[1]);
    if (captured) return captured;
  }
  const free2 = text.match(
    /compagnia\s+(?:di\s+)?assicurazione\s+([A-Z][A-Za-z0-9\s.&'()/\-]{3,80}?)(?:\s+N\.?\s*Polizza|\s+Scadenza|\s+Massimal|\s+SIR\b|$)/i
  );
  if (free2?.[1]) {
    const captured = sanitizeInsurerCapture(free2[1]);
    if (captured) return captured;
  }
  // "stipulata con X" / "polizza ... con X"
  const stipulata = text.match(
    /(?:stipulat[aoe]|sottoscritt[aoe]|contratt[aoe])\s+(?:con\s+(?:la\s+)?)?([A-Z][A-Za-z0-9\s.&'()/\-]{3,60}?)(?:\s+(?:N\.?\s*Polizza|n\.|polizza|scadenz|massimal))/i
  );
  if (stipulata?.[1]) return stipulata[1].trim().replace(/\s+/g, " ");
  // "polizza ... con la/con X"
  const polizzaCon = text.match(
    /polizza\s+(?:assicurativa\s+)?(?:per\s+)?(?:RCT|RCO|RC)\s*(?:e\s+RCO\s+)?con\s+(?:la\s+)?([A-Z][A-Za-z0-9\s.&'()/\-]{3,60}?)(?:\.|$|\s+(?:N\.?|n\.|polizza|scadenz|massimal))/i
  );
  if (polizzaCon?.[1]) return polizzaCon[1].trim().replace(/\s+/g, " ");
  return null;
}

function isPayoutTableContext(ctx: string): boolean {
  // Tabelle PARM / art.4: "risarcimenti erogati", "sinistri liquidati" — NON confondere con polizza RC.
  return /risarcimenti\s+erogat|sinistr[oi]\s+liquidat|liquidato\s+annuo|quinquennio/i.test(ctx);
}

function isTicketOrIncomeContext(ctx: string): boolean {
  // Soglie reddito/ticket (Carta servizi) — NON massimale RC.
  return /ticket|reddito|esenzion|nucleo\s+famili|isee|pagament|tariff|prestazion/i.test(ctx);
}

function findMassimale(text: string): string | null {
  const euroBeforeLimit = text.match(
    /((?:€|eur|euro)\s*[\d]{1,3}(?:\.\d{3})+(?:,\d{2})?)\s+limite\s+di\s+indennizzo/i
  );
  if (euroBeforeLimit?.[1]) return euroBeforeLimit[1].replace(/\s+/g, " ").trim();

  const afterMassimali = text.match(
    /massimali?:[\s\S]{0,220}?((?:€|eur|euro)\s*[\d]{1,3}(?:\.\d{3})+(?:,\d{2})?)/i
  );
  if (afterMassimali?.[1]) return afterMassimali[1].replace(/\s+/g, " ").trim();

  // RC strutture sanitarie: "Limite dell'Indennizzo ... EUR 5.000.000,00"
  const rcLimit =
    /limite\s+(?:dell['’]?\s*)?indennizzo[^.\n]{0,120}?((?:€|eur|euro)\s*[\d.,]+(?:,\d{2})?)/i;
  const rc = text.match(rcLimit);
  if (rc?.[1]) {
    const ctx = text.slice(Math.max(0, (rc.index ?? 0) - 80), (rc.index ?? 0) + 200);
    if (isPayoutTableContext(ctx) || isTicketOrIncomeContext(ctx)) return null;
    return rc[1].replace(/\s+/g, " ").trim();
  }

  const near =
    /massimal[ei][^.\n]{0,80}?((?:€|euro|eur)\s*[\d.,]+(?:\s*(?:milion[ei]|mln))?|[\d.,]+\s*(?:milion[ei]|mln)\s*(?:di\s*)?(?:euro|€)?|[\d.,]+\s*(?:euro|€|eur))/i;
  const m = text.match(near);
  if (m?.[1]) {
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 200);
    if (isPayoutTableContext(ctx) || isTicketOrIncomeContext(ctx)) return null;
    return m[1].replace(/\s+/g, " ").trim();
  }

  const rco = text.match(
    /RCO\s+(?:per\s+sinistro\s+)?([\d]{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)/i
  );
  if (rco?.[1]) return `EUR ${rco[1].replace(/\s+/g, " ").trim()}`;

  const rct = text.match(/RCT\s+sinistro\s+([\d]{1,3}(?:\.\d{3})+)/i);
  if (rct?.[1]) return `EUR ${rct[1].replace(/\s+/g, " ").trim()}`;

  const rctLimit = text.match(
    /\bRCT\b[^.\n]{0,120}?((?:€|eur|euro)\s*[\d]{1,3}(?:\.\d{3})+(?:,\d{2})?)/i
  );
  if (rctLimit?.[1]) return rctLimit[1].replace(/\s+/g, " ").trim();

  const rcoLimit = text.match(
    /\bRCO\b[^.\n]{0,120}?((?:€|eur|euro)\s*[\d]{1,3}(?:\.\d{3})+(?:,\d{2})?)/i
  );
  if (rcoLimit?.[1]) return rcoLimit[1].replace(/\s+/g, " ").trim();

  // Niente fallback "alt": rischia falsi massimali da bilanci/XBRL (fondo rischi, accantonamenti, ecc.)
  // Se non è esplicitamente marcato come massimale/limite/RCT/RCO, preferiamo null.
  return null;
}

function parseItalianDate(raw: string): Date | null {
  // dd/mm/yyyy | dd-mm-yyyy | dd.mm.yyyy
  const num = raw.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (num) {
    const [, d, mo, y] = num;
    let year = parseInt(y, 10);
    if (year < 100) year += 2000;
    const date = new Date(Date.UTC(year, parseInt(mo, 10) - 1, parseInt(d, 10)));
    if (!isNaN(date.getTime())) return date;
  }
  // dd <mese> yyyy
  const months: Record<string, number> = {
    gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
    luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11,
  };
  const txt = raw.match(/(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i);
  if (txt) {
    const mo = months[txt[2].toLowerCase()];
    if (mo !== undefined) {
      const date = new Date(Date.UTC(parseInt(txt[3], 10), mo, parseInt(txt[1], 10)));
      if (!isNaN(date.getTime())) return date;
    }
  }
  return null;
}

type InsurancePositionTableFields = {
  company: string;
  policyNumber: string;
  expiry: Date;
};

/**
 * Extract the newest concrete row from a PARM "posizione assicurativa" table.
 *
 * Real PDFs often expose only:
 *   Validità Polizza | Compagnia assicuratrice | Brokeraggio
 *   31/12/2024 AL 31/12/2025 | 48480OO | SARA ASSICURAZIONI | A.O.N.
 *
 * Requiring the explicit section heading, both table headers, two dates, a
 * policy identifier and a named insurer keeps generic PARM templates negative.
 */
function extractInsurancePositionTableFields(
  text: string
): InsurancePositionTableFields | null {
  const normalized = text.replace(/\s+/g, " ");
  const sectionMatch = normalized.match(
    /descrizione\s+della\s+posizione\s+assicurativa[\s\S]{0,2200}/i
  );
  if (!sectionMatch) return null;
  const section = sectionMatch[0];
  if (
    !/validit[aà]\s+polizza/i.test(section) ||
    !/compagnia\s+assicuratrice/i.test(section)
  ) {
    return null;
  }

  const rowPattern =
    /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+(?:al|a|[-–—])\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+([A-Z0-9][A-Z0-9_./-]{4,})\s+([\s\S]{3,180}?)(?=\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+(?:al|a|[-–—])|--\s*\d+\s+of\b|piano\s+di\s+risk\s+management|$)/gi;
  const rows: InsurancePositionTableFields[] = [];
  for (const match of section.matchAll(rowPattern)) {
    const expiry = parseItalianDate(match[2]);
    const policyNumber = sanitizePolicyNumber(match[3]);
    const company = findInsurer(match[4]);
    if (!expiry || !policyNumber || !company) continue;
    rows.push({ company, policyNumber, expiry });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.expiry.getTime() - a.expiry.getTime());
  return rows[0];
}

/** Sezione polizza Gelli (evita falsi match da altre pagine del sito). */
function policyFocusText(text: string): string {
  const idx = text.search(
    /polizza\s+assicurativa|responsabilit[aà]\s+civile|contratto\s+n\.?|durata\s+del\s+contratto|articolo\s+10.{0,60}gelli|art\.?\s*10.{0,60}gelli|compagnia\s+di\s+assicurazione/i
  );
  if (idx >= 0) return text.slice(idx, idx + 5000);
  // NON fare focus su "risarcimenti erogati"/PARM: è un obbligo diverso (art.4),
  // e contiene spesso compagnie/importi che causano falsi PUBLISHED.
  return text;
}

function findExpiry(text: string): Date | null {
  // Preferenza esplicita: "Scade alle ore 24 del …" (mai quietanza).
  const scade24 = text.match(
    /scade\s+alle\s+ore\s+24(?:[:.]?00)?\s+del\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i
  );
  if (scade24?.[1]) {
    const d = parseItalianDate(scade24[1]);
    if (d) return d;
  }

  const appendixRenewal = text.match(
    /appendice\s+di\s+rinnovo[\s\S]{0,220}?fino\s+alle\s+ore\s+24\s+del\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i
  );
  if (appendixRenewal?.[1]) {
    const d = parseItalianDate(appendixRenewal[1]);
    if (d) return d;
  }

  const scadBlock = text.match(/scadenza\s+contratto[\s\S]{0,200}/i);
  if (scadBlock) {
    const dates = [...scadBlock[0].matchAll(/(\d{1,2})\s+(\d{1,2})\s+(\d{4})/g)];
    const last = dates.at(-1);
    if (last) {
      const d = parseItalianDate(`${last[1]}/${last[2]}/${last[3]}`);
      if (d) return d;
    }
  }

  const periodEnd = text.match(
    /scadenza\s+periodo\s+assicurativo\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+al\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i
  );
  if (periodEnd?.[1]) {
    const d = parseItalianDate(periodEnd[1]);
    if (d) return d;
  }

  const spacedEnd = text.match(
    /scadenza\s+contratto[\s\S]{0,220}?(\d{1,2})\s+(\d{1,2})\s+(\d{4})/i
  );
  if (spacedEnd) {
    const d = parseItalianDate(`${spacedEnd[1]}/${spacedEnd[2]}/${spacedEnd[3]}`);
    if (d) return d;
  }

  const durataBlock = text.match(/durata\s+del\s+contratto[\s\S]{0,400}/i);
  if (durataBlock) {
    const slashDates = [...durataBlock[0].matchAll(/(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/g)];
    const lastSlash = slashDates.at(-1);
    if (lastSlash?.[1]) {
      const d = parseItalianDate(lastSlash[1]);
      if (d) return d;
    }
    const spacedDates = [...durataBlock[0].matchAll(/(\d{1,2})\s+(\d{1,2})\s+(\d{4})/g)];
    const lastSpaced = spacedDates.at(-1);
    if (lastSpaced) {
      const d = parseItalianDate(`${lastSpaced[1]}/${lastSpaced[2]}/${lastSpaced[3]}`);
      if (d) return d;
    }
  }

  const dateGroup = "(\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}|\\d{1,2}\\s+[a-zà]+\\s+\\d{4})";
  const patterns = [
    // "Alle ore 24:00 del 31.01.2027" (appendici polizza RC)
    /alle\s+ore\s+24[:\.]?00\s+del\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    // Etichette HTML compatte: "SCAD. 04/11/2026" / "SCAD: 04-11-2026".
    new RegExp(`\\bscad\\.?\\s*[:\\-]?\\s*${dateGroup}`, "i"),
    // "scadenza 31/12/2025", "scadenza polizza: 31.12.2025", "data di scadenza ..."
    new RegExp(`scadenz[ae]?[^.\\n]{0,40}?${dateGroup}`, "i"),
    // "valida/valido fino al 31/12/2025", "in vigore fino al ..."
    new RegExp(`(?:valid[aoità]+|in\\s+vigore)[^.\\n]{0,20}?(?:fino\\s+al|al)\\s+${dateGroup}`, "i"),
    // "polizza/copertura ... scadenza/al 31/12/2025"
    new RegExp(`(?:polizza|copertura)[^.\\n]{0,60}?(?:scadenz[ae]?|fino\\s+al|al)\\s+${dateGroup}`, "i"),
    // "dal 01/01/2025 al 31/12/2025" -> prende la seconda (fine copertura)
    new RegExp(`dal\\s+${dateGroup}\\s+al\\s+${dateGroup}`, "i"),
    // intervallo "01.01.2025 - 31.12.2025"
    new RegExp(`${dateGroup}\\s*[\\-–]\\s*${dateGroup}`, "i"),
    // "Scadenza periodo assicurativo 31.03.2026 al 31.03.2029"
    new RegExp(`scadenza\\s+periodo\\s+assicurativo\\s+${dateGroup}\\s+al\\s+${dateGroup}`, "i"),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      // Intervalli: ultima data catturata = fine copertura
      const captured = m[3] ?? m[2] ?? m[1];
      const d = parseItalianDate(captured);
      // Date ante-2010 su documenti generici = quasi sempre falsi positivi (budget, accordi, footer).
      if (d && d.getUTCFullYear() < 2010) continue;
      if (d) return d;
    }
  }
  return null;
}

function findPolicyNumber(text: string): string | null {
  const patterns = [
    /\b(20\d{2}\/\d{2}\/\d{5,})\b/i,
    /numero\s+(?:della\s+)?pratica\s+(?:[éeè]\s*:?\s*)?(\d{6,12})/i,
    /codice\s+polizza\s+(\d{6,12})/i,
    /N\.?\s*Polizza\s+RCT\/O\s+([A-Z0-9_]+)/i,
    /\b(RCI[0-9]{8,})\b/i,
    /\b(\d{4}RCG\d+)\b/i,
    /\b(RCH\d{9,})\b/i,
    /polizza\s+n[°º.]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
    // HTML footer/home: "Polizza 2022/03/2475660" (senza "n.")
    /polizza\s+(\d{4}\/\d{2}\/\d{3,})/i,
    /polizza\s+(\d[\d\-]{8,})/i,
    /sottoscritto\s+(?:con|da)\s+[^.]{3,80}?\s+polizza\s+([A-Z0-9][\d\-]{6,})/i,
    /(?:polizza\s+(?:n\.?|numero|nr\.?)|(?:n\.?|numero|nr\.)\s+polizza)\s*[:\-]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
    /numero\s+polizza\s*[:\-]\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
    /(?:contratto|polizza)\s+n\.?\s*([\d\s]{4,}[A-Z0-9]?)/i,
    /\bn\.?\s*contratto\s+([\d\s]{4,}[A-Z0-9]?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = sanitizePolicyNumber(m[1].trim());
      if (n) return n;
    }
  }
  return null;
}

/** Scarta match OCR/HTML spuri (es. "Prodotto", "SOSTITUISCE"). */
function sanitizePolicyNumber(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const n = raw.trim().replace(/\s+/g, " ");
  if (n.length < 5) return null;
  if (/^(prodotto|sostituisce|rct|rco|polizza|numero|della|dell|art)$/i.test(n)) return null;
  // Le polizze AmTrust RCI hanno prefisso alfabetico RCI seguito solo da cifre.
  // OCR/font PDF confondono frequentemente lo zero iniziale con la lettera O.
  const compact = n.replace(/\s+/g, "").toUpperCase();
  if (/^RCI[0-9O]{8,}$/.test(compact)) {
    return `RCI${compact.slice(3).replaceAll("O", "0")}`;
  }
  return n;
}

function extractEvidence(text: string): string | null {
  const idx = text.search(
    /polizza|massimale|gelli|responsabilit[àa]\s+civile|copertura\s+assicurativa|autoassicuraz|ritenzione\s+del\s+rischio|gestione\s+diretta/i
  );
  if (idx === -1) return null;
  const start = Math.max(0, idx - 60);
  return text.substring(start, idx + 180).replace(/\s+/g, " ").trim();
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((acc, re) => (re.test(text) ? acc + 1 : acc), 0);
}

function isPolicyAppendixDocument(text: string): boolean {
  return (
    /appendice\s+(?:di\s+)?rinnovo|appendice\s+n\.?\s*\d+/i.test(text) &&
    /polizz|codice\s+polizza|rc\s+sanitar/i.test(text)
  );
}

/** Bilancio / costi contabilizzati: "fondo rischi" è accantonamento contabile, NON autoassicurazione Gelli. */
export function isAccountingOrBalanceSheetText(text: string): boolean {
  return /costi\s+contabilizzat|accantonamento\s+fondo\s+risch|stato\s+patrimoniale|conto\s+economico|rendiconto\s+finanziario|bilancio\s+d.?esercizio|materie\s+prime.*personale.*altri\s+costi|servizi\s+offerti.*materie\s+prime|assegnazione\s+budget|budget\s+\d{4}/i.test(
    text
  );
}

/** Budget, accordi ULSS/ASL, convenzioni — NON polizza RC art.10. */
/** Patient reimbursement/convention pages are not the facility's Art.10 RC policy. */
export function isPatientInsuranceConventionText(text: string, url?: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const conventionContext =
    /assicurazioni?\s+e\s+convenzioni|convenzioni?\s+assicurative|provider\s+(?:assicurativ[io]|di\s+welfare)|fondi?\s+sanitari|sanit[aà]\s+integrativa|compagnie\s+assicurative.{0,500}(?:visite|esami|prestazioni|interventi|trattamenti)|\/assicurazioni?-e-convenzioni/i.test(
      `${url || ""} ${t}`
    );
  const patientBenefit =
    /tariffe\s+agevolate|copertura\s+(?:totale|parziale)\s+dei\s+(?:nostri\s+)?trattamenti|rimborso\s+diretto|accesso\s+ai\s+piani\s+sanitari|partner(?:ship)?\s+(?:strategic[ai]|principal[ei])|welfare\s+aziendale|flexible\s+benefits|centro\s+convenzionato|network\s+sanitario/i.test(
      t
    );
  const facilityLiability =
    /responsabilit[aà]\s+civile|responsabilit[aà]\s+professionale|\bR\.?\s*C\.?\s*T\.?\b|\bR\.?\s*C\.?\s*O\.?\b|polizza\s+n|art(?:icolo)?\.?\s*10.{0,90}(?:legge\s*(?:n\.?\s*)?24|gelli)/i.test(
      t
    );
  return conventionContext && patientBenefit && !facilityLiability;
}

export function isBudgetUlssOrAccordoText(text: string, url?: string): boolean {
  const h = (url ?? "").toLowerCase();
  if (
    /budget|assegnazione[\-_]?budget|accordi[\-_]?contrattual|accordo[\-_]?contrattual|convenzione[\-_]?(?:ulss|asl)|ulss\d|\/ulss[-_]/i.test(
      h
    )
  ) {
    return true;
  }
  const t = text.replace(/\s+/g, " ");
  const ulssAccordo =
    /accordo\s+contrattuale|tra\s+azienda\s+ulss|tra\s+l[\s']?azienda\s+ulss|ulss\s+\d|convenzione\s+(?:con\s+)?(?:l[\s']?)?(?:ulss|asl)/i.test(
      t
    );
  const budgetDoc = /assegnazione\s+budget|budget\s+\d{4}|documento\s+budget/i.test(t);
  if (!ulssAccordo && !budgetDoc) return false;
  return !hasArt10RcOrSelfInsurancePublication(t);
}

/**
 * PARM (art.4) e PARS / piani gestione rischio clinico — NON sono la polizza RC art.10.
 * Es: pars-2025-ICM_.pdf = Piano Annuale Gestione Rischio Sanitario.
 */
export function isGelliComplianceReportPdf(url: string): boolean {
  const h = url.toLowerCase();
  return /parm|pars[\-_./]|[\-_/]pars[\-_./]|\bpars\b|risarcimenti[\-_]?erogat|relazione[\-_]?parm|eventi[\-_]?avvers|griglia[\-_]?rilevaz|relazione.*avvers|piano[\-_]?annuale|gestione[\-_]?del[\-_]?rischio|rischio[\-_]?sanitario|grs[\-_]|risk[\-_]?management|clinical[\-_]?risk|mcrm|manuale[\-_]?risk/i.test(
    h
  );
}

/**
 * Art.10 / autoassicurazione pubblicata dentro PARS o pagina gestione rischio.
 * Non confondere con il solo obbligo PARM (art.4 risarcimenti).
 */
/**
 * Sezione PARM 1.3/1.4: dichiarazione polizza RCT/RCO con compagnia (es. Villa dei Fiori / AmTrust).
 * Diverso da PARM art.4 con sole tabelle risarcimenti erogati (Villa Maione).
 */
export function isParmRcInsuranceDisclosure(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  // PARM tables can disclose the real insurance position without spelling
  // out RCT/RCO in the same row. The explicit heading + validity/company
  // columns + dated policy rows are concrete first-party evidence, unlike
  // generic PARM/Gelli boilerplate.
  if (extractInsurancePositionTableFields(t)) return true;
  if (/risarcimenti\s+erogat|sinistr[oi]\s+liquidat/i.test(t) && !/polizza\s+assicurativa\s+per\s+RCT/i.test(t)) {
    return false;
  }
  const rcDeclared =
    /polizza\s+assicurativa.{0,200}(?:\bRCT\b|\bRCO\b)|stipulat[oa].{0,120}polizza.{0,160}(?:\bRCT\b|\bRCO\b)|polizza\s+assicurativa\s+per\s+RCT/i.test(
      t
    );
  const insurerNamed = /am\s*trust|generali|unipol|berkshire|assicurazion|trust\s+italia/i.test(t);
  const inInsuranceSection =
    /posizione\s+assicurativa|descrizione\s+della\s+posizione\s+assicurativa/i.test(t) ||
    /piano\s+annuale.{0,50}risk\s+management|parm\s*20\d{2}/i.test(t);
  return rcDeclared && insurerNamed && inInsuranceSection;
}

export function hasArt10RcOrSelfInsurancePublication(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (isParmRcInsuranceDisclosure(t)) return true;

  const inInsuranceSection =
    /posizione\s+assicurativa|descrizione\s+della\s+posizione\s+assicurativa/i.test(t);
  const selfRiskDeclared =
    /autoassicuraz|auto[\s-]?assicuraz|ritenzione\s+del\s+rischio|assunzione\s+diretta\s+del\s+rischio|misura\s+analoga\s+(?:alle\s+)?coperture\s+assicurativ|gestione\s+diretta\s+(?:del\s+rischio|dei\s+sinistri|dei\s+rischi)/i.test(
      t
    );
  const rcContext =
    /art\.?\s*10|legge\s+gelli|legge\s*24|responsabilit[aà]\s+civile|\bRCT\b|\bRCO\b|copertura\s+assicurativa|polizza|risk\s+management|\bparm\b/i.test(
      t
    );

  if (inInsuranceSection && selfRiskDeclared && rcContext) return true;

  const selfInsured = selfRiskDeclared;
  const rcPolicy =
    /art\.?\s*10.{0,80}(?:gelli|legge\s*24|n\.?\s*24)/i.test(t) &&
    /polizza\s+n\.?|copertura\s+assicurativa|responsabilit[aà]\s+civile/i.test(t);
  if (selfInsured) return rcContext;
  return rcPolicy;
}

/**
 * PARM/PARS senza art.10 nel testo — usare solo sul testo, non sul solo nome file.
 */
export function isGelliComplianceReportOnly(text: string, url?: string): boolean {
  if (hasExplicitFirstPartyPolicyPublication(text.replace(/\s+/g, " "))) {
    return false;
  }
  if (isGelliComplianceReportText(text)) return true;
  if (!url) return false;
  const h = url.toLowerCase();
  if (!/parm|pars[\-_./]|[\-_/]pars[\-_./]|\bpars\b|risarcimenti[\-_]?erogat|relazione[\-_]?parm/i.test(h)) {
    return false;
  }
  return !hasArt10RcOrSelfInsurancePublication(text);
}

export function isGelliComplianceReportText(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (hasArt10RcOrSelfInsurancePublication(t)) return false;
  // Art.10 RC con polizza su stessa pagina (es. Montevergine)
  if (
    /art\.?\s*10.{0,60}(?:gelli|legge\s*24|n\.?\s*24)/i.test(t) &&
    /polizza\s+n\.?|copertura\s+assicurativa|responsabilit[aà]\s+civile\s+verso/i.test(t) &&
    (/\bRCT\b|\bRCO\b|massimali?/i.test(t) || /generali|unipolsai|berkshire/i.test(t))
  ) {
    return false;
  }
  if (/risarcimenti\s+erogat|sinistr[oi]\s+liquidat|relazione\s+parm/i.test(t)) return true;
  return /piano\s+annuale.{0,80}gestione.{0,40}rischio\s+sanitario|\bpars\b.{0,60}rischio\s+sanitario|gestione\s+del\s+rischio\s+sanitario|risk\s+manager|clinical\s+risk\s+management|manuale.{0,40}risk\s+management|\bmcrm\b/i.test(
    t
  );
}

function hasExplicitFirstPartyPolicyPublication(text: string): boolean {
  if (extractInsurancePositionTableFields(text)) return true;
  if (!findInsurer(text)) return false;
  // A transparency page can contain PARM/Gelli boilerplate after a compact,
  // first-party policy heading. Evaluate that local line before the page-level
  // PARM exclusion (Villa Cinzia: "POLIZZA ASSICURATIVA ... AMTRUST ... RCH...").
  const compactPolicyLine = text.match(/polizza\s+assicurativa[\s\S]{0,360}/i)?.[0] ?? "";
  if (
    compactPolicyLine &&
    findInsurer(compactPolicyLine) &&
    findPolicyNumber(compactPolicyLine)
  ) {
    return true;
  }
  return (
    /(?:siamo\s+a\s+pubblicare|pubblichiamo|si\s+pubblica|pubblicazione).{0,180}(?:testo\s+della\s+)?polizza\s+assicurativa/i.test(
      text
    ) ||
    /(?:[èe]\s+stata|ha|abbiamo)\s+stipulat[ao].{0,100}polizza\s+assicurativa.{0,100}(?:con|presso|da)\s+/i.test(
      text
    ) ||
    /(?:la\s+struttura|la\s+casa\s+di\s+cura|la\s+clinica|la\s+societ[aà]|l['’]azienda).{0,140}(?:[èe]\s+assicurata|risulta\s+assicurata|dispone\s+di\s+copertura).{0,100}(?:con|presso|da)\s+/i.test(
      text
    ) ||
    /polizza\s+assicurativa\s+(?:vigente|in\s+vigore|in\s+corso|in\s+essere).{0,120}(?:con|compagnia|assicuratore)/i.test(
      text
    )
  );
}

export function analyzePolicy(text: string, url?: string): PolicyAnalysis {
  const clean = text.replace(/\s+/g, " ");
  if (isGelliComplianceReportText(clean) && !hasExplicitFirstPartyPolicyPublication(clean)) {
    return {
      policyFound: false,
      confidence: 0,
      company: null,
      massimale: null,
      expiry: null,
      policyNumber: null,
      evidence: null,
    };
  }
  if (isBudgetUlssOrAccordoText(clean, url) || isAccountingOrBalanceSheetText(clean)) {
    return {
      policyFound: false,
      confidence: 0,
      company: null,
      massimale: null,
      expiry: null,
      policyNumber: null,
      evidence: null,
    };
  }
  const focus = policyFocusText(clean);

  const gelliScore = countMatches(clean, GELLI_PATTERNS);
  const insuranceScore = countMatches(clean, INSURANCE_CONTEXT);
  const transparencyScore = countMatches(clean, TRANSPARENCY);

  const positionTable = extractInsurancePositionTableFields(clean);
  const insurer =
    positionTable?.company ??
    (/(?:\bITALIANA\b|\bI?TAL\s*IAN\s*A\b)[\s\S]{0,100}\bASSICURAZIONI\b/i.test(clean)
      ? "Italiana Assicurazioni"
      : null) ??
    findInsurer(focus) ??
    findInsurer(clean);
  const massimale = findMassimale(focus) ?? findMassimale(clean);
  // Scheda di polizza (tabelle PDF): Scade-alle-ore-24 / Periodo assicurazione prima della quietanza.
  const scheda = extractSchedaPolizzaFields(text);
  const expiry =
    positionTable?.expiry ??
    scheda.expiry ??
    findExpiry(stripQuietanzaDates(focus)) ??
    findExpiry(stripQuietanzaDates(clean)) ??
    findExpiry(focus) ??
    findExpiry(clean);
  const policyNumber = sanitizePolicyNumber(
    positionTable?.policyNumber ??
      scheda.policyNumber ??
      findPolicyNumber(focus) ??
      findPolicyNumber(clean)
  );
  const selfInsured =
    detectSelfInsuranceDeclaration(clean).declared &&
    !isAccountingOrBalanceSheetText(clean);

  // Strategia di scoring:
  // - Compagnia + (massimale o scadenza o n.polizza) = pubblicazione concreta
  // - Riferimento Gelli + contesto assicurativo = pubblicazione probabile
  let confidence = 0;
  if (insurer) confidence += 0.35;
  if (massimale) confidence += 0.25;
  if (expiry) confidence += 0.2;
  if (policyNumber) confidence += 0.15;
  if (gelliScore > 0) confidence += 0.2;
  if (insuranceScore >= 2) confidence += 0.15;
  if (transparencyScore > 0) confidence += 0.05;
  if (selfInsured) confidence += 0.4;
  confidence = Math.min(1, confidence);

  // Assigned after the explicit RC/policy-context check below.
  let concreteData = false;
  const appendixPolicy = isPolicyAppendixDocument(clean);
  // Trasparenza HTML: n. polizza + massimale + contesto RC (es. Villa Igea / AmTrust).
  const hasRcContext =
    /polizza\s+in\s+vigore|responsabilit[aà]\s+civile|\bR\.?C\.?T\b|\bR\.?C\.?O\b|art\.?\s*10|legge\s+gelli|copertura\s+assicurativa|polizza\s+stipulata|polizza\s+(?:di\s+)?assicurazione|numero\s+(?:della\s+)?pratica|polizza\s+n/i.test(
      clean
    );
  const hasExplicitRcLabel =
    /polizza\s+r\.?\s*c\.?|r\.?\s*c\.?\s+professionale/i.test(clean);
  // A company token and a date/amount anywhere in a generated page are not
  // insurance evidence. WordPress/JS bundles can contain strings such as
  // "AXA" plus unrelated date ranges. Concrete fields are accepted only when
  // the same resource also contains explicit policy/RC language.
  concreteData = Boolean(
    insurer &&
    (massimale || expiry || policyNumber) &&
    (hasRcContext || hasExplicitRcLabel)
  );
  // Trasparenza HTML: n. polizza + massimale/compagnia + contesto RC.
  const rcDeclaredOnPage =
    Boolean(policyNumber && (massimale || insurer)) &&
    (hasRcContext || hasExplicitRcLabel);
  // Home/footer Art.10: numero + contesto RC anche SENZA compagnia/massimale.
  // Senza questo → falso HOT (es. IATREION "Polizza n. 747217409" in home).
  const htmlPolicyNumberRc =
    Boolean(policyNumber) && (hasRcContext || hasExplicitRcLabel);
  const parmRcDisclosure = isParmRcInsuranceDisclosure(clean) && Boolean(insurer);
  // First-party disclosure pages often publish the policy in prose without a
  // numeric expiry/massimale (e.g. "è stata stipulata ... con AMTrust").
  // Entity attribution remains a separate mandatory gateway before PUBLISHED.
  const explicitFirstPartyPolicyPublication =
    hasExplicitFirstPartyPolicyPublication(clean);

  const rcInsurancePdf =
    Boolean(insurer) &&
    /responsabilit[aà]\s+civile/i.test(clean) &&
    /\bRCT\b|\bRCO\b|contraente|contratto\s+n\.?|quanto\s+assicuriamo|durata\s+del\s+contratto/i.test(
      clean
    );

  const policyFound =
    concreteData ||
    selfInsured ||
    rcDeclaredOnPage ||
    htmlPolicyNumberRc ||
    explicitFirstPartyPolicyPublication ||
    parmRcDisclosure ||
    rcInsurancePdf ||
    (appendixPolicy && Boolean(policyNumber && expiry));

  const company =
    (selfInsured ? "Autoassicurazione / gestione diretta del rischio" : null) ||
    insurer ||
    (rcDeclaredOnPage ? findInsurer(clean) : null);

  // Art. 10 Legge Gelli richiede la pubblicazione della polizza AGGIORNATA.
  // Se scaduta da >365gg → irregolare, ma la polizza È stata pubblicata (non confondere con assenza).
  let isObsolete = false;
  let daysSinceExpiry = 0;
  if (expiry && policyFound) {
    daysSinceExpiry = Math.floor((Date.now() - expiry.getTime()) / 86_400_000);
    // HOT "scaduta" solo con evidenza RC concreta — mai su sola data estratta da budget/ULSS.
    const certifiedRc = Boolean(
      (insurer && !isRejectedInsurerName(insurer) && (massimale || policyNumber)) ||
        (policyNumber && massimale) ||
        rcInsurancePdf
    );
    if (daysSinceExpiry > 365 && certifiedRc) {
      isObsolete = true;
    }
  }

  let finalEvidence: string | null = null;
  if (isObsolete) {
    finalEvidence = `Polizza RC pubblicata sul sito ma scaduta da ${daysSinceExpiry} giorni. Art. 10 L. 24/2017 richiede pubblicazione aggiornata — irregolarità normativa.`;
  } else if (policyFound) {
    finalEvidence = extractEvidence(clean);
  }

  const publishMeta = policyFound;

  return {
    policyFound,
    confidence: policyFound ? 1 : Math.round(confidence * 100) / 100,
    company: publishMeta ? company : null,
    massimale: publishMeta ? massimale : null,
    expiry: publishMeta ? expiry : null,
    policyNumber: publishMeta ? policyNumber : null,
    evidence: finalEvidence,
    policyObsolete: isObsolete,
  };
}

export type PolicyCandidateAnalysis = {
  candidate: boolean;
  resolved: boolean;
  detectorVersion: "policy-candidate-v14";
  reasons: string[];
  policy: PolicyAnalysis;
};

export const POLICY_CANDIDATE_DETECTOR_VERSION = "policy-candidate-v14" as const;

/**
 * Recall-first safety net for the HOT path.
 *
 * `analyzePolicy` intentionally needs concrete evidence before publishing.
 * This detector is broader: an unresolved insurance-looking resource blocks
 * HOT until a later pass can either certify it or prove it unrelated.
 */
export function detectPolicyCandidate(text: string, url?: string): PolicyCandidateAnalysis {
  const clean = text
    .replace(/[|¦]/g, "I")
    .replace(/\s+/g, " ")
    .trim();
  const policy = analyzePolicy(clean, url);
  if (policy.policyFound) {
    return {
      candidate: true,
      resolved: true,
      detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
      reasons: ["POLICY_CERTIFIED"],
      policy,
    };
  }
  if (!clean && !url) {
    return {
      candidate: false,
      resolved: false,
      detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
      reasons: [],
      policy,
    };
  }

  const reasons: string[] = [];
  const explicitInsurance =
    /polizz[ae]|contratto\s+assicurativ|copertura\s+assicurativ|certificat[oa]\s+assicurativ|insurance\s+policy|professional\s+indemnity|malpractice\s+insurance/i.test(
      clean
    );
  const rcContext =
    /responsabilit[aà]\s+civile|responsabilit[aà]\s+professionale|\bR\.?\s*C\.?\s*T\.?\b|\bR\.?\s*C\.?\s*O\.?\b|civil\s+liability|third[-\s]?party\s+liability|medical\s+malpractice/i.test(
      clean
    );
  const identifierMatch = clean.match(
    /(?:n(?:umero|r)?\.?\s*(?:di\s+)?(?:polizza|contratto)|(?:polizza|contratto)\s*(?:n(?:umero|r)?\.?|codice)?)[\s:#-]*([A-Z0-9][A-Z0-9./_-]{4,})/i
  );
  const identifierToken = (identifierMatch?.[1] || "").replace(/[.,;:]+$/g, "");
  // A free-form word after "contratto" (e.g. "contratto servizio" in a
  // privacy policy) is not an identifier. Real-world policy identifiers have
  // at least a digit or a structural separator.
  const contractIdentifier = Boolean(
    identifierToken && (/\d/.test(identifierToken) || /[./_-]/.test(identifierToken))
  );
  const insurer = findInsurer(clean);
  const financialTerms =
    /massimal[ei]|franchigia|premio\s+(?:annuo|lordo|assicurativo)|decorrenza|scadenza|periodo\s+assicurativo|contraente|assicurato|appendice|quietanza/i.test(
      clean
    );
  const art10 =
    /art(?:icolo)?\.?\s*10.{0,90}(?:legge\s*(?:n\.?\s*)?24|gelli)|legge\s+gelli|legge\s+8\s+marzo\s+2017.{0,20}n\.?\s*24/i.test(
      clean
    );
  const selfInsurance = detectSelfInsuranceDeclaration(clean).blocksHotAbsence;
  const policyishUrl =
    /polizz|assicur|rct|rco|gelli|copertura|responsabilit|massimale|quietanza|appendice/i.test(
      url || ""
    );
  const parmAlternativeTemplate =
    isGelliComplianceReportPdf(url || "") &&
    /(?:predetto|detto|il)\s+dato.{0,180}periodo\s+in\s+cui.{0,180}copertura\s+assicurativa.{0,100}\b(?:o|oppure|ovvero)\b.{0,80}auto[\s-]?assicuraz/i.test(
      clean
    ) &&
    /sinistrosit[aà]|risarcimenti\s+erogati/i.test(clean);

  // Long documents often contain unrelated mentions many pages apart
  // (e.g. a patient's travel policy, an insurer convention and Art. 10).
  // Candidate reasons must co-exist in a local passage, otherwise those
  // independent mentions create a permanent false retry.
  const insuranceContexts: string[] = [];
  for (const match of clean.matchAll(
    /polizz[ae]|contratto\s+assicurativ|copertura\s+assicurativ|certificat[oa]\s+assicurativ|responsabilit[aà]\s+civile|responsabilit[aà]\s+professionale|\bR\.?\s*C\.?\s*T\.?\b|\bR\.?\s*C\.?\s*O\.?\b|insurance\s+policy|professional\s+indemnity|medical\s+malpractice/gi
  )) {
    insuranceContexts.push(
      clean.slice(Math.max(0, match.index - 1_200), match.index + 1_500)
    );
  }
  const candidateInsuranceContexts = insuranceContexts.filter(
    (context) =>
      !/(?:cittadin[io]|stranier[io]|extracomunitar[io]).{0,500}(?:tessera\s+sanitaria|polizza\s+assicurativa|codice\s+(?:regionale\s+)?STP)|tessera\s+sanitaria.{0,250}polizza\s+assicurativa.{0,250}(?:STP|stranier)/i.test(
        context
      )
  );
  const closeInsuranceRc = candidateInsuranceContexts.some(
    (context) =>
      /polizz[ae]|contratto\s+assicurativ|copertura\s+assicurativ|certificat[oa]\s+assicurativ|insurance\s+policy|professional\s+indemnity|malpractice\s+insurance/i.test(
        context
      ) &&
      /responsabilit[aà]\s+civile|responsabilit[aà]\s+professionale|\bR\.?\s*C\.?\s*T\.?\b|\bR\.?\s*C\.?\s*O\.?\b|civil\s+liability|third[-\s]?party\s+liability|medical\s+malpractice/i.test(
        context
      )
  );
  const closeInsuranceInsurer = candidateInsuranceContexts.some(
    (context) =>
      /polizz[ae]|contratto\s+assicurativ|copertura\s+assicurativ|certificat[oa]\s+assicurativ|insurance\s+policy|professional\s+indemnity|malpractice\s+insurance/i.test(
        context
      ) && Boolean(findInsurer(context))
  );
  const closeInsuranceTerms = candidateInsuranceContexts.some(
    (context) =>
      /polizz[ae]|contratto\s+assicurativ|copertura\s+assicurativ|certificat[oa]\s+assicurativ|insurance\s+policy|professional\s+indemnity|malpractice\s+insurance/i.test(
        context
      ) &&
      /massimal[ei]|franchigia|premio\s+(?:annuo|lordo|assicurativo)|decorrenza|scadenza|periodo\s+assicurativo|contraente|assicurato|appendice|quietanza/i.test(
        context
      )
  );
  const closeArt10Insurance = candidateInsuranceContexts.some(
    (context) =>
      /art(?:icolo)?\.?\s*10.{0,90}(?:legge\s*(?:n\.?\s*)?24|gelli)|legge\s+gelli|legge\s+8\s+marzo\s+2017.{0,20}n\.?\s*24/i.test(
        context
      )
  );
  const closeInsurerRc = candidateInsuranceContexts.some(
    (context) =>
      Boolean(findInsurer(context)) &&
      /responsabilit[aà]\s+civile|responsabilit[aà]\s+professionale|\bR\.?\s*C\.?\s*T\.?\b|\bR\.?\s*C\.?\s*O\.?\b|civil\s+liability|third[-\s]?party\s+liability|medical\s+malpractice/i.test(
        context
      )
  );

  if (contractIdentifier) reasons.push("POLICY_IDENTIFIER");
  if (closeInsuranceRc) reasons.push("INSURANCE_RC_CONTEXT");
  if (closeInsuranceInsurer) reasons.push("INSURANCE_WITH_INSURER");
  if (
    closeInsuranceTerms &&
    (closeInsuranceRc || closeInsuranceInsurer || (art10 && closeArt10Insurance))
  ) {
    reasons.push("INSURANCE_CONTRACT_TERMS");
  }
  if (art10 && closeArt10Insurance) reasons.push("ART10_INSURANCE_CONTEXT");
  if (selfInsurance) reasons.push("SELF_INSURANCE_LANGUAGE");
  if (policyishUrl && (explicitInsurance || rcContext || insurer)) {
    reasons.push("POLICYISH_RESOURCE");
  }

  // A page that merely explains the statutory duty is not evidence that the
  // facility published a policy. Keep the exception deliberately narrow:
  // concrete identifiers, insurer/RC passages, contract terms and
  // self-insurance declarations must still block HOT.
  const statutoryDutyOnly =
    art10 &&
    /(?:obblig|impone|prevede|dispone|richiede).{0,220}(?:pubblic|stipul)|(?:pubblic|stipul).{0,220}(?:obblig|adempiment|normativ)/i.test(
      clean
    ) &&
    !contractIdentifier &&
    !closeInsuranceRc &&
    !closeInsuranceInsurer &&
    !closeInsuranceTerms &&
    !selfInsurance;
  if (statutoryDutyOnly) {
    return {
      candidate: false,
      resolved: false,
      detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
      reasons: [],
      policy,
    };
  }

  // Known PARM/balance-sheet boilerplate is not enough on its own, but an
  // actual policy identifier or insurer+RC passage inside it remains a block.
  if (
    (parmAlternativeTemplate ||
      isGelliComplianceReportText(clean) ||
      isBudgetUlssOrAccordoText(clean, url) ||
      isAccountingOrBalanceSheetText(clean)) &&
    !contractIdentifier &&
    !closeInsurerRc &&
    !closeInsuranceInsurer &&
    !selfInsurance
  ) {
    return {
      candidate: false,
      resolved: false,
      detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
      reasons: [],
      policy,
    };
  }
  if (
    isPatientInsuranceConventionText(clean, url) &&
    !contractIdentifier &&
    !closeInsuranceRc &&
    !closeInsuranceTerms &&
    !selfInsurance
  ) {
    return {
      candidate: false,
      resolved: false,
      detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
      reasons: [],
      policy,
    };
  }

  return {
    candidate: reasons.length > 0,
    resolved: false,
    detectorVersion: POLICY_CANDIDATE_DETECTOR_VERSION,
    reasons: [...new Set(reasons)],
    policy,
  };
}
