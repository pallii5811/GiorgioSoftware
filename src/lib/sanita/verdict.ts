/**
 * Verdetto a 3 stati per la pubblicazione della polizza RC (Legge Gelli).
 *
 * Obiettivo: ZERO falsi HOT (polizza pubblicata ma non vista).
 * HOT solo se crawl esaustivo (Trasparenza + tutti i PDF policy + OCR) e polizza assente.
 * Qualsiasi dubbio → REVIEW. Senza sito → HOT solo dopo verifica portali regionali.
 *
 * Il verdetto viene salvato come prefisso compatto nel campo `evidence`
 * (es. "[V:HOT] ...") per non richiedere modifiche allo schema Prisma.
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

/** Verdetto per una struttura SENZA sito (verifica portali regionali). */
export function verdictFromRegional(opts: {
  checked: boolean;
  policyFound: boolean;
}): Verdict {
  if (opts.policyFound) return "PUBLISHED";
  if (opts.checked) return "HOT"; // verificato sui portali, nessuna pubblicazione
  return "REVIEW";
}

/**
 * Deriva il verdetto di un lead già salvato.
 * Usa il token in evidence se presente; altrimenti fa un fallback prudente
 * sui campi esistenti (per i dati salvati prima dell'introduzione del token).
 */
export function deriveVerdict(lead: {
  lastScannedAt: string | Date | null;
  policyFound: boolean | null;
  websiteReachable: boolean | null;
  website: string | null;
  evidence: string | null;
}): Verdict | null {
  if (!lead.lastScannedAt) return null; // non ancora analizzato
  const token = readVerdictToken(lead.evidence);
  if (token) return token;
  if (lead.policyFound) return "PUBLISHED";
  // Fallback prudente: senza prova di lettura della sezione trasparenza -> REVIEW
  if (lead.website && lead.websiteReachable === false) return "REVIEW";
  return "REVIEW";
}

export const VERDICT_META: Record<
  Verdict,
  { label: string; subtitle: string; tone: string; commercial: string }
> = {
  PUBLISHED: {
    label: "In regola · polizza pubblicata",
    subtitle: "Art. 10 L. 24/2017 — copertura trovata sulle fonti verificate",
    tone: "emerald",
    commercial: "Rinnovo / confronto condizioni prima della scadenza",
  },
  HOT: {
    label: "Irregolare Gelli · lead certificato",
    subtitle: "Sito verificato (identità + Trasparenza/PDF) — polizza NON pubblicata",
    tone: "red",
    commercial: "Vendita RC e messa in regola — chiamare subito",
  },
  REVIEW: {
    label: "Da verificare manualmente",
    subtitle: "Controllo automatico non conclusivo — serve l'esperienza dell'agente",
    tone: "amber",
    commercial: "Verifica manuale su sito o portale ASL prima della chiamata",
  },
};
