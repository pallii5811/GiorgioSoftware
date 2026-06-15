/**
 * Rilevanza commerciale gare per broker assicurativi / RC.
 * ANAC è fonte autoritativa; questo filtro separa gare utili da rumore (rifiuti, manutenzione generica).
 */

const INSURANCE_RELEVANT =
  /assicur|polizz|responsabilit[aà]\s+civile|\brc\b|\brct\b|\brco\b|infortuni|malattia|welfare|tutela\s+legale|broker|intermediari|gelli|sanit[aà]|ospedal|clinica|rsa\b|casa\s+di\s+cura|assistenza\s+sanitaria|ulss|asl\b|fondi\s+rischi|autoassicuraz/i;

const LOW_VALUE_NOISE =
  /rifiuti\s+solidi|spazzament|sfalcio|illuminazione\s+pubblica|gas\s+naturale|energia\s+elettrica|fornitura\s+acqua|mensa\s+scolastica|arredo\s+urbano/i;

export type GareRelevance = "HIGH" | "MEDIUM" | "LOW";

export function scoreGareRelevance(object: string, companyName?: string): GareRelevance {
  const hay = `${object} ${companyName ?? ""}`.toLowerCase();
  if (INSURANCE_RELEVANT.test(hay)) return "HIGH";
  if (LOW_VALUE_NOISE.test(hay)) return "LOW";
  if (/sanit|ospedal|clinica|rsa|cura|ulss|asl|poliambulator/i.test(hay)) return "MEDIUM";
  return "LOW";
}

export function isGareCommerciallyRelevant(object: string, companyName?: string): boolean {
  return scoreGareRelevance(object, companyName) !== "LOW";
}
