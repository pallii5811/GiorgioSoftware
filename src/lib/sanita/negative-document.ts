/**
 * Negative document classifier — CCNL/bilancio/privacy ≠ prova assicurativa Gelli.
 * Da usare prima di canEmitPublished sul contenuto corrente.
 */
export type NegativeDocumentKind =
  | "CCNL"
  | "REGOLAMENTO_PERSONALE"
  | "BILANCIO"
  | "CARTA_SERVIZI"
  | "CURRICULUM"
  | "PRIVACY"
  | "MANUALE"
  | "PARM_PARS_SENZA_PROVA"
  | "ARTICOLO_GENERICO"
  | null;

const RULES: Array<{ kind: Exclude<NegativeDocumentKind, null>; re: RegExp; needsInsuranceAbsence?: boolean }> = [
  { kind: "CCNL", re: /\bccnl\b|contratto\s+collettivo\s+nazionale|contratto\s+collettivo\s+di\s+lavoro/i },
  { kind: "REGOLAMENTO_PERSONALE", re: /regolamento\s+(?:del\s+)?personale|codice\s+disciplinare|rapporto\s+di\s+lavoro/i },
  { kind: "BILANCIO", re: /\bbilanci[oi]\b|nota\s+integrativa|conto\s+economico|stato\s+patrimoniale|xbrl/i },
  { kind: "CARTA_SERVIZI", re: /carta\s+(?:dei\s+)?servizi|carta\s+della\s+qualit/i },
  { kind: "CURRICULUM", re: /\bcurriculum\b|\bcv\b|curriculum\s+vitae/i },
  { kind: "PRIVACY", re: /informativa\s+privacy|policy\s+privacy|trattamento\s+dei\s+dati\s+personali|gdpr/i },
  { kind: "MANUALE", re: /manuale\s+(?:operativo|utente|qualit)|procedure\s+operative\s+standard/i },
  {
    kind: "PARM_PARS_SENZA_PROVA",
    re: /\bparm\b|\bpars\b|piano\s+annuale\s+di\s+rischio|piano\s+di\s+gestione\s+del\s+rischio/i,
    needsInsuranceAbsence: true,
  },
  {
    kind: "ARTICOLO_GENERICO",
    re: /articolo\s+di\s+giornale|comunicato\s+stampa|rassegna\s+stampa/,
    needsInsuranceAbsence: true,
  },
];

const STRONG_INSURANCE =
  /numero\s+(?:di\s+)?polizza|polizza\s+n[°o.]?\s*[A-Z0-9\-_/]{4,}|contratto\s+assicurativ|attestazione\s+assicurativ|polizza\s+rct|polizza\s+rco|\brct\b.*\brco\b|massimale\s+(?:di\s+)?(?:€|euro)/i;

export function classifyNegativeInsuranceDocument(
  text: string,
  url?: string | null
): { blocked: boolean; kind: NegativeDocumentKind; reasons: string[] } {
  const hay = `${url || ""}\n${text || ""}`;
  const hasStrong = STRONG_INSURANCE.test(hay);
  const reasons: string[] = [];

  for (const rule of RULES) {
    if (!rule.re.test(hay)) continue;
    if (rule.needsInsuranceAbsence && hasStrong) continue;
    // CCNL / bilancio / privacy: block even if weak insurance mentions appear
    if (!rule.needsInsuranceAbsence || !hasStrong) {
      reasons.push(`documento_negativo:${rule.kind}`);
      return { blocked: true, kind: rule.kind, reasons };
    }
  }

  // URL filename heuristics
  if (/ccnl|bilancio|privacy|carta.?serviz|curriculum|\.cv\./i.test(url || "")) {
    if (!hasStrong || /ccnl/i.test(url || "")) {
      reasons.push("documento_negativo:URL_HINT");
      return { blocked: true, kind: /ccnl/i.test(url || "") ? "CCNL" : "ARTICOLO_GENERICO", reasons };
    }
  }

  return { blocked: false, kind: null, reasons: [] };
}
