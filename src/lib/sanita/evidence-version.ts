/**
 * Versioning evidenze/verdetti — record legacy non entrano nella coda commerciale.
 */
export const CURRENT_EVIDENCE_VERSION = 2;
export const CURRENT_VERDICT_VERSION = 2;

export type LegacyVerificationStatus = "CURRENT" | "LEGACY_UNVERIFIED" | "RESCAN_REQUIRED";

export interface VersionMarkers {
  evidenceVersion: number;
  verdictVersion: number;
  legacyVerificationStatus: LegacyVerificationStatus;
}

const MARKER_RE =
  /\[EV_V:(\d+)\s+VD_V:(\d+)\s+LEGACY:(CURRENT|LEGACY_UNVERIFIED|RESCAN_REQUIRED)\]/i;

export function parseVersionMarkers(evidence: string | null | undefined): VersionMarkers | null {
  if (!evidence) return null;
  const m = evidence.match(MARKER_RE);
  if (!m) return null;
  return {
    evidenceVersion: Number(m[1]),
    verdictVersion: Number(m[2]),
    legacyVerificationStatus: m[3].toUpperCase() as LegacyVerificationStatus,
  };
}

export function formatVersionMarker(markers: VersionMarkers): string {
  return `[EV_V:${markers.evidenceVersion} VD_V:${markers.verdictVersion} LEGACY:${markers.legacyVerificationStatus}]`;
}

export function appendVersionMarker(evidenceBody: string, markers: VersionMarkers): string {
  const cleaned = evidenceBody.replace(MARKER_RE, "").trim();
  return `${cleaned} ${formatVersionMarker(markers)}`.trim();
}

export function isLegacyLead(evidence: string | null | undefined): boolean {
  const m = parseVersionMarkers(evidence);
  if (!m) return true;
  if (m.evidenceVersion < CURRENT_EVIDENCE_VERSION) return true;
  if (m.verdictVersion < CURRENT_VERDICT_VERSION) return true;
  if (m.legacyVerificationStatus !== "CURRENT") return true;
  if (!/\[CRAWL_COMPLETE:(true|false)\]/i.test(evidence || "") && !/completeness\.complete/i.test(evidence || "")) {
    // Senza marker completeness esplicito o EVIDENCE_JSON → legacy se pre-v2
    if (m.evidenceVersion < CURRENT_EVIDENCE_VERSION) return true;
  }
  return false;
}

/** Record actionable solo se versione corrente e non quarantine. */
export function isActionableEvidence(evidence: string | null | undefined): boolean {
  const m = parseVersionMarkers(evidence);
  if (!m) return false;
  if (m.legacyVerificationStatus !== "CURRENT") return false;
  if (m.evidenceVersion < CURRENT_EVIDENCE_VERSION) return false;
  if (m.verdictVersion < CURRENT_VERDICT_VERSION) return false;
  return true;
}

export function currentMarkers(status: LegacyVerificationStatus = "CURRENT"): VersionMarkers {
  return {
    evidenceVersion: CURRENT_EVIDENCE_VERSION,
    verdictVersion: CURRENT_VERDICT_VERSION,
    legacyVerificationStatus: status,
  };
}
