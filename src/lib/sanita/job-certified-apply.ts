import fs from "node:fs";
import path from "node:path";
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  validateCertifiedApplyRow,
  type CertifiedApplyRow,
} from "@/lib/sanita/apply-certified-terminal";
import { readProcessingState, readBusinessVerdict } from "@/lib/sanita/processing-state";
import { readVerdictToken } from "@/lib/sanita/verdict";
import { getSanitaJobNamespace } from "@/lib/sanita/jobs";

export function buildCertifiedApplyRowFromLead(
  lead: Lead,
  opts: { runId: string; jobId: string }
): CertifiedApplyRow {
  const evidence = lead.evidence || "";
  const processingState = readProcessingState(evidence);
  return {
    id: lead.id,
    processingState,
    newVerdict: readVerdictToken(evidence),
    fullEvidence: evidence,
    website: lead.website,
    websiteReachable: lead.websiteReachable,
    pagesVisited: lead.pagesVisited,
    category: lead.category,
    crawlComplete: /\[CRAWL_COMPLETE:true\]/i.test(evidence),
    policyExhaustive: lead.policyFound === true,
    runIds: [opts.runId],
    frontierPaths: process.env.FRONTIER_DB_PATH ? [process.env.FRONTIER_DB_PATH] : null,
    requirePersistedCompleteness: processingState === "HOT_VERIFIED",
  };
}

export type JobCertifiedApplyResult =
  | { ok: true; applied: true; processingState: string | null; auditPath: string }
  | { ok: true; applied: false; reason: string }
  | { ok: false; error: string; reasons?: string[] };

/**
 * Valida e applica (in-place, CRM preservato) un risultato certificato prodotto dal job runner.
 */
export async function applyCertifiedFromJobLead(
  leadId: string,
  jobId: string
): Promise<JobCertifiedApplyResult> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead non trovato" };

  const row = buildCertifiedApplyRowFromLead(lead, { runId: jobId, jobId });
  const gate = validateCertifiedApplyRow(row);
  if (!gate.ok) {
    return {
      ok: true,
      applied: false,
      reason: gate.error,
    };
  }

  const crmStatus = lead.status;
  const crmNotes = lead.notes;
  const evidence = row.fullEvidence || lead.evidence || "";

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        evidence,
        website: lead.website,
        websiteReachable: lead.websiteReachable,
        policyFound: lead.policyFound,
        policyCompany: lead.policyCompany,
        policyNumber: lead.policyNumber,
        policyExpiry: lead.policyExpiry,
        policyMassimale: lead.policyMassimale,
        phone: lead.phone,
        email: lead.email,
        pec: lead.pec,
        piva: lead.piva,
        leadScore: lead.leadScore,
        pagesVisited: lead.pagesVisited,
        lastScannedAt: lead.lastScannedAt ?? new Date(),
        status: crmStatus,
        notes: crmNotes,
      },
    });
    const after = await tx.lead.findUnique({ where: { id: leadId } });
    if (!after) throw new Error("Lead mancante dopo apply");
    if (after.status !== crmStatus || after.notes !== crmNotes) {
      throw new Error("CRM_MISMATCH");
    }
    if (after.evidence !== evidence) throw new Error("EVIDENCE_MISMATCH");
  });

  const ns = path.join(process.cwd(), getSanitaJobNamespace(jobId));
  fs.mkdirSync(ns, { recursive: true });
  const auditPath = path.join(ns, `certified-apply-${leadId}.json`);
  const audit = {
    jobId,
    leadId,
    appliedAt: new Date().toISOString(),
    processingState: row.processingState,
    businessVerdict: readBusinessVerdict(evidence),
    crmPreserved: { status: crmStatus, notes: crmNotes },
  };
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));

  return {
    ok: true,
    applied: true,
    processingState: row.processingState ?? null,
    auditPath,
  };
}
