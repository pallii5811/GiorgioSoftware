/**
 * Full sitemap discovery + frontier enqueue for product crawl path.
 * COMPLETE only when all sitemap resources are processed (or proven absent).
 */
import { createHash } from "node:crypto";
import { externalFetch } from "@/lib/http";
import type { SitemapStatus } from "@/lib/evidence/contract";
import {
  upsertFrontierNode,
  setCrawlRunFlags,
  getCrawlRun,
  type FrontierNodeState,
} from "@/lib/sanita/frontier-store";

export type SitemapTraceEntry = {
  url: string;
  kind: "robots" | "sitemap" | "sitemap_index" | "child" | "fallback";
  httpStatus: number | null;
  ok: boolean;
  contentHash: string | null;
  locCount: number;
  error?: string;
};

export type SitemapPipelineResult = {
  status: SitemapStatus;
  urlsEnqueued: number;
  robotsReferenced: boolean;
  traces: SitemapTraceEntry[];
  urlCapReached: boolean;
};

const FALLBACK_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/wp-sitemap.xml",
  "/sitemap-index.xml",
];

const MAX_SITEMAP_URLS = Number(process.env.SITEMAP_URL_CAP || 500);
const MAX_CHILD_SITEMAPS = Number(process.env.SITEMAP_CHILD_CAP || 40);

function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./i, "");
    const hb = new URL(b).hostname.replace(/^www\./i, "");
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch {
    return false;
  }
}

