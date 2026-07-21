/**
 * Badge audit UI — record non in coda commerciale certificata.
 */
import { isLegacyLead } from "@/lib/sanita/evidence-version";
import {
  readBusinessVerdict,
  readProcessingState,
  type SanitaProcessingState,
} from "@/lib/sanita/processing-state";

export type AuditQueueBadge =
  | "LEGACY"
  | "IN_REVALIDATION"
  | "RETRY"
  | "REVIEW_IDENTITY"
  | "TECHNICAL"
  | null;

export function auditQueueBadge(lead: {
  evidence?: string | null;
  actionable?: boolean;
  _actionable?: boolean;
  semantic?: { actionable?: boolean; processingState?: string | null } | null;
}): AuditQueueBadge {
  const actionable = lead.semantic?.actionable ?? lead._actionable ?? lead.actionable;
  if (actionable) return null;

  const psRaw = lead.semantic?.processingState ?? readProcessingState(lead.evidence) ?? null;
  const ps = (psRaw ? String(psRaw).toUpperCase() : null) as SanitaProcessingState | null;
  const bv = readBusinessVerdict(lead.evidence);

  if (ps === "TECHNICAL_BLOCKED") return "TECHNICAL";
  if (ps === "RETRY_PENDING") return "RETRY";
  if (ps === "REVIEW_HUMAN" || bv === "REVIEW_HUMAN") return "REVIEW_IDENTITY";
  if (isLegacyLead(lead.evidence)) return "LEGACY";
  if (ps === "HOT_VERIFIED" || (ps && String(ps).startsWith("PUBLISHED"))) {
    // certificato ma non actionable (fail-closed evidence) → rivalidazione
    return "IN_REVALIDATION";
  }
  return "IN_REVALIDATION";
}

export const AUDIT_BADGE_UI: Record<
  Exclude<AuditQueueBadge, null>,
  { label: string; cls: string }
> = {
  LEGACY: {
    label: "LEGACY — NON CERTIFICATO",
    cls: "bg-slate-100 text-slate-800 border-slate-300",
  },
  IN_REVALIDATION: {
    label: "IN RIVALIDAZIONE",
    cls: "bg-indigo-50 text-indigo-800 border-indigo-200",
  },
  RETRY: {
    label: "RETRY TECNICO",
    cls: "bg-sky-50 text-sky-800 border-sky-200",
  },
  REVIEW_IDENTITY: {
    label: "REVIEW IDENTITÀ",
    cls: "bg-amber-50 text-amber-900 border-amber-300",
  },
  TECHNICAL: {
    label: "BLOCCO TECNICO",
    cls: "bg-rose-50 text-rose-800 border-rose-200",
  },
};
