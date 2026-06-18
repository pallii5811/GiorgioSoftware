import { encodeEvidence, type Verdict } from "./verdict";
import type { CrawlResult } from "./crawler";
import { isGelliComplianceReportPdf } from "./detector";

function isPolicySourceUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    /amministrazione-trasparente|societa-trasparente|\/trasparen|\/polizz|\/assicuraz|responsabilit[aà]-civile|gestione[\-_]?del[\-_]?rischio|rischio[\-_]?clinico|art\.?\s*10|legge[\-_]?gelli/i.test(
      u
    )
  );
}

function isTransparencyUrl(url: string): boolean {
  return isPolicySourceUrl(url);
}

export interface AuditSources {
  osm?: boolean;
  minSalute?: boolean;
  sitePages?: string[];
  siteRelevant?: boolean;
  siteUnderMaintenance?: boolean;
  policyPdfUrl?: string | null;
  policySourceUrl?: string | null;
  policyPdfsQueued?: number;
  policyPdfsRead?: number;
  needsOcrReview?: boolean;
  regionalUrls?: string[];
  regionalQueries?: number;
  contactSearch?: boolean;
  contactUrls?: string[];
  crossCheckRegional?: boolean;
  mapsLookup?: boolean;
  mapsDiscovery?: boolean;
  googleSearch?: boolean;
  anac?: boolean;
  anacYear?: number;
  anacCig?: string;
}