function resourceTypeFor(url: string): string {
  if (/\.pdf(?:$|\?|#)/i.test(url)) return "pdf";
  if (/\.xml(?:$|\?|#)/i.test(url)) return "sitemap";
  if (/\.json(?:$|\?|#)/i.test(url)) return "json";
  if (/\.(docx?|odt|rtf)(?:$|\?|#)/i.test(url)) return "document";
  return "html";
}

function relevanceFor(url: string): "critical" | "relevant" | "low" {
  const policyish =
    /trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|parm|pars|massimale|copertura|note-legali/i.test(
      url
    );
  if (/\.pdf/i.test(url)) return policyish ? "critical" : "low";
  if (policyish || /document/i.test(url)) return "critical";
  return "relevant";
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.trim());
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml) || (/<sitemap[\s>]/i.test(xml) && /<\/sitemap>/i.test(xml));
}

async function fetchText(
  url: string,
  timeoutMs = 12_000
): Promise<{ ok: boolean; status: number; text: string; hash: string | null; error?: string }> {
  try {
    const res = await externalFetch(url, { timeoutMs, redirect: "follow" });
    const text = await res.text();
    const hash = text
      ? createHash("sha256").update(text).digest("hex")
      : null;
    return { ok: res.ok, status: res.status, text, hash };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: "",
      hash: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function enqueueUrl(crawlRunId: string, url: string, website: string, source: string): boolean {
  if (!sameHost(url, website)) return false;
  try {
    const { created } = upsertFrontierNode({
      crawlRunId,
      canonicalUrl: url,
      parentUrl: null,
      discoverySource: source,
      resourceType: resourceTypeFor(url),
      relevance: relevanceFor(url),
      state: "DISCOVERED" as FrontierNodeState,
    });
    return created;
  } catch {
    return false;
  }
}

/**
 * Discover and enqueue first-party URLs from robots + sitemaps.
 * Does NOT fetch page bodies — only sitemap XML resources and enqueue locs.
 * Marks COMPLETE only when every discovered sitemap XML is successfully parsed.
 */
export async function discoverAndProcessSitemaps(
  crawlRunId: string,
  website: string,
  opts?: { urlCap?: number; timeBudgetMs?: number }
): Promise<SitemapPipelineResult> {
  const urlCap = opts?.urlCap ?? MAX_SITEMAP_URLS;
  const deadline = Date.now() + (opts?.timeBudgetMs ?? 60_000);
  const base = website.endsWith("/") ? website : `${website}/`;
  const traces: SitemapTraceEntry[] = [];
  let urlsEnqueued = 0;
  let robotsReferenced = false;
  let urlCapReached = false;
  let anyOk = false;
  let anyFail = false;
  let any404 = false;
  let attempted = 0;

  const sitemapQueue: Array<{ url: string; kind: SitemapTraceEntry["kind"]; fromRobots: boolean }> =
    [];
  const seenSitemap = new Set<string>();

  // 1–2. robots.txt
  const robotsUrl = new URL("/robots.txt", base).toString();
  const robots = await fetchText(robotsUrl, 8_000);
  traces.push({
    url: robotsUrl,
    kind: "robots",
    httpStatus: robots.status,
    ok: robots.ok,
    contentHash: robots.hash,
    locCount: 0,
    error: robots.error,
  });
  if (robots.ok && robots.text) {
    for (const m of robots.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
      const u = m[1]!.trim();
      if (!seenSitemap.has(u)) {
        seenSitemap.add(u);
        sitemapQueue.push({ url: u, kind: "sitemap", fromRobots: true });
        robotsReferenced = true;
      }
    }
  }

  // 3. fallbacks only if robots had no Sitemap lines
  if (sitemapQueue.length === 0) {
    for (const p of FALLBACK_PATHS) {
      const u = new URL(p, base).toString();
      if (!seenSitemap.has(u)) {
        seenSitemap.add(u);
        sitemapQueue.push({ url: u, kind: "fallback", fromRobots: false });
      }
    }
  }

  setCrawlRunFlags(crawlRunId, { sitemapStatus: "DISCOVERED_PARTIAL" });

  let childCount = 0;
  while (sitemapQueue.length > 0) {
    if (Date.now() >= deadline) {
      urlCapReached = true; // time budget — treat as cap for HOT block
      setCrawlRunFlags(crawlRunId, { timeCapReached: true });
      break;
    }
    if (urlsEnqueued >= urlCap) {
      urlCapReached = true;
      setCrawlRunFlags(crawlRunId, { urlCapReached: true });
      break;
    }

    const item = sitemapQueue.shift()!;
    attempted++;
    const fetched = await fetchText(item.url);
    const locs = fetched.ok ? extractLocs(fetched.text) : [];
    const kind =
      fetched.ok && isSitemapIndex(fetched.text)
        ? ("sitemap_index" as const)
        : item.kind === "fallback"
          ? "fallback"
          : item.kind === "child"
            ? "child"
            : "sitemap";

    traces.push({
      url: item.url,
      kind,
      httpStatus: fetched.status,
      ok: fetched.ok,
      contentHash: fetched.hash,
      locCount: locs.length,
      error: fetched.error,
    });

    if (fetched.status === 404) {
      any404 = true;
      continue;
    }
    if (!fetched.ok) {
      anyFail = true;
      continue;
    }
    anyOk = true;

    if (isSitemapIndex(fetched.text)) {
      for (const loc of locs) {
        if (childCount >= MAX_CHILD_SITEMAPS) {
          anyFail = true;
          break;
        }
        if (!sameHost(loc, website) && !/\.xml/i.test(loc)) continue;
        if (seenSitemap.has(loc)) continue;
        seenSitemap.add(loc);
        sitemapQueue.push({ url: loc, kind: "child", fromRobots: item.fromRobots });
        childCount++;
      }
      continue;
    }

    for (const loc of locs) {
      if (urlsEnqueued >= urlCap) {
        urlCapReached = true;
        setCrawlRunFlags(crawlRunId, { urlCapReached: true });
        break;
      }
      if (/\.xml(?:$|\?)/i.test(loc) && sameHost(loc, website)) {
        if (!seenSitemap.has(loc) && childCount < MAX_CHILD_SITEMAPS) {
          seenSitemap.add(loc);
          sitemapQueue.push({ url: loc, kind: "child", fromRobots: item.fromRobots });
          childCount++;
        }
        continue;
      }
      if (enqueueUrl(crawlRunId, loc, website, robotsReferenced ? "robots-sitemap" : "sitemap")) {
        urlsEnqueued++;
      }
    }
  }

  let status: SitemapStatus;
  if (urlCapReached && anyOk) {
    // Cap: never COMPLETE
    status = robotsReferenced ? "ROBOTS_REFERENCED_FAILED" : "DISCOVERED_PARTIAL";
  } else if (anyOk && !anyFail && sitemapQueue.length === 0) {
    status = robotsReferenced ? "ROBOTS_REFERENCED_COMPLETE" : "DISCOVERED_COMPLETE";
  } else if (anyOk && anyFail) {
    status = robotsReferenced ? "ROBOTS_REFERENCED_FAILED" : "DISCOVERED_FAILED";
  } else if (!anyOk && any404 && attempted > 0 && !robotsReferenced) {
    status = "NOT_PRESENT";
  } else if (!anyOk && anyFail) {
    status = robotsReferenced ? "ROBOTS_REFERENCED_FAILED" : "DISCOVERED_FAILED";
  } else if (!anyOk && robotsReferenced) {
    status = "ROBOTS_REFERENCED_FAILED";
  } else {
    status = "NOT_DISCOVERED";
  }

  // If robots had no sitemaps and all fallbacks 404 → NOT_PRESENT
  if (
    !robotsReferenced &&
    !anyOk &&
    traces.filter((t) => t.kind === "fallback" || t.kind === "sitemap").every((t) => t.httpStatus === 404)
  ) {
    status = "NOT_PRESENT";
  }

  setCrawlRunFlags(crawlRunId, {
    sitemapStatus: status,
    ...(urlCapReached ? { urlCapReached: true } : {}),
  });

  void getCrawlRun(crawlRunId);
  return { status, urlsEnqueued, robotsReferenced, traces, urlCapReached };
}
