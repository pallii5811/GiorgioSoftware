/**
 * Source classification — discovery ≠ prova terminale.
 */
export type SourceClass =
  | "FIRST_PARTY_FACILITY"
  | "FIRST_PARTY_GROUP"
  | "PUBLIC_INSTITUTION"
  | "OFFICIAL_PROCUREMENT"
  | "SEARCH_DISCOVERY"
  | "COMMERCIAL_ARTICLE"
  | "BLOG"
  | "DIRECTORY"
  | "BROKER_SITE"
  | "UNKNOWN";

const INSTITUTIONAL_HOST =
  /\.(gov|edu)\.[a-z]{2,}$|aslnapoli|aslnapo|aulss|ulss|regione\.(campania|veneto)|salute\.gov|ministerosalute|open-contracting|anac\.gov|bdncp/i;

const BLOG_HOST = /blog|wordpress|medium\.com|substack|blogspot/i;
const DIR_HOST = /paginegialle|paginebianche|yelp|cylex|misterimprese|tripadvisor|paginemediche/i;
const BROKER_HOST = /broker|assicur|compar|facile\.it|segugio|prima\.it/i;
const SEARCH_HOST = /tavily|google\.|bing\.|duckduckgo|yahoo\./i;
const ARTICLE_HOST = /corriere|repubblica|ilsole|ansa\.|quotidianosanita|aboutpharma/i;

export function classifySourceUrl(url: string | null | undefined): SourceClass {
  if (!url) return "UNKNOWN";
  let host = "";
  try {
    host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./i, "");
  } catch {
    return "UNKNOWN";
  }
  if (SEARCH_HOST.test(host) || SEARCH_HOST.test(url)) return "SEARCH_DISCOVERY";
  if (BLOG_HOST.test(host)) return "BLOG";
  if (DIR_HOST.test(host)) return "DIRECTORY";
  if (BROKER_HOST.test(host)) return "BROKER_SITE";
  if (ARTICLE_HOST.test(host)) return "COMMERCIAL_ARTICLE";
  if (INSTITUTIONAL_HOST.test(host)) return "PUBLIC_INSTITUTION";
  if (/anac|bdncp|soresa|appalti/i.test(host)) return "OFFICIAL_PROCUREMENT";
  return "UNKNOWN";
}

/** Host del sito struttura → first-party se stesso registrable domain. */
export function classifyFetchedAgainstFacility(opts: {
  pageUrl: string;
  facilityWebsite: string | null | undefined;
  groupWebsite?: string | null;
}): SourceClass {
  const page = classifySourceUrl(opts.pageUrl);
  if (
    page === "BLOG" ||
    page === "DIRECTORY" ||
    page === "BROKER_SITE" ||
    page === "SEARCH_DISCOVERY" ||
    page === "COMMERCIAL_ARTICLE"
  ) {
    return page;
  }
  const pageHost = hostOf(opts.pageUrl);
  const facHost = hostOf(opts.facilityWebsite);
  const groupHost = hostOf(opts.groupWebsite);
  if (facHost && pageHost && sameRegistrable(pageHost, facHost)) return "FIRST_PARTY_FACILITY";
  if (groupHost && pageHost && sameRegistrable(pageHost, groupHost)) return "FIRST_PARTY_GROUP";
  if (page === "PUBLIC_INSTITUTION") return "PUBLIC_INSTITUTION";
  return page === "UNKNOWN" ? "UNKNOWN" : page;
}

export function sourceAllowsPublished(source: SourceClass): boolean {
  return (
    source === "FIRST_PARTY_FACILITY" ||
    source === "FIRST_PARTY_GROUP" ||
    source === "PUBLIC_INSTITUTION"
  );
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function sameRegistrable(a: string, b: string): boolean {
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  return na === nb || na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`);
}