/** PDF che ha certificato la polizza — da policyPdfUrl o da pagine visitate. */
export function pickPolicyPdfUrl(
  crawl: Pick<CrawlResult, "policyPdfUrl" | "pagesVisited">
): string | null {
  if (crawl.policyPdfUrl) return crawl.policyPdfUrl;
  const pdfs = (crawl.pagesVisited || []).filter((u) => /\.pdf(?:$|\?|#)/i.test(u));
  return (
    pdfs.find((u) => /polizz|parm|pars|assicuraz|rinnovo|_rc_|\/rc[-_]/i.test(u.toLowerCase())) ??
    pdfs[0] ??
    null
  );
}

/** Pagina HTML o PDF che ha certificato la polizza. */
export function pickPolicySourceUrl(crawl: Pick<CrawlResult, "policyPdfUrl" | "pagesVisited">): string | null {
  const pdf = pickPolicyPdfUrl(crawl);
  if (pdf) return pdf;
  return (
    (crawl.pagesVisited || []).find(
      (u) =>
        !/\.pdf(?:$|\?|#)/i.test(u) &&
        /trasparen|amministrazione|gelli|polizz|assicuraz|gestione[\-_]?del[\-_]?rischio|rischio[\-_]?clinico|note-legali/i.test(
          u
        )
    ) ?? null
  );
}

export function isParmOrGelliReportPdf(url: string): boolean {
  return isGelliComplianceReportPdf(url);
}

function buildDocsSection(sources: AuditSources): string | null {
  // PUBLISHED: allega il PDF (o PARM/PARS con RC art.10) che ha certificato la polizza.
  if (sources.policyPdfUrl) {
    return `[DOCS: ${sources.policyPdfUrl}]`;
  }
  return null;
}

/** PDF polizza da mostrare in UI — documento che ha certificato PUBLISHED. */
export function policyDocsForDisplay(docs: string[] | null): string[] {
  return (docs ?? [])
    .filter((u) => /\.pdf(?:$|\?|#)/i.test(u))
    .slice(0, 3);
}

/** URL PDF polizza per la UI — [DOCS:] oppure fallback dal testo evidenza. */
export function policyPdfUrlsForLead(evidence: string | null | undefined): string[] {
  const { docs, body } = parseEvidenceSections(evidence);
  const fromDocs = policyDocsForDisplay(docs);
  if (fromDocs.length) return fromDocs;
  const fromBody =
    body?.match(/certificata da PDF:\s*(https?:\/\/\S+)/i)?.[1] ??
    body?.match(/(https?:\/\/\S+\.pdf(?:\?[^\s]*)?)/i)?.[1];
  if (!fromBody || !/\.pdf/i.test(fromBody)) return [];
  return [fromBody.replace(/[.,;)\]]+$/, "")];
}

/** Traccia documentata delle fonti controllate (per report assicuratore). */
export function buildAuditTrail(sources: AuditSources): string {
  const parts: string[] = [];

  if (sources.anac) {
    parts.push(
      `dataset ANAC BDNCP/OCDS (data.open-contracting.org${sources.anacYear ? `, ${sources.anacYear}` : ""}${sources.anacCig ? `, CIG ${sources.anacCig}` : ""})`
    );
  }
  if (sources.osm) parts.push("anagrafica OpenStreetMap");
  if (sources.minSalute) parts.push("elenco Min. Salute (accreditate)");
  if (sources.sitePages?.length) {
    const n = sources.sitePages.length;
    const transUrlVisited = (sources.sitePages || []).some((u) => isTransparencyUrl(u));
    const sample = sources.sitePages
      .slice(0, 2)
      .map((u) => {
        try {
          return new URL(u).pathname || u;
        } catch {
          return u;
        }
      })
      .join(", ");
    parts.push(
      `sito web (${n} pag${n > 1 ? "ine" : "ina"}${
        sources.siteUnderMaintenance
          ? ", sito in manutenzione"
          : sources.siteRelevant && transUrlVisited
            ? ", sezione Trasparenza letta"
            : ""
      }: ${sample})`
    );
  }
  if (sources.policySourceUrl && !sources.policyPdfUrl) {
    parts.push(`fonte polizza HTML: ${sources.policySourceUrl}`);
  }
  if (typeof sources.policyPdfsQueued === "number" || typeof sources.policyPdfsRead === "number") {
    const q = Math.max(0, Number(sources.policyPdfsQueued ?? 0));
    const r = Math.max(0, Number(sources.policyPdfsRead ?? 0));
    parts.push(`PDF polizza letti ${r}/${q}`);
  }
  if (sources.needsOcrReview) {
    parts.push("OCR: alcuni PDF scannerizzati non decodificabili (verifica manuale consigliata)");
  }
  if (sources.regionalQueries) {
    const urls = (sources.regionalUrls || []).slice(0, 2).join("; ");
    parts.push(`portali regionali/ASL (${sources.regionalQueries} ricerche${urls ? `: ${urls}` : ""})`);
  }
  if (sources.crossCheckRegional) parts.push("incrocio portale regionale dopo crawl sito");
  if (sources.mapsDiscovery) parts.push("Google Maps (scoperta strutture)");
  if (sources.mapsLookup) parts.push("Google Maps (sito e telefono struttura)");
  if (sources.googleSearch) parts.push("ricerca Google sito ufficiale");
  if (sources.contactSearch) {
    const cu = (sources.contactUrls || []).slice(0, 1).join("");
    parts.push(`ricerca contatti Tavily${cu ? `: ${cu}` : ""}`);
  }

  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  const docs = buildDocsSection(sources);
  return [docs, `[FONTI: ${parts.join(" · ") || "nessuna"}] [Verifica: ${when}]`]
    .filter(Boolean)
    .join(" ");
}

export function packEvidence(verdict: Verdict, body: string | null, audit: AuditSources): string {
  const pdfFromBody = body?.match(/certificata da PDF:\s*(https?:\/\/\S+)/i)?.[1];
  const auditWithPdf: AuditSources = {
    ...audit,
    policyPdfUrl: audit.policyPdfUrl ?? pdfFromBody ?? null,
  };
  const trail = buildAuditTrail(auditWithPdf);
  const text = [body?.trim(), trail].filter(Boolean).join(" — ");
  return encodeEvidence(verdict, text);
}

/** Rimuove token verdetto e separa corpo da trail fonti. */
export function parseEvidenceSections(evidence: string | null | undefined): {
  body: string | null;
  fonti: string | null;
  docs: string[] | null;
} {
  if (!evidence) return { body: null, fonti: null, docs: null };
  let s = evidence.replace(/^\[V:(PUB|HOT|REV)\]\s*/i, "").trim();
  const docsMatches = [...s.matchAll(/\[DOCS:\s*([^\]]+)\]/gi)];
  const docsRaw = docsMatches.length ? docsMatches[docsMatches.length - 1]![0] : null;
  const docs =
    docsRaw
      ? docsRaw
          .replace(/^\[DOCS:\s*/i, "")
          .replace(/\]$/, "")
          .split(/\s*;\s*/g)
          .map((v) => v.trim())
          .filter(Boolean)
      : null;
  if (docsRaw) s = s.replace(docsRaw, "").replace(/\s*—\s*$/, "").trim();

  const fontiMatch = s.match(/\[FONTI:[^\]]+\]\s*\[Verifica:[^\]]+\]/);
  const fonti = fontiMatch ? fontiMatch[0] : null;
  if (fonti) s = s.replace(fonti, "").replace(/\s*—\s*$/, "").trim();
  return { body: s || null, fonti, docs };
}
