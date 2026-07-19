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

/** Verdetto per struttura senza sito crawlato — mai HOT senza crawl esaustivo del sito. */
export function verdictFromRegional(opts: {
  checked: boolean;
  policyFound: boolean;
  hasWebsite?: boolean;
}): Verdict {
  if (opts.policyFound) return "PUBLISHED";
  return "REVIEW";
}

import type { CrawlCompleteness } from "@/lib/evidence/contract";
import {
  canEmitHot,
  explainCanEmitHot,
  MIN_PAGES_FOR_HOT,
} from "@/lib/sanita/can-emit-hot";
import type { IdentityStatus } from "@/lib/sanita/identity-evidence";

export { MIN_PAGES_FOR_HOT };

export type FinalizeVerdictInput = {
  verdict: Verdict;
  evidenceBody: string;
  pagesVisited: number;
  websiteReachable: boolean | null;
  website: string | null;
  policyCompany?: string | null;
  policyExpiry?: Date | null;
  policyObsolete?: boolean;
  /** Crawl BFS+PDF completato sul dominio — obbligatorio per HOT "assente". */
  policyExhaustive?: boolean;
  /** PDF policy non decodificabile — mai HOT assenza. */
  needsOcrReview?: boolean;
  /** Completezza strutturale — se presente, HOT richiede complete=true. */
  crawlCompleteness?: CrawlCompleteness | null;
  identityStatus?: IdentityStatus | "UNKNOWN" | null;
  category?: string | null;
};

/**
 * Ultimo gate prima del DB: HOT solo via canEmitHot (unico controllo).
 * Polizza scaduta pubblicata non è HOT — resta PUBLISHED (sottotipo EXPIRED).
 * Incompletezza tecnica → REVIEW legacy token + STATE:RETRY_PENDING (non REVIEW_HUMAN).
 */
export function finalizeVerdict(input: FinalizeVerdictInput): {
  verdict: Verdict;
  evidenceBody: string;
  downgraded: boolean;
  processingHint: "RETRY_PENDING" | "REVIEW_HUMAN" | null;
} {
  let verdict = input.verdict;
  let evidenceBody = input.evidenceBody;

  // Scaduta pubblicata → PUBLISHED (non HOT assenza).
  if (
    verdict === "HOT" &&
    input.policyObsolete &&
    (input.policyCompany || input.policyExpiry || /polizza\s+rc\s+pubblicata|scaduta\s+da/i.test(evidenceBody))
  ) {
    verdict = "PUBLISHED";
    return { verdict, evidenceBody, downgraded: false, processingHint: null };
  }

  if (verdict !== "HOT") return { verdict, evidenceBody, downgraded: false, processingHint: null };

  const hotEv = {
    website: input.website,
    websiteReachable: input.websiteReachable,
    pagesVisited: input.pagesVisited,
    policyExhaustive: input.policyExhaustive === true,
    needsOcrReview: Boolean(input.needsOcrReview),
    crawlCompleteness: input.crawlCompleteness ?? null,
    identityStatus: input.identityStatus ?? "UNKNOWN",
    category: input.category,
  };

  if (!canEmitHot(hotEv)) {
    const { reasons } = explainCanEmitHot(hotEv);
    const tech = reasons.some((r) =>
      /OCR|incompleto|cap |URL rilevanti|PDF|JSON|script|sitemap|esaustiv|pagine insufficienti/i.test(r)
    );
    const identityHuman = reasons.some((r) => /identità non terminale|categoria sanitaria assente|sito assente/i.test(r));
    const hint = tech && !identityHuman ? ("RETRY_PENDING" as const) : ("REVIEW_HUMAN" as const);
    evidenceBody = `HOT bloccato (canEmitHot): ${reasons.join("; ")}. ${evidenceBody}`;
    return {
      verdict: "REVIEW",
      evidenceBody,
      downgraded: true,
      processingHint: hint,
    };
  }
  return { verdict, evidenceBody, downgraded: false, processingHint: null };
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
    label: "Polizza pubblicata",
    subtitle: "Art. 10 L. 24/2017 — pubblicazione trovata (controllare validità/scadenza)",
    tone: "emerald",
    commercial: "Verificare scadenza e opportunità rinnovo — non assume conformità automatica",
  },
  HOT: {
    label: "Assenza verificata dopo scansione completa",
    subtitle: "Crawl completo + identità ufficiale — polizza NON trovata sul sito",
    tone: "red",
    commercial: "Vendita RC e messa in regola — chiamare subito",
  },
  REVIEW: {
    label: "Verifica umana necessaria",
    subtitle: "Ambiguo dopo waterfall — non è un errore tecnico temporaneo",
    tone: "amber",
    commercial: "Verifica manuale su sito o portale ASL prima della chiamata",
  },
};
