import { encodeEvidence, type Verdict } from "./verdict";

export interface AuditSources {
  osm?: boolean;
  minSalute?: boolean;
  sitePages?: string[];
  siteRelevant?: boolean;
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
      `sito web (${n} pag${n > 1 ? "ine" : "ina"}${sources.siteRelevant ? ", sezione Trasparenza letta" : ""}: ${sample})`
    );
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
  return `[FONTI: ${parts.join(" · ") || "nessuna"}] [Verifica: ${when}]`;
}

export function packEvidence(verdict: Verdict, body: string | null, audit: AuditSources): string {
  const trail = buildAuditTrail(audit);
  const text = [body?.trim(), trail].filter(Boolean).join(" — ");
  return encodeEvidence(verdict, text);
}

/** Rimuove token verdetto e separa corpo da trail fonti. */
export function parseEvidenceSections(evidence: string | null | undefined): {
  body: string | null;
  fonti: string | null;
} {
  if (!evidence) return { body: null, fonti: null };
  let s = evidence.replace(/^\[V:(PUB|HOT|REV)\]\s*/i, "").trim();
  const fontiMatch = s.match(/\[FONTI:[^\]]+\]\s*\[Verifica:[^\]]+\]/);
  const fonti = fontiMatch ? fontiMatch[0] : null;
  if (fonti) s = s.replace(fonti, "").replace(/\s*—\s*$/, "").trim();
  return { body: s || null, fonti };
}
