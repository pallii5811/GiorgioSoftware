import type { Lead } from "@prisma/client";

/** Lead pronto per il client React (date ISO). */
export function serializeLeadForClient(lead: Lead) {
  return {
    ...lead,
    policyExpiry: lead.policyExpiry?.toISOString() ?? null,
    lastScannedAt: lead.lastScannedAt?.toISOString() ?? null,
    reminderAt: lead.reminderAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}
