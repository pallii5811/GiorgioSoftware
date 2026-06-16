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
  /gestione\s+diretta\s+(?:del\s+rischio|dei\s+sinistri|dei\s+rischi)/i,
  /fondo\s+(?:rischi|di\s+autoassicurazione)/i,
];

function findInsurer(text: string): string | null {
  for (const insurer of INSURERS) {
    const re = new RegExp(`\\b${insurer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return insurer;
  }
  const free = text.match(
    /compagnia\s+(?:di\s+)?assicurazione\s+([A-Z][A-Za-z0-9\s.&'()/\-]{3,80}?)(?:\s+N\.?\s*Polizza|\s+Scadenza|\s+Massimal|\s+SIR\b|$)/i
  );
  if (free?.[1]) return free[1].trim().replace(/\s+/g, " ");
  return null;
}

function isPayoutTableContext(ctx: string): boolean {
  // Tabelle PARM / art.4: "risarcimenti erogati", "sinistri liquidati" — NON confondere con polizza RC.
  return /risarcimenti\s+erogat|sinistr[oi]\s+liquidat|liquidato\s+annuo|quinquennio/i.test(ctx);
}

function findMassimale(text: string): string | null {
  // RC strutture sanitarie: "Limite dell'Indennizzo ... EUR 5.000.000,00"
  const rcLimit =
    /limite\s+(?:dell['’]?)?indennizzo[^.\n]{0,120}?((?:€|eur|euro)\s*[\d.,]+(?:,\d{2})?)/i;
  const rc = text.match(rcLimit);
  if (rc?.[1]) {
    const ctx = text.slice(Math.max(0, (rc.index ?? 0) - 80), (rc.index ?? 0) + 200);
    if (isPayoutTableContext(ctx)) return null;
    return rc[1].replace(/\s+/g, " ").trim();
  }

  const near =
    /massimal[ei][^.\n]{0,80}?((?:€|euro|eur)\s*[\d.,]+(?:\s*(?:milion[ei]|mln))?|[\d.,]+\s*(?:milion[ei]|mln)\s*(?:di\s*)?(?:euro|€)?|[\d.,]+\s*(?:euro|€|eur))/i;
  const m = text.match(near);
  if (m?.[1]) {
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 200);
    if (isPayoutTableContext(ctx)) return null;
    return m[1].replace(/\s+/g, " ").trim();
  }

  const rco = text.match(
    /RCO\s+(?:per\s+sinistro\s+)?([\d]{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)/i
  );
  if (rco?.[1]) return `EUR ${rco[1].replace(/\s+/g, " ").trim()}`;

  const rct = text.match(/RCT\s+sinistro\s+([\d]{1,3}(?:\.\d{3})+)/i);
  if (rct?.[1]) return `EUR ${rct[1].replace(/\s+/g, " ").trim()}`;

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
    /polizza\s+assicurativa|articolo\s+10.{0,60}gelli|art\.?\s*10.{0,60}gelli|compagnia\s+di\s+assicurazione/i
  );
  if (idx >= 0) return text.slice(idx, idx + 5000);
  // NON fare focus su "risarcimenti erogati"/PARM: è un obbligo diverso (art.4),
  // e contiene spesso compagnie/importi che causano falsi PUBLISHED.
  return text;
}

function findExpiry(text: string): Date | null {
  const periodEnd = text.match(
    /scadenza\s+periodo\s+assicurativo\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+al\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i
  );
  if (periodEnd?.[1]) {
    const d = parseItalianDate(periodEnd[1]);
    if (d) return d;
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
      if (d) return d;
    }
  }
  return null;
}

function findPolicyNumber(text: string): string | null {
  // "n. polizza XXX", "polizza n. XXX", "numero polizza: XXX", "Numero polizza: RC-2024-001234"
  const patterns = [
    /N\.?\s*Polizza\s+RCT\/O\s+([A-Z0-9_]+)/i,
    /\b(\d{4}RCG\d+)\b/i,
    /\b(RCH\d{9,})\b/i,
    /polizza\s+n[°º.]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
    /(?:polizza\s+(?:n\.?|numero|nr\.?)|(?:n\.?|numero|nr\.)\s+polizza)\s*[:\-]?\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
    /numero\s+polizza\s*[:\-]\s*([A-Z0-9][A-Z0-9_./-]{4,})/i,
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
  const n = raw.trim();
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

export function analyzePolicy(text: string): PolicyAnalysis {
  const clean = text.replace(/\s+/g, " ");
  const focus = policyFocusText(clean);

  const gelliScore = countMatches(clean, GELLI_PATTERNS);
  const insuranceScore = countMatches(clean, INSURANCE_CONTEXT);
  const transparencyScore = countMatches(clean, TRANSPARENCY);

  const insurer = findInsurer(focus) ?? findInsurer(clean);
  const massimale = findMassimale(focus) ?? findMassimale(clean);
  const expiry = findExpiry(focus) ?? findExpiry(clean);
  const policyNumber = sanitizePolicyNumber(findPolicyNumber(focus) ?? findPolicyNumber(clean));
  const selfInsured = countMatches(clean, SELF_INSURANCE) > 0;
  // Compagnia esplicita, oppure autoassicurazione (obbligo assolto in forma diretta).
  const company = insurer || (selfInsured ? "Autoassicurazione / gestione diretta del rischio" : null);

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

  // Autoassicurazione = struttura coperta in forma diretta (non lead caldo).
  // Nota: niente "strongGelli" qui: su documenti tipo PARM/ANAC può comparire
  // il contesto assicurativo senza essere la polizza RC art.10.
  let policyFound = concreteData || selfInsured;

  // Art. 10 Legge Gelli richiede la pubblicazione della polizza AGGIORNATA.
  // Se la data di scadenza è passata da più di 1 anno, la polizza trovata
  // NON è valida: la struttura è irregolare e rappresenta un lead prioritario.
  let isObsolete = false;
  let daysSinceExpiry = 0;
  if (expiry && policyFound) {
    daysSinceExpiry = Math.floor((Date.now() - expiry.getTime()) / 86_400_000);
    if (daysSinceExpiry > 365) {
      isObsolete = true;
      policyFound = false; // polizza scaduta = non coperta
    }
  }

  let finalEvidence: string | null = null;
  if (isObsolete) {
    finalEvidence = `Polizza trovata ma scaduta da ${daysSinceExpiry} giorni. Art. 10 L. 24/2017 richiede pubblicazione aggiornata — irregolarità normativa.`;
  } else if (policyFound) {
    finalEvidence = extractEvidence(clean);
  }

  const publishMeta = policyFound || isObsolete;

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
