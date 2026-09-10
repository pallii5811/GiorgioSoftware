const POLICY_DOCUMENT_HINT =
  /polizz|assicuraz|rct|rco|responsabilit[aà]\s*civile|copertura|rinnovo/i;

function decodedUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function yearsIn(value: string): number[] {
  return [...value.matchAll(/(?:19|20)\d{2}/g)]
    .map((match) => Number(match[0]))
    .filter((year) => year >= 1990 && year <= 2099);
}

/** Prefer the year in the filename; fall back to an upload-directory year. */
export function policyDocumentYear(url: string): number | null {
  const decoded = decodedUrl(url);
  let pathname = decoded;
  try {
    pathname = new URL(decoded).pathname;
  } catch {
    /* relative URL */
  }
  const basename = pathname.split("/").filter(Boolean).at(-1) || pathname;
  const filenameYears = yearsIn(basename);
  if (filenameYears.length > 0) return Math.max(...filenameYears);
  const pathYears = yearsIn(pathname);
  return pathYears.length > 0 ? Math.max(...pathYears) : null;
}

export function isExplicitPolicyDocumentUrl(
  url: string,
  resourceType?: string | null
): boolean {
  const decoded = decodedUrl(url).toLowerCase();
  const isDocument =
    /^(?:pdf|document|office)$/i.test(resourceType || "") ||
    /\.(?:pdf|docx?|odt)(?:$|[?#])/i.test(decoded);
  return isDocument && POLICY_DOCUMENT_HINT.test(decoded);
}

/** Newer versioned policy documents must be processed before older ones. */
export function comparePolicyDocumentRecency(
  a: { canonicalUrl: string; resourceType?: string | null },
  b: { canonicalUrl: string; resourceType?: string | null }
): number {
  const aPolicy = isExplicitPolicyDocumentUrl(a.canonicalUrl, a.resourceType);
  const bPolicy = isExplicitPolicyDocumentUrl(b.canonicalUrl, b.resourceType);
  if (aPolicy !== bPolicy) return aPolicy ? -1 : 1;
  if (!aPolicy) return 0;
  const aYear = policyDocumentYear(a.canonicalUrl) ?? -1;
  const bYear = policyDocumentYear(b.canonicalUrl) ?? -1;
  return bYear - aYear;
}

type FrontierPolicyNode = {
  canonicalUrl: string;
  resourceType?: string | null;
  state: string;
};

/**
 * Count unread policy documents that can supersede the selected source.
 * An unversioned policy document is conservatively treated as potentially newer.
 */
export function countPendingPotentiallyNewerPolicyDocuments(
  nodes: FrontierPolicyNode[],
  selectedPolicyUrl: string | null | undefined
): number {
  if (!selectedPolicyUrl) return 0;
  const selectedYear = policyDocumentYear(selectedPolicyUrl);
  return nodes.filter((node) => {
    if (node.state === "COMPLETED" || node.state === "EXCLUDED") return false;
    if (!isExplicitPolicyDocumentUrl(node.canonicalUrl, node.resourceType)) return false;
    const candidateYear = policyDocumentYear(node.canonicalUrl);
    if (selectedYear == null || candidateYear == null) return true;
    return candidateYear > selectedYear;
  }).length;
}

export function policyEvidenceRecency(
  canonicalUrl: string,
  policySignalsJson: string | null | undefined
): number {
  let expiry = Number.NEGATIVE_INFINITY;
  try {
    const signals = JSON.parse(policySignalsJson || "{}") as { expiry?: unknown };
    if (typeof signals.expiry === "string") {
      const parsed = Date.parse(signals.expiry);
      if (Number.isFinite(parsed)) expiry = parsed;
    }
  } catch {
    /* invalid legacy payload */
  }
  const urlYear = policyDocumentYear(canonicalUrl);
  const urlRank = urlYear == null ? Number.NEGATIVE_INFINITY : Date.UTC(urlYear, 11, 31);
  return Math.max(expiry, urlRank);
}
