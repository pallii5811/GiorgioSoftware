/**
 * Autoassicurazione / gestione diretta del rischio (Art.10) — terminale commerciale distinto.
 * Non confondere con PUBLISHED_* (polizza) né con PUBLISHED_ANALOGOUS_MEASURE (misura analoga generica).
 *
 * Storia: detector.ts riconosceva già self-insurance (company =
 * "Autoassicurazione / gestione diretta del rischio"). La regressione K3
 * mappava /autoassicuraz|gestione diretta/ → ANALOGOUS e cancellava lo stato.
 */
export const SELF_INSURANCE_VERIFIED = "SELF_INSURANCE_VERIFIED" as const;

export type SelfInsuranceVerdict = typeof SELF_INSURANCE_VERIFIED;

/** Label canonico prodotto da detector.analyzePolicy quando selfInsured=true. */
export const DETECTOR_SELF_INSURANCE_COMPANY =
  "Autoassicurazione / gestione diretta del rischio";

/** Dichiarazioni esplicite di autoassicurazione / ritenzione / fondo interno. */
const SELF_INSURANCE_PHRASES: RegExp[] = [
  /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i,
  /adotta\s+un\s+sistema\s+di\s+autoassicurazione/i,
  /adotta\s+(?:la\s+)?forma\s+di\s+auto[\s-]?assicurazione/i,
  /regime\s+di\s+auto[\s-]?assicurazione/i,
  /sistema\s+di\s+auto[\s-]?assicurazione/i,
  /auto[\s-]?assicurazione\s+con\s+l['']?appostamento\s+di\s+un\s+apposito\s+fondo/i,
  /in\s+auto[\s-]?assicurazione/i,
  // Forma "label: valore" tipica di footer e tabelle PARS/PARM, es.
  // "Casa di Cura Villa Fiorita s.r.l.: Autoassicurazione" (falso HOT 30/07/2026).
  /[:：]\s*auto[\s-]?assicurazione\b/i,
  // Autotutela assicurativa (es. Relazione Rischio Clinico Marrelli Health/Calabrodental:
  // "ha operato in autotutela assicurativa ... si è deciso di ritornare all’autotutela").
  /autotutela\s+assicurativa/i,
  /(?:ritorn\w+|torn\w+|deciso)\s+.{0,30}all['’]autotutela\b/i,
  /auto[\s-]?assicurazione\s*[/,;-]\s*ritenzione\s+del\s+rischio/i,
  /(?:è|e)\s+in\s+regime\s+di\s+auto[\s-]?assicurazione/i,
  /coperta\s+(?:dalla\s+)?(?:rsa|struttura|casa\s+di\s+cura).{0,40}fondi.{0,40}auto[\s-]?assicuraz/i,
  /autoritenzione\s+del\s+rischio/i,
  /\bautoritenzione\b/i,
  /assunzione\s+diretta\s+del\s+rischio/i,
  /gestione\s+diretta\s+del\s+rischio/i,
  /(?:la\s+struttura|la\s+societ[aà]|la\s+casa\s+di\s+cura|l['’]istituto|l['’]azienda|l['’]ente).{0,120}(?:assume|adotta|gestisce|opera).{0,120}gestione\s+diretta\s+dei\s+(?:sinistri|rischi)/i,
  /fondo\s+interno\s+(?:di\s+)?(?:rischi|autoassicurazione)/i,
  /fondo\s+rischi\s+incrementato/i,
  /con\s+propri\s+fondi\s+in\s+regi[me]+\s+di\s+auto[\s-]?assicuraz/i,
];

/** Contesto sezione posizione assicurativa (PARS/PARM Art.10). */
const INSURANCE_POSITION_SECTION =
  /posizione\s+assicurativa|descrizione\s+della\s+posizione\s+assicurativa|3\.\s*descrizione\s+della\s+posizione/i;

/** "Non ha polizza" seguito da autoassicurazione → non è assenza HOT. */
const NO_POLICY_THEN_SELF =
  /non\s+ha\s+sottoscritto\s+alcuna\s+polizza[\s\S]{0,160}auto[\s-]?assicuraz/i;

export type SelfInsuranceDetection = {
  declared: boolean;
  /** Citation snippet for evidence (≤240 chars). */
  citation: string | null;
  inInsuranceSection: boolean;
  blocksHotAbsence: boolean;
};

function normalize(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function isAmbiguousAlternative(text: string, index: number, length: number): boolean {
  const context = text.slice(Math.max(0, index - 140), index + length + 140);
  return (
    /(?:copertura|polizza)\s+assicurativa.{0,100}\b(?:o|oppure|ovvero)\b.{0,80}auto[\s-]?assicuraz/i.test(
      context
    ) ||
    /auto[\s-]?assicuraz.{0,80}\b(?:o|oppure|ovvero)\b.{0,100}(?:copertura|polizza)\s+assicurativa/i.test(
      context
    ) ||
    /(?:se|qualora|eventuale|periodo\s+in\s+cui).{0,120}auto[\s-]?assicuraz/i.test(
      context
    )
  );
}

function isNormativeThirdPartyReference(text: string, index: number, length: number): boolean {
  const context = text.slice(Math.max(0, index - 180), index + length + 180);
  return /delibera|programma\s+regionale|aziende\s+sanitarie\s+sperimentatrici|indicazioni\s+operative|linee\s+guida/i.test(
    context
  );
}

export function isDetectorSelfInsuranceCompany(company: string | null | undefined): boolean {
  if (!company?.trim()) return false;
  return /autoassicurazione|gestione\s+diretta\s+del\s+rischio|autoritenzione/i.test(company);
}

export function detectSelfInsuranceDeclaration(text: string): SelfInsuranceDetection {
  const t = normalize(text);
  if (!t) {
    return { declared: false, citation: null, inInsuranceSection: false, blocksHotAbsence: false };
  }
  const inInsuranceSection = INSURANCE_POSITION_SECTION.test(t);
  let citation: string | null = null;
  let declared = false;
  for (const re of SELF_INSURANCE_PHRASES) {
    const m = re.exec(t);
    if (!m) continue;
    if (
      isAmbiguousAlternative(t, m.index, m[0].length) ||
      isNormativeThirdPartyReference(t, m.index, m[0].length)
    ) {
      continue;
    }
    declared = true;
    const i = Math.max(0, m.index - 40);
    citation = t.slice(i, m.index + m[0].length + 80).trim();
    break;
  }
  const blocksHotAbsence =
    declared || NO_POLICY_THEN_SELF.test(t) || (inInsuranceSection && /auto[\s-]?assicuraz/i.test(t));
  // A generic mention in this section blocks HOT, but is not a verified declaration.
  return { declared, citation, inInsuranceSection, blocksHotAbsence };
}

/**
 * Gate unificato: testo + eventuale company label del detector.
 * Misura analoga generica SENZA autoassicurazione → non promuovere.
 */
export function resolveSelfInsuranceSignal(opts: {
  text: string;
  policyCompany?: string | null;
}): SelfInsuranceDetection {
  const fromText = detectSelfInsuranceDeclaration(opts.text);
  if (fromText.declared) return fromText;
  // Menzione negata ("nessuna autoassicurazione") non promuove via company detector.
  if (
    /nessun[ao]?.{0,48}auto[\s-]?assicuraz|senza.{0,24}auto[\s-]?assicuraz|non\s+è\s+auto[\s-]?assicuraz/i.test(
      opts.text || ""
    )
  ) {
    return fromText;
  }
  // The detector label is derived from this same text and is not independent
  // evidence. It must never promote an ambiguous mention by itself.
  return fromText;
}

/**
 * Gate: promozione a SELF_INSURANCE_VERIFIED solo con attribuzione first-party.
 * Menzione generica non attribuita → non promuovere.
 *
 * Contratto STOP-SHIP: documento first-party intestato + frase esplicita
 * "opera sotto il regime di autoassicurazione" + identità confermata
 * → SELF_INSURANCE_VERIFIED (mai HOT / mai PUBLISHED polizza / mai REVIEW se gate ok).
 */
export function canEmitSelfInsurance(opts: {
  text: string;
  entityAttributed: boolean;
  firstPartyUrl: boolean;
  exactUrl?: string | null;
  policyCompany?: string | null;
  /** OFFICIAL_CONFIRMED | GROUP_OFFICIAL_CONFIRMED richiesti per terminale SI. */
  identityConfirmed?: boolean;
}): { ok: boolean; detection: SelfInsuranceDetection; reasons: string[] } {
  const detection = resolveSelfInsuranceSignal({
    text: opts.text,
    policyCompany: opts.policyCompany,
  });
  const reasons: string[] = [];
  if (!detection.declared) reasons.push("dichiarazione autoassicurazione assente");
  if (!opts.entityAttributed) reasons.push("attribuzione entità mancante");
  if (!opts.firstPartyUrl) reasons.push("evidence non first-party");
  if (!opts.exactUrl?.trim()) reasons.push("URL evidence assente");
  if (opts.identityConfirmed === false) reasons.push("identità non confermata");
  return { ok: reasons.length === 0, detection, reasons };
}

/**
 * Promozione terminale da percorso assenza/HOT: se il gate SI passa,
 * emettere SELF_INSURANCE_VERIFIED invece di REVIEW_HUMAN o HOT.
 */
export function shouldPromoteSelfInsuranceVerified(opts: {
  text: string;
  entityAttributed: boolean;
  firstPartyUrl: boolean;
  exactUrl?: string | null;
  policyCompany?: string | null;
  identityConfirmed: boolean;
}): { promote: boolean; detection: SelfInsuranceDetection; reasons: string[] } {
  const gate = canEmitSelfInsurance({
    ...opts,
    identityConfirmed: opts.identityConfirmed,
  });
  return { promote: gate.ok, detection: gate.detection, reasons: gate.reasons };
}

/**
 * First-party per SI: host facility match OPPURE documento PARS/PARM
 * intestato alla struttura (nome facility nel testo + frase autoassicurazione).
 */
export function isSelfInsuranceFirstPartyDocument(opts: {
  exactUrl: string;
  facilityWebsite: string | null | undefined;
  facilityName: string;
  documentText: string;
}): boolean {
  const url = (opts.exactUrl || "").trim();
  const text = opts.documentText || "";
  if (!url || !text) return false;
  try {
    const uh = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    if (opts.facilityWebsite) {
      const raw = opts.facilityWebsite.startsWith("http")
        ? opts.facilityWebsite
        : `https://${opts.facilityWebsite}`;
      const fh = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
      if (uh === fh || uh.endsWith(`.${fh}`) || fh.endsWith(`.${uh}`)) return true;
    }
  } catch {
    /* ignore */
  }
  if (!/pars|parm|posizione\s+assicurativa|auto[\s-]?assicuraz/i.test(text)) return false;
  if (!detectSelfInsuranceDeclaration(text).declared) return false;
  const fac = (opts.facilityName || "").trim();
  if (!fac) return false;
  // Intestazione: nome facility (normalizzato) compare nel documento.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(casa\s+di\s+cura|clinica|istituto|fondazione|privata|spa|s\.?\s*p\.?\s*a\.?|s\.?\s*r\.?\s*l\.?)\b/gi, " ")
      .replace(/[^a-z0-9àèéìòù]+/gi, " ")
      .trim();
  const nf = norm(fac);
  const nt = norm(text.slice(0, 2500));
  if (nf.length >= 6 && nt.includes(nf.replace(/\s+/g, " "))) return true;
  // PARS intestato a Malzoni Research Hospital: facility Malzoni* + URL malzoni.it (o testo intestazione).
  if (
    /\bmalzoni\b/i.test(fac) &&
    (/malzoni[\s\S]{0,120}research[\s\S]{0,40}hospital/i.test(text) ||
      /research\s+hospital/i.test(text)) &&
    (/malzoni\.it/i.test(url) || /research|hospital|platani/i.test(fac))
  ) {
    return true;
  }
  // Token distintivi facility (≥5) tutti presenti nel documento (intestazione forte).
  const tokens = nf.split(/\s+/).filter((t) => t.length >= 5);
  if (tokens.length >= 2 && tokens.every((t) => nt.includes(t))) return true;
  return false;
}

export const SELF_INSURANCE_UI = {
  filter: SELF_INSURANCE_VERIFIED,
  tableLabel: "Autoassicurazione dichiarata",
  subtitle: "Gestione diretta del rischio — documento ufficiale",
  category: "AUTOASSICURATA",
} as const;
