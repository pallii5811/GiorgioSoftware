/**
 * Mapping puro checkpoint-v3/result-row → riga risultato shadow per la UI.
 * Nessun I/O: tutte le funzioni sono testabili in node puro.
 * Usata da GET /api/sanita/archive-revalidation/results.
 */

export type ShadowResultRow = {
  leadId: string;
  companyName: string | null;
  city: string | null;
  region: string | null;
  processingState: string | null;
  businessVerdict: string | null;
  publishedSubtype: "policy_valid" | "policy_expired" | "date_unknown" | "self_insurance" | null;
  policyCompany: string | null;
  policyNumber: string | null;
  policyExpiry: string | null;
  policyFound: boolean | null;
  evidence: string;
  evidenceUrls: string[];
  pdfHash: string | null;
  completedAt: string | null;
  appliedLive: false;
  frontierComplete: boolean | null;
  unresolvedRelevantNodes: number | null;
};

export type CheckpointTerminal = {
  finishedAt?: string;
  processingState?: string;
  newVerdict?: string | null;
  reasonCode?: string;
};

export type CheckpointRetry = {
  attempts?: number;
  lastReason?: string;
  lastError?: string | null;
  nextRetryAt?: string;
  lastAttemptAt?: string;
};

/** Sottotipo polizza dal processingState v3 (gli stati sono già i sottotipi canonici). */
export function publishedSubtypeOf(
  processingState: string | null | undefined
): ShadowResultRow["publishedSubtype"] {
  switch (processingState) {
    case "SELF_INSURANCE_VERIFIED":
      return "self_insurance";
    case "PUBLISHED_CURRENT":
    case "PUBLISHED_ANALOGOUS_MEASURE":
      return "policy_valid";
    case "PUBLISHED_EXPIRED":
      return "policy_expired";
    case "PUBLISHED_DATE_UNKNOWN":
      return "date_unknown";
    default:
      return null;
  }
}

/** Nodi rilevanti irrisolti dal marker [FRONTIER:OPEN,p=..,f=..,..] nell'evidence. */
export function unresolvedFromEvidence(evidence: string | null | undefined): number | null {
  if (!evidence) return null;
  const m = evidence.match(/\[FRONTIER:(?:OPEN|CLOSED),p=(\d+),f=(\d+)/i);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]);
}

/** URL probanti dal testo evidence: PDF + fonti polizza esplicite, dedup, max 6. */
export function evidenceUrlsFromText(evidence: string | null | undefined): string[] {
  if (!evidence) return [];
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const v = (u || "").trim().replace(/[.,;\])]+$/, "");
    if (v && /^https?:\/\//i.test(v) && !out.includes(v)) out.push(v);
  };
  // fonti esplicite prima (più probanti)
  for (const m of evidence.matchAll(/fonte polizza (?:PDF|HTML):\s*(https?:\/\/\S+)/gi)) {
    push(m[1]);
  }
  for (const m of evidence.matchAll(/certificata da PDF:\s*(https?:\/\/\S+)/gi)) {
    push(m[1]);
  }
  for (const m of evidence.matchAll(/https?:\/\/[^\s\]]+\.pdf(?:\?[^\s\]]*)?/gi)) {
    push(m[0]);
  }
  return out.slice(0, 6);
}

