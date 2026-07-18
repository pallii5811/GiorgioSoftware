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

// Gestione del rischio in forma diretta (tipica di ASL/strutture pubbliche):
// l'obbligo è assolto SENZA polizza con compagnia -> NON è un lead caldo.
const SELF_INSURANCE = [
  /autoassicuraz/i,
  /auto[\s-]?assicuraz/i,
  /autoritenzione/i,
  /ritenzione\s+del\s+rischio/i,
  /assunzione\s+diretta\s+del\s+rischio/i,
  /misura\s+analoga\s+(?:alle\s+)?coperture\s+assicurativ/i,
  /gestione\s+diretta\s+(?:del\s+rischio|dei\s+sinistri|dei\s+rischi)/i,
  /fondo\s+(?:rischi|di\s+autoassicurazione|riserva\s+sinistri)/i,
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
    /limite\s+(?:dell['’]?)?indennizzo[^.\n]{0,120}?((?:€|eur|euro)\s*[\d.,]+(?:,\d{2})?)/i;
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
    /numero\s+(?:della\s+)?pratica\s+(?:[éeè]\s*:?\s*)?(\d{6,12})/i,
    /codice\s+polizza\s+(\d{6,12})/i,
    /N\.?\s*Polizza\s+RCT\/O\s+([A-Z0-9_]+)/i,
    /\b(\d{4}RCG\d+)\b/i,
    /\b(RCH\d{9,})\b/i,
    /polizza\s+n[°º.]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
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

export function analyzePolicy(text: string, url?: string): PolicyAnalysis {
  const clean = text.replace(/\s+/g, " ");
  if (isGelliComplianceReportText(clean)) {
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

  const insurer = findInsurer(focus) ?? findInsurer(clean);
  const massimale = findMassimale(focus) ?? findMassimale(clean);
  const expiry = findExpiry(focus) ?? findExpiry(clean);
  const policyNumber = sanitizePolicyNumber(findPolicyNumber(focus) ?? findPolicyNumber(clean));
  const selfInsured =
    countMatches(clean, SELF_INSURANCE) > 0 && !isAccountingOrBalanceSheetText(clean);

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

  // Soglia ANTI falso-positivo: dichiariamo "polizza pubblicata" solo con evidenza concreta.
  //  - concreteData: nome compagnia + (massimale | scadenza | n. polizza) -> prova diretta
  const concreteData = Boolean(insurer && (massimale || expiry || policyNumber));
  const appendixPolicy = isPolicyAppendixDocument(clean);
  // Trasparenza HTML: n. polizza + massimale + contesto RC (es. Villa Igea / AmTrust).
  const rcDeclaredOnPage =
    Boolean(policyNumber && (massimale || insurer)) &&
    /polizza\s+in\s+vigore|responsabilit[aà]\s+civile|\bR\.?C\.?T\b|\bR\.?C\.?O\b|art\.?\s*10|legge\s+gelli|copertura\s+assicurativa|polizza\s+stipulata|numero\s+(?:della\s+)?pratica/i.test(
      clean
    );
  const parmRcDisclosure = isParmRcInsuranceDisclosure(clean) && Boolean(insurer);

  const rcInsurancePdf =
    Boolean(insurer) &&
    /responsabilit[aà]\s+civile/i.test(clean) &&
    /\bRCT\b|\bRCO\b|contraente|contratto\s+n\.?|quanto\s+assicuriamo|durata\s+del\s+contratto/i.test(
      clean
    );

  let policyFound =
    concreteData ||
    selfInsured ||
    rcDeclaredOnPage ||
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
