import { prisma } from "@/lib/prisma";
import { runPublishedFastPath } from "@/lib/sanita/published-fast-path";
import { stampProcessingMeta } from "@/lib/sanita/processing-state";
import { appendVersionMarker, currentMarkers } from "@/lib/sanita/evidence-version";
import { encodeEvidence } from "@/lib/sanita/verdict";
import { acceptCanonicalPublishedTerminal } from "@/lib/sanita/canonical-published-terminal";
import type { Lead } from "@prisma/client";

function firstPartyIdentity(evidence: string | null, website: string | null): "OFFICIAL_CONFIRMED" | "INSUFFICIENT" {
  try {
    const docs = (evidence?.match(/\[DOCS:\s*([^\]]+)\]/i)?.[1] || "")
      .split(/[\s,;]+/)
      .filter((u) => /^https?:\/\//i.test(u));
    const wh = website ? new URL(website).hostname.replace(/^www\./i, "") : null;
    for (const raw of docs) {
      const dh = new URL(raw.trim()).hostname.replace(/^www\./i, "");
      if (wh && (dh === wh || dh.endsWith(`.${wh}`) || wh.endsWith(`.${dh}`))) {
        return "OFFICIAL_CONFIRMED";
      }
    }
  } catch {
    /* fail closed */
  }
  return "INSUFFICIENT";
}

export type PublishedPriorityJobResult =
  | { handled: false }
  | {
      handled: true;
      certified: boolean;
      processingState: string;
      policyFound: boolean;
    };

/** Ponytail: published-priority path for UI single jobs with forceRescan + historical DOCS. */
export async function runPublishedPriorityForJob(lead: Lead): Promise<PublishedPriorityJobResult> {
  const oldEvidence = lead.evidence || "";
  if (!/\[DOCS:/i.test(oldEvidence)) return { handled: false };

  const fp = await runPublishedFastPath({
    leadId: lead.id,
    companyName: lead.companyName,
    website: lead.website,
    category: lead.category,
    evidence: oldEvidence,
    policyCompany: lead.policyCompany,
    policyNumber: lead.policyNumber,
    policyExpiry: lead.policyExpiry ? new Date(lead.policyExpiry).getTime() : null,
    identityStatus: firstPartyIdentity(oldEvidence, lead.website),
    city: lead.city,
    phone: lead.phone,
    piva: lead.piva,
  });

  let finalState = fp.processingState || "RETRY_PENDING";
  let businessVerdict = fp.businessVerdict;
  let validationStatus = fp.validationStatus;
  let fullEvidence = oldEvidence;
  let policyFound = false;
  let policyCompany = lead.policyCompany;
  let policyNumber = lead.policyNumber;
  let policyExpiry = lead.policyExpiry;
  let policyMassimale = lead.policyMassimale;

  if (fp.publishedOk && fp.contentAcquired && businessVerdict) {
    const canon = acceptCanonicalPublishedTerminal({
      token: "PUBLISHED",
      businessVerdict,
      processingState: finalState,
      policyFound: Boolean(fp.analysis?.policyFound || fp.analysis?.company || fp.analysis?.policyNumber),
      policyExpiry: fp.analysis?.expiry ?? null,
      evidence: fp.excerpt || "",
      workerError: null,
      runAt: new Date(),
    });
    if (canon.ok) {
      finalState = canon.processingState;
      const quote = (fp.excerpt || "").slice(0, 500).replace(/\s+/g, " ");
      const docsLine = fp.exactUrl ? `[DOCS: ${fp.exactUrl}]` : "";
      const hashLine = fp.contentHash ? `[CONTENT_HASH:${fp.contentHash}]` : "";
      let body = [
        `Rivalidazione job UI — prova first-party acquisita.`,
        docsLine,
        hashLine,
        quote ? `[QUOTE: ${quote}]` : "",
        fp.ocrUsed ? "[OCR:true]" : "[OCR:false]",
        "[CRAWL_COMPLETE:true]",
        `[FAST_PATH:job-published-priority][REASONS:${(fp.reasons || []).join(",")}]`,
      ]
        .filter(Boolean)
        .join(" ");
      body = stampProcessingMeta(body, {
        state: finalState,
        businessVerdict,
        validationStatus: "CURRENT_VERIFIED",
      });
      fullEvidence = appendVersionMarker(encodeEvidence("PUBLISHED", body), currentMarkers("CURRENT"));
      validationStatus = "CURRENT_VERIFIED";
      policyFound = true;
      if (fp.analysis?.company) policyCompany = fp.analysis.company;
      if (fp.analysis?.policyNumber) policyNumber = fp.analysis.policyNumber;
      if (fp.analysis?.expiry) policyExpiry = new Date(fp.analysis.expiry);
      if (fp.analysis?.massimale) policyMassimale = String(fp.analysis.massimale);
    } else {
      finalState = "RETRY_PENDING";
      fullEvidence = stampProcessingMeta(
        `${oldEvidence}\n[FAST_PATH:job-published-priority][REJECT:${(canon.reasons || []).join("|")}]`,
        { state: finalState, validationStatus: "REVALIDATION_PENDING" }
      );
    }
  } else {
    return { handled: false };
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      evidence: fullEvidence,
      policyFound,
      policyCompany,
      policyNumber,
      policyExpiry,
      policyMassimale,
      lastScannedAt: new Date(),
      status: lead.status,
      notes: lead.notes,
    },
  });

  const certified =
    finalState === "PUBLISHED_CURRENT" ||
    finalState === "PUBLISHED_EXPIRED" ||
    finalState === "PUBLISHED_DATE_UNKNOWN";

  return {
    handled: true,
    certified,
    processingState: finalState,
    policyFound,
  };
}