/** Mappa un result-row v3 (file results/<id>.json) nella riga UI. */
export function mapResultRow(row: Record<string, unknown>): ShadowResultRow {
  const evidence = typeof row.fullEvidence === "string" ? row.fullEvidence : "";
  const processingState =
    typeof row.processingState === "string" ? row.processingState : null;
  const contentHash = typeof row.contentHash === "string" ? row.contentHash : null;
  return {
    leadId: String(row.id || ""),
    companyName: (row.companyName as string) ?? null,
    city: (row.city as string) ?? null,
    region: (row.region as string) ?? null,
    processingState,
    businessVerdict: (row.businessVerdict as string) ?? null,
    publishedSubtype: publishedSubtypeOf(processingState),
    policyCompany: (row.policyCompany as string) ?? null,
    policyNumber: (row.policyNumber as string) ?? null,
    policyExpiry: (row.policyExpiry as string) ?? null,
    policyFound: typeof row.policyFound === "boolean" ? row.policyFound : null,
    evidence,
    evidenceUrls: evidenceUrlsFromText(evidence),
    pdfHash: contentHash && /^[0-9a-f]{64}$/i.test(contentHash) ? contentHash : null,
    completedAt: (row.finishedAt as string) ?? null,
    appliedLive: false,
    frontierComplete: typeof row.crawlComplete === "boolean" ? row.crawlComplete : null,
    unresolvedRelevantNodes: unresolvedFromEvidence(evidence),
  };
}

/** Riga minima quando il result file manca: solo dati di checkpoint. */
export function mapCheckpointOnly(
  leadId: string,
  terminal?: CheckpointTerminal,
  retry?: CheckpointRetry
): ShadowResultRow {
  return {
    leadId,
    companyName: null,
    city: null,
    region: null,
    processingState: terminal?.processingState ?? retry?.lastReason ?? null,
    businessVerdict: terminal?.newVerdict ?? null,
    publishedSubtype: publishedSubtypeOf(terminal?.processingState),
    policyCompany: null,
    policyNumber: null,
    policyExpiry: null,
    policyFound: null,
    evidence: "",
    evidenceUrls: [],
    pdfHash: null,
    completedAt: terminal?.finishedAt ?? retry?.lastAttemptAt ?? null,
    appliedLive: false,
    frontierComplete: null,
    unresolvedRelevantNodes: null,
  };
}

export function inRunScope(
  completedAt: string | null,
  runStartedAt: string | null
): boolean {
  if (!runStartedAt) return true;
  if (!completedAt) return false;
  return completedAt >= runStartedAt; // ISO 8601 UTC: confronto lessicografico valido
}

export type ResultsFilter = {
  region?: string | null;
  outcome?: string | null;
  city?: string | null;
  q?: string | null;
};

export function applyFilters(
  rows: ShadowResultRow[],
  f: ResultsFilter
): ShadowResultRow[] {
  let out = rows;
  if (f.region && f.region !== "ALL") {
    const want = f.region.toLowerCase();
    out = out.filter((r) => (r.region || "").toLowerCase() === want);
  }
  if (f.outcome && f.outcome !== "ALL") {
    const o = f.outcome;
    out = out.filter((r) => {
      if (o === "HOT_VERIFIED") return r.processingState === "HOT_VERIFIED";
      if (o === "SELF_INSURANCE_VERIFIED") return r.processingState === "SELF_INSURANCE_VERIFIED";
      if (o === "REVIEW_HUMAN") return r.processingState === "REVIEW_HUMAN";
      if (o === "RETRY_PENDING") {
        return !r.completedAt || r.processingState === "RETRY_PENDING";
      }
      return r.processingState === o;
    });
  }
  if (f.city) {
    const want = f.city.toLowerCase();
    out = out.filter((r) => (r.city || "").toLowerCase().includes(want));
  }
  if (f.q) {
    const want = f.q.toLowerCase();
    out = out.filter(
      (r) =>
        (r.companyName || "").toLowerCase().includes(want) ||
        (r.city || "").toLowerCase().includes(want)
    );
  }
  return out;
}

/** completedAt desc, null in coda; tie-break companyName asc. */
export function sortResults(rows: ShadowResultRow[]): ShadowResultRow[] {
  return [...rows].sort((a, b) => {
    if (a.completedAt && b.completedAt) {
      const d = b.completedAt.localeCompare(a.completedAt);
      if (d !== 0) return d;
    } else if (a.completedAt) return -1;
    else if (b.completedAt) return 1;
    return (a.companyName || "").localeCompare(b.companyName || "", "it");
  });
}
