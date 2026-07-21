/**
 * Verdetto a 3 stati per la pubblicazione della polizza RC (Legge Gelli).
 * Modulo client-safe: niente import di frontier/sqlite/canEmitHot/finalizeVerdict.
 */

export type Verdict = "PUBLISHED" | "HOT" | "REVIEW";

const TOKEN: Record<Verdict, string> = {
  PUBLISHED: "[V:PUB]",
  HOT: "[V:HOT]",
  REVIEW: "[V:REV]",
};

/** Inserisce il token di verdetto in testa all'evidence. */
export function encodeEvidence(verdict: Verdict, evidence: string | null): string {
  const body = (evidence ?? "").replace(/^\[V:(PUB|HOT|REV)\]\s*/i, "").trim();
  return `${TOKEN[verdict]} ${body}`.trim();
}

/** Estrae il verdetto dall'evidence (se presente il token). */
export function readVerdictToken(evidence: string | null | undefined): Verdict | null {
  if (!evidence) return null;
  if (/^\[V:PUB\]/i.test(evidence)) return "PUBLISHED";
  if (/^\[V:HOT\]/i.test(evidence)) return "HOT";
  if (/^\[V:REV\]/i.test(evidence)) return "REVIEW";
  return null;
}

/** Testo dell'evidence senza il token. */
export function stripVerdictToken(evidence: string | null | undefined): string | null {
  if (!evidence) return null;
  const body = evidence.replace(/^\[V:(PUB|HOT|REV)\]\s*/i, "").trim();
  return body || null;
}

/** Verdetto preliminare sito — HOT vietato qui (solo reconcilePolicyVerdict può emettere HOT). */
export function verdictFromSite(opts: {
  reachable: boolean;
  policyFound: boolean;
  foundRelevantPage: boolean;
}): Verdict {
  if (opts.policyFound) return "PUBLISHED";
  return "REVIEW";
}

/** Verdetto per struttura senza sito crawlato — mai HOT senza crawl esaustivo del sito. */
export function verdictFromRegional(opts: {
  checked: boolean;
  policyFound: boolean;
  hasWebsite?: boolean;
}): Verdict {
  if (opts.policyFound) return "PUBLISHED";
  return "REVIEW";
}

/**
 * Deriva il verdetto di un lead già salvato.
 */
export function deriveVerdict(lead: {
  lastScannedAt: string | Date | null;
  policyFound: boolean | null;
  websiteReachable: boolean | null;
  website: string | null;
  evidence: string | null;
}): Verdict | null {
  if (!lead.lastScannedAt) return null;
  // Technical queues are not REVIEW — filter via processingState, not legacy token.
  if (/\[STATE:(RETRY_PENDING|TECHNICAL_BLOCKED|CRAWL_RUNNING)\]/i.test(lead.evidence || "")) {
    return null;
  }
  const token = readVerdictToken(lead.evidence);
  if (token) return token;
  if (lead.policyFound) return "PUBLISHED";
  if (lead.website && lead.websiteReachable === false) return "REVIEW";
  return "REVIEW";
}

export const VERDICT_META: Record<
  Verdict,
  { label: string; subtitle: string; tone: string; commercial: string }
> = {
  PUBLISHED: {
    label: "Polizza pubblicata",
    subtitle: "Art. 10 L. 24/2017 — pubblicazione trovata (controllare validità/scadenza)",
    tone: "emerald",
    commercial: "Verificare scadenza e opportunità rinnovo — non assume conformità automatica",
  },
  HOT: {
    label: "Polizza non trovata dopo verifica completa",
    subtitle: "Verifica completa sul sito — pubblicazione non trovata",
    tone: "red",
    commercial: "Vendita RC e messa in regola — chiamare subito",
  },
  REVIEW: {
    label: "Controllo necessario",
    subtitle: "Esito non conclusivo — serve un controllo",
    tone: "amber",
    commercial: "Verifica manuale su sito o portale ASL prima della chiamata",
  },
};
