import * as cheerio from "cheerio";

const POLICY_JSON_HINT =
  /polizz|assicurativ|massimale|unipolsai|generali|am\s*trust|responsabilit[aà]\s*civile|art\.?\s*10|legge\s+gelli|numero\s+(?:della\s+)?pratica|copertura\s+assicurativa/i;

const POLICY_JSON_KEY =
  /polizz|assicur|massimale|pratica|compagnia|insurer|rco|rct|gelli|scadenza|expiry/i;

/** Estrae stringhe testuali da un oggetto JSON (ricorsivo, max profondità). */
function stringsFromJson(
  value: unknown,
  depth = 0,
  out: string[] = [],
  key = ""
): string[] {
  if (depth > 12 || out.join(" ").length > 80_000) return out;
  if (typeof value === "string") {
    const s = value.replace(/\s+/g, " ").trim();
    if (s.length >= 4 && (POLICY_JSON_HINT.test(s) || POLICY_JSON_KEY.test(key))) {
      out.push(s);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) stringsFromJson(item, depth + 1, out, key);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      stringsFromJson(v, depth + 1, out, k);
    }
  }
  return out;
}

/** Testo policy-relevant da risposta JSON (API o file .json). */
export function extractJsonPolicyText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const data = JSON.parse(trimmed) as unknown;
    return stringsFromJson(data)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    if (POLICY_JSON_HINT.test(trimmed)) {
      return trimmed.replace(/\s+/g, " ").slice(0, 12_000);
    }
    return "";
  }
}

/** Testo da script embedded: Next.js, ld+json, CMS payload. */
export function extractEmbeddedScriptText(html: string): string {
  const $ = cheerio.load(html);
  const chunks: string[] = [];

  $("script").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const id = ($(el).attr("id") || "").toLowerCase();
    const raw = $(el).html()?.trim();
    if (!raw || raw.length < 12) return;

    if (
      id === "__next_data__" ||
      type === "application/ld+json" ||
      type === "application/json" ||
      /^text\/(?:x-)?json/.test(type)
    ) {
      const t = extractJsonPolicyText(raw);
      if (t) chunks.push(t);
      return;
    }

    // Payload RSC / hydration con testo polizza in chiaro nel bundle
    if (raw.length < 500_000 && POLICY_JSON_HINT.test(raw)) {
      const t = raw
        .replace(/\\n/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      if (POLICY_JSON_HINT.test(t)) chunks.push(t.slice(0, 12_000));
    }
  });

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

/** Body HTML visibile (no script). */
export function extractVisibleBodyText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

/** Corpus pagina = HTML visibile + JSON/script embedded. */
export function extractPageText(html: string): string {
  const body = extractVisibleBodyText(html);
  const embedded = extractEmbeddedScriptText(html);
  if (!embedded) return body;
  if (!body) return embedded;
  return `${body} ${embedded}`.replace(/\s+/g, " ").trim();
}

/** URL same-host che sembrano API JSON da provare dopo crawl HTML. */
export function discoverJsonApiUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const add = (href: string) => {
    try {
      const u = new URL(href, base);
      if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return;
      if (!/^https?:$/.test(u.protocol)) return;
      const p = u.pathname.toLowerCase();
      if (!/\/api\/|\.json(?:$|\?)|wp-json|graphql/i.test(p + u.search)) return;
      if (/polizz|assicur|trasparen|gelli|documenti|amministrazione/i.test(p + u.search)) {
        out.add(u.toString());
      }
    } catch {
      /* skip */
    }
  };

  $("a[href]").each((_, el) => add($(el).attr("href") || ""));
  return [...out].slice(0, 8);
}
