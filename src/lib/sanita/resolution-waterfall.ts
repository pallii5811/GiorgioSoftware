/**
 * Resolution waterfall — produce evidence tecnica, MAI verdette HOT/PUBLISHED.
 */
export type WaterfallStepId =
  | "http_fetch"
  | "retry_backoff"
  | "http_https_variant"
  | "www_variant"
  | "redirect_chain"
  | "robots_txt"
  | "sitemap_xml"
  | "sitemap_index"
  | "headless_browser"
  | "js_render"
  | "json_same_host"
  | "scripts_routes"
  | "first_party_search"
  | "group_domain"
  | "institutional_domain_resolve"
  | "pdf_fetch"
  | "pdf_native_text"
  | "pdf_ocr"
  | "pdf_refetch_truncated"
  | "pdf_mime_hash"
  | "pdf_attribution";

export type WaterfallStepResult = {
  step: WaterfallStepId;
  attempted: boolean;
  success: boolean;
  error: string | null;
  durationMs: number;
  evidenceAdded: string[];
  nextStep: WaterfallStepId | null;
};

export type WaterfallOutcome = {
  steps: WaterfallStepResult[];
  technicalStatus:
    | "RESOLVED_CANDIDATE"
    | "PARTIAL"
    | "UNREACHABLE"
    | "EXHAUSTED_STILL_UNCLEAR";
  /** Mai HOT/PUBLISHED — solo stato tecnico. */
  terminalVerdictEmitted: false;
};

const ORDER: WaterfallStepId[] = [
  "http_fetch",
  "retry_backoff",
  "http_https_variant",
  "www_variant",
  "redirect_chain",
  "robots_txt",
  "sitemap_xml",
  "sitemap_index",
  "headless_browser",
  "js_render",
  "json_same_host",
  "scripts_routes",
  "first_party_search",
  "group_domain",
  "institutional_domain_resolve",
];

const DOC_ORDER: WaterfallStepId[] = [
  "pdf_fetch",
  "pdf_native_text",
  "pdf_ocr",
  "pdf_refetch_truncated",
  "pdf_mime_hash",
  "pdf_attribution",
];

export type WaterfallProbe = (step: WaterfallStepId) => Promise<{
  success: boolean;
  error?: string | null;
  evidenceAdded?: string[];
}>;

/**
 * Esegue la waterfall con probe iniettabili (testabili).
 * Non assegna HOT/PUBLISHED.
 */
export async function runResolutionWaterfall(opts: {
  probe: WaterfallProbe;
  includeDocumentSteps?: boolean;
  stopOnFirstSuccess?: boolean;
}): Promise<WaterfallOutcome> {
  const steps: WaterfallStepResult[] = [];
  const seq = opts.includeDocumentSteps ? [...ORDER, ...DOC_ORDER] : ORDER;
  let anySuccess = false;
  let lastOk = false;

  for (let i = 0; i < seq.length; i++) {
    const step = seq[i]!;
    const nextStep = seq[i + 1] ?? null;
    const t0 = Date.now();
    let attempted = true;
    let success = false;
    let error: string | null = null;
    let evidenceAdded: string[] = [];
    try {
      const r = await opts.probe(step);
      success = Boolean(r.success);
      error = r.error ?? null;
      evidenceAdded = r.evidenceAdded ?? [];
    } catch (e) {
      success = false;
      error = e instanceof Error ? e.message : String(e);
    }
    const durationMs = Date.now() - t0;
    steps.push({
      step,
      attempted,
      success,
      error,
      durationMs,
      evidenceAdded,
      nextStep,
    });
    if (success) {
      anySuccess = true;
      lastOk = true;
      if (opts.stopOnFirstSuccess) break;
    } else {
      lastOk = false;
    }
  }

  let technicalStatus: WaterfallOutcome["technicalStatus"] = "EXHAUSTED_STILL_UNCLEAR";
  if (anySuccess && lastOk) technicalStatus = "RESOLVED_CANDIDATE";
  else if (anySuccess) technicalStatus = "PARTIAL";
  else if (steps.every((s) => s.error && /unreachable|ENOTFOUND|timeout|403|429/i.test(s.error))) {
    technicalStatus = "UNREACHABLE";
  }

  return { steps, technicalStatus, terminalVerdictEmitted: false };
}

export function waterfallStepOrder(): WaterfallStepId[] {
  return [...ORDER];
}
