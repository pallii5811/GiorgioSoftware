/**
 * Classificazione deterministica tipo contratto gare (LAVORI/SERVIZI/…).
 * Separata dalla rilevanza broker GARE_HIGH/MEDIUM/LOW.
 * Preferisce NON_CLASSIFICATO a categorie inventate.
 */
import { scoreGareRelevance } from "@/lib/gare/relevance";

export type GareContractType =
  | "LAVORI"
  | "SERVIZI"
  | "FORNITURE"
  | "CONCESSIONI"
  | "MISTO"
  | "NON_CLASSIFICATO";

/** Prefissi CPV (prime 2 cifre) → tipo, quando univoci. */
const CPV_PREFIX: Record<string, GareContractType> = {
  "45": "LAVORI",
  "50": "SERVIZI",
  "71": "SERVIZI",
  "72": "SERVIZI",
  "79": "SERVIZI",
  "85": "SERVIZI",
  "90": "SERVIZI",
  "98": "SERVIZI",
  "30": "FORNITURE",
  "31": "FORNITURE",
  "32": "FORNITURE",
  "33": "FORNITURE",
  "34": "FORNITURE",
  "35": "FORNITURE",
  "38": "FORNITURE",
  "39": "FORNITURE",
  "42": "FORNITURE",
  "44": "FORNITURE",
};

const LAVORI_RE =
  /\b(lavori|costruzion|edilizi|ristruttur|restauro|opere\s+pubblic|manutenzione\s+straordinaria|scavo|impermeabilizz|adeguamento\s+sismic|cappotto|rifacimento)\b/i;
const SERVIZI_RE =
  /\b(servizi|gestione|assistenza|pulizia|vigilanza|manutenzione\s+ordinaria|consulenza|progettazione|noleggio\s+serviz|somministrazione|trasporto\s+persone)\b/i;
const FORNITURE_RE =
  /\b(fornitura|forniture|acquisto|apparecchiature|dispositivi|materiale|beni|attrezzatur|farmac|medicinal)\b/i;
const CONCESSIONI_RE = /\b(concessione|project\s+financing|finanza\s+di\s+progetto)\b/i;

export function extractCpvCodes(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{8})\b/g)) out.add(m[1]);
  for (const m of text.matchAll(/CPV[:\s]+(\d{2,8})/gi)) {
    const digits = m[1].padEnd(8, "0").slice(0, 8);
    out.add(digits);
  }
  return [...out];
}

function fromCpv(codes: string[]): GareContractType | null {
  if (!codes.length) return null;
  const types = new Set<GareContractType>();
  for (const c of codes) {
    const pref = c.slice(0, 2);
    const t = CPV_PREFIX[pref];
    if (t) types.add(t);
  }
  if (types.size === 0) return null;
  if (types.size === 1) return [...types][0];
  return "MISTO";
}

/**
 * Classifica il tipo contratto da CPV + oggetto (+ metadati testuali).
 * Non usa la rilevanza broker. Campo assente → NON_CLASSIFICATO.
 */
export function classifyGareContractType(input: {
  object?: string | null;
  cpvText?: string | null;
  tenderMeta?: string | null;
  mainProcurementCategory?: string | null;
}): { type: GareContractType; method: string; evidence: string } {
  const mpc = (input.mainProcurementCategory || "").toLowerCase().trim();
  if (mpc === "works" || mpc === "lavori") {
    return { type: "LAVORI", method: "mainProcurementCategory", evidence: mpc };
  }
  if (mpc === "services" || mpc === "servizi") {
    return { type: "SERVIZI", method: "mainProcurementCategory", evidence: mpc };
  }
  if (mpc === "goods" || mpc === "supplies" || mpc === "forniture") {
    return { type: "FORNITURE", method: "mainProcurementCategory", evidence: mpc };
  }

  const hay = [input.object, input.cpvText, input.tenderMeta].filter(Boolean).join(" \n ");
  if (!hay.trim()) {
    return { type: "NON_CLASSIFICATO", method: "missing", evidence: "" };
  }

  const codes = extractCpvCodes(hay);
  const cpv = fromCpv(codes);
  if (cpv) {
    return { type: cpv, method: "cpv", evidence: codes.slice(0, 3).join(",") };
  }

  if (CONCESSIONI_RE.test(hay)) {
    return { type: "CONCESSIONI", method: "object_keyword", evidence: "concessione" };
  }

  const L = LAVORI_RE.test(hay);
  const S = SERVIZI_RE.test(hay);
  const F = FORNITURE_RE.test(hay);
  const hits = [L, S, F].filter(Boolean).length;
  if (hits >= 2) {
    return { type: "MISTO", method: "object_keyword_multi", evidence: `L=${L},S=${S},F=${F}` };
  }
  if (L) return { type: "LAVORI", method: "object_keyword", evidence: "lavori" };
  if (S) return { type: "SERVIZI", method: "object_keyword", evidence: "servizi" };
  if (F) return { type: "FORNITURE", method: "object_keyword", evidence: "forniture" };

  return { type: "NON_CLASSIFICATO", method: "ambiguous_or_generic", evidence: hay.slice(0, 80) };
}

export function formatContractTypeMarker(type: GareContractType): string {
  return `[CONTRACT_TYPE:${type}]`;
}

export function parseContractTypeMarker(evidence: string | null | undefined): GareContractType | null {
  const m = evidence?.match(
    /\[CONTRACT_TYPE:(LAVORI|SERVIZI|FORNITURE|CONCESSIONI|MISTO|NON_CLASSIFICATO)\]/i
  );
  return m ? (m[1].toUpperCase() as GareContractType) : null;
}

/**
 * Root cause GARE_undefined: `relevanceCategory(undefined)` → "GARE_undefined".
 * Missing/unresolvable → NON_CLASSIFICATO (mai inventare GARE_LOW come categoria).
 */
export function normalizeGareRelevanceCategory(
  category: string | null | undefined,
  object?: string | null,
  companyName?: string | null,
  amount?: number | null
): string {
  const c = (category || "").trim().toUpperCase();
  if (c === "GARE_HIGH" || c === "GARE_MEDIUM") return c;
  if (c === "NON_CLASSIFICATO") return "NON_CLASSIFICATO";
  if (c === "GARE_LOW") return "NON_CLASSIFICATO";
  if (!c || /undefined/i.test(c) || c === "GARE_") {
    const r = scoreGareRelevance(object || "", companyName || undefined, amount ?? undefined);
    if (r === "HIGH") return "GARE_HIGH";
    if (r === "MEDIUM") return "GARE_MEDIUM";
    return "NON_CLASSIFICATO";
  }
  return category!.trim();
}
