/**
 * Rilevanza commerciale gare per broker assicurativi / RC / cauzioni.
 * ANAC è fonte autoritativa; questo filtro separa opportunità da rumore.
 */

const INSURANCE_RELEVANT =
  /assicur|polizz|responsabilit[aà]\s+civile|\brc\b|\brct\b|\brco\b|infortuni|malattia|welfare|tutela\s+legale|broker|intermediari|gelli|sanit[aà]|ospedal|clinica|rsa\b|casa\s+di\s+cura|assistenza\s+sanitaria|ulss|asl\b|fondi\s+rischi|autoassicuraz|cauzion|garanzia\s+definitiva|garanzia\s+provvisoria/i;

const LOW_VALUE_NOISE =
  /rifiuti\s+solidi|spazzament|sfalcio|illuminazione\s+pubblica|gas\s+naturale|energia\s+elettrica|fornitura\s+acqua|mensa\s+scolastica|arredo\s+urbano|sfalcio\s+aree\s+verdi/i;

const CAUZIONE_RELEVANT =
  /appalto|aggiudicat|lavori\s+pubblici|realizzazione|costruzion|manutenzione\s+straordinaria|servizio\s+integrat|restauro|adeguamento\s+sismic|fornitura\s+.*(?:biennale|triennale)|noleggio\s+quinquennale/i;

export type GareRelevance = "HIGH" | "MEDIUM" | "LOW";

const MIN_MEDIUM_AMOUNT = 75_000;

export function scoreGareRelevance(
  object: string,
  companyName?: string,
  amount?: number
): GareRelevance {
  const hay = `${object} ${companyName ?? ""}`.toLowerCase();
  if (INSURANCE_RELEVANT.test(hay)) return "HIGH";
  if (LOW_VALUE_NOISE.test(hay)) return "LOW";
  if (/sanit|ospedal|clinica|rsa|cura|ulss|asl|poliambulator/i.test(hay)) return "MEDIUM";
  const amt = typeof amount === "number" && amount > 0 ? amount : 0;
  if (amt >= MIN_MEDIUM_AMOUNT && CAUZIONE_RELEVANT.test(hay)) return "MEDIUM";
  if (amt >= 500_000 && !LOW_VALUE_NOISE.test(hay)) return "MEDIUM";
  return "LOW";
}

export function isGareCommerciallyRelevant(
  object: string,
  companyName?: string,
  amount?: number
): boolean {
  return scoreGareRelevance(object, companyName, amount) !== "LOW";
}

export function computeGareLeadScore(
  relevance: GareRelevance,
  amount: number,
  hasPhone: boolean,
  hasEmail: boolean
): number {
  let s = relevance === "HIGH" ? 70 : relevance === "MEDIUM" ? 50 : 20;
  if (amount >= 1_000_000) s += 15;
  else if (amount >= 250_000) s += 10;
  else if (amount >= 75_000) s += 5;
  if (hasPhone) s += 10;
  if (hasEmail) s += 10;
  return Math.min(100, s);
}
