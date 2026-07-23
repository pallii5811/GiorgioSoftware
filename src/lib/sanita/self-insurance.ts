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
  /regime\s+di\s+auto[\s-]?assicurazione/i,
  /sistema\s+di\s+auto[\s-]?assicurazione/i,
  /auto[\s-]?assicurazione\s+con\s+l['']?appostamento\s+di\s+un\s+apposito\s+fondo/i,
  /in\s+auto[\s-]?assicurazione/i,
  /(?:è|e)\s+in\s+regime\s+di\s+auto[\s-]?assicurazione/i,
  /coperta\s+(?:dalla\s+)?(?:rsa|struttura|casa\s+di\s+cura).{0,40}fondi.{0,40}auto[\s-]?assicuraz/i,
  /autoritenzione\s+del\s+rischio/i,
  /\bautoritenzione\b/i,
  /assunzione\s+diretta\s+del\s+rischio/i,
  /gestione\s+diretta\s+del\s+rischio/i,
  /gestione\s+diretta\s+dei\s+(?:sinistri|rischi)/i,
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
    declared = true;
    const i = Math.max(0, m.index - 40);
    citation = t.slice(i, m.index + m[0].length + 80).trim();
    break;
  }
  const blocksHotAbsence =
    declared || NO_POLICY_THEN_SELF.test(t) || (inInsuranceSection && /auto[\s-]?assicuraz/i.test(t));
  // Generic "autoassicurazione" in insurance-position section (PARS §3) is enough.
  if (!declared && inInsuranceSection && /auto[\s-]?assicuraz/i.test(t)) {
    declared = true;
    const m = /auto[\s-]?assicuraz[^.]{0,80}/i.exec(t);
    citation = m ? m[0].trim() : citation;
  }
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
  if (isDetectorSelfInsuranceCompany(opts.policyCompany)) {
    return {
      declared: true,
      citation: opts.policyCompany!.trim(),
      inInsuranceSection: fromText.inInsuranceSection,
      blocksHotAbsence: true,
    };
  }
  return fromText;
}

/**
 * Gate: promozione a SELF_INSURANCE_VERIFIED solo con attribuzione first-party.
 * Menzione generica non attribuita → non promuovere.
 */
export function canEmitSelfInsurance(opts: {
  text: string;
  entityAttributed: boolean;
  firstPartyUrl: boolean;
  exactUrl?: string | null;
  policyCompany?: string | null;
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
  return { ok: reasons.length === 0, detection, reasons };
}

export const SELF_INSURANCE_UI = {
  filter: SELF_INSURANCE_VERIFIED,
  tableLabel: "Autoassicurazione dichiarata",
  subtitle: "Gestione diretta del rischio — documento ufficiale",
  category: "AUTOASSICURATA",
} as const;
