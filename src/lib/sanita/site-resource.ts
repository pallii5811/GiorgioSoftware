import * as cheerio from "cheerio";

export type SiteResourceType =
  | "html"
  | "pdf"
  | "office"
  | "json"
  | "script"
  | "style"
  | "image"
  | "xml"
  | "text"
  | "other";

export type DiscoveredSiteResource = {
  url: string;
  resourceType: SiteResourceType;
  discoverySource: string;
};

const OFFICE_RE = /\.(?:docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)(?:$|[?#])/i;
const IMAGE_RE = /\.(?:png|jpe?g|webp|tiff?|bmp|gif|ico)(?:$|[?#])/i;
const SCRIPT_RE = /\.(?:m?js)(?:$|[?#])/i;
const STYLE_RE = /\.css(?:$|[?#])/i;
const JSON_RE = /\.json(?:$|[?#])/i;
const XML_RE = /\.(?:xml|svg)(?:$|[?#])/i;
const TEXT_RE = /\.(?:txt|md)(?:$|[?#])/i;
const PDF_RE = /\.pdf(?:$|[?#])/i;
const NON_DOCUMENT_MEDIA_RE =
  /\.(?:woff2?|ttf|eot|cur|mp4|m4v|mov|avi|webm|mp3|m4a|wav|ogg|map|exe|msi|dll|dmg|apk)(?:$|[?#])/i;

export function resourceTypeForUrl(url: string): SiteResourceType {
  if (PDF_RE.test(url)) return "pdf";
  if (OFFICE_RE.test(url)) return "office";
  if (IMAGE_RE.test(url)) return "image";
  if (SCRIPT_RE.test(url)) return "script";
  if (STYLE_RE.test(url)) return "style";
  if (JSON_RE.test(url) || /\/api(?:\/|$)/i.test(url)) return "json";
  if (XML_RE.test(url)) return "xml";
  if (TEXT_RE.test(url)) return "text";
  if (NON_DOCUMENT_MEDIA_RE.test(url)) return "other";
  return "html";
}

export function resourceTypeForContentType(
  url: string,
  contentType: string | null | undefined
): SiteResourceType {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("application/pdf")) return "pdf";
  if (
    ct.includes("officedocument") ||
    ct.includes("msword") ||
    ct.includes("ms-excel") ||
    ct.includes("ms-powerpoint") ||
    ct.includes("opendocument") ||
    ct.includes("application/rtf") ||
    ct.includes("text/rtf") ||
    ct.includes("text/csv")
  ) {
    return "office";
  }
  if (ct.startsWith("image/") && !ct.includes("svg")) return "image";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "script";
  if (ct.includes("text/css")) return "style";
  if (ct.includes("json")) return "json";
  if (ct.includes("xml") || ct.includes("svg")) return "xml";
  if (ct.startsWith("text/plain") || ct.includes("markdown")) return "text";
  if (ct.includes("html") || ct.includes("xhtml")) return "html";
  if (
    ct.startsWith("font/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    ct.includes("font-woff") ||
    ct.includes("octet-stream") && NON_DOCUMENT_MEDIA_RE.test(url)
  ) {
    return "other";
  }
  return resourceTypeForUrl(url);
}

export function isDocumentResourceType(type: string): boolean {
  return type === "pdf" || type === "office" || type === "image";
}

/**
 * Images whose URL explicitly identifies them as site chrome rather than a
 * published document. They are still downloaded and OCR'd once; this only
 * lets a low-confidence, non-insurance OCR result close without a retry loop.
 */
export function isClearlyDecorativeImageUrl(url: string): boolean {
  let filename = "";
  let pathname = "";
  try {
    pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    filename = pathname.split("/").pop() || "";
  } catch {
    pathname = url.toLowerCase();
    filename = pathname;
  }
  if (
    /polizz|assicur|copertura|contratto|certificat|quietanza|rct|rco|gelli/i.test(
      pathname
    )
  ) {
    return false;
  }
  return (
    /(?:^|[-_.])(?:favicon|favico|logo(?:@\d+x)?|icon(?:a|aios)?\d*|icons?\d+|ico\d*|sprite|avatar|badge|bollin[io]|flags?(?:@\d+x)?|globe(?:@\d+x)?|header|hero|banner|slider\d*|gallery|partner|sponsor|orologio|clock|telefono|phone|mail|orari|referti[-_]?online|paga[-_]?con[-_]?pos|ci[-_]?siamo|chi[-_]?siamo|dove[-_]?siamo|ingresso|esterno|facciata|sede|centro[-_]?di|foto(?:[-_][a-z0-9]+)*|doctor(?:[-_]\d+)?|team[-_]?\d+|about[-_]?img\d*|procedures?[-_]?img\d*|projects?[-_]?\d+|bemind[-_]?(?:services?|img)[-_]?\d*|h\d+[-_]?(?:slider|curve|image)\d*|top[-_]?fancy\d*|minimap|pagamenti?|feature[-_]?foto\d*|copertina(?:[-_][a-z0-9]+)*|footer[-_]?bg|bg(?:[-_](?:mobile|desktop|tablet|header|footer))?|background|placeholder|ajax[-_]?loader(?:@\d+x)?|loader|spinner|dummy|arrow[-_]?(?:left|right)?(?:[-_]?light)?|service[-_]?curves?|section[-_]?curve|dot[-_]?overlay|text[-_]?shape|world[-_]?map|signature|ptt[-_]?(?:default|appointment|service)|bullet|calendar|checkbox(?:[-_]?\d+)?|success|square[-_]?\d+|redo[-_]?\d+|exclamation[-_]?\d+|info[-_]?\d+|edit[-_]?\d+|plus[-_]?\d+|gridtile(?:[-_]?\d+x\d+)?(?:[-_]?white)?|coloredbg)(?:[-_.]|$)/i.test(
      filename
    ) ||
    /^logo[a-z0-9_-]*\.(?:png|jpe?g|webp|gif)$/i.test(filename) ||
    /^(?:transparent[-_][a-z0-9_-]+|sfondo\d*|dermatolgia(?:[-_][a-z0-9]+)*|medicina[-_]?interna(?:[-_][a-z0-9]+)*|ortopedico(?:[-_][a-z0-9]+)*|radiologia[-_]?dentale(?:[-_][a-z0-9]+)*|tomografo(?:[-_][a-z0-9]+)*)\.(?:png|jpe?g|webp|gif)$/i.test(
      filename
    ) ||
    /^(?:(?:cv2[-_])?sectionbg\d*(?:[-_]\d+x\d+)?|\d{3,4}[-_]\d{3}[-_]\d{3}(?:[-_]\d+)?|aniznai(?:[-_]\d+)?|autism(?:[-_]\d+)?|pharmacy(?:[-_]\d+)?)\.(?:png|jpe?g|webp|gif)$/i.test(
      filename
    ) ||
    /\/wp-content\/(?:themes|plugins)\/[^/]+\/(?:[^/]+\/){0,5}(?:assets?|resources?)\/(?:[^/]+\/){0,5}images?\//i.test(
      pathname
    ) ||
    /\/wp-content\/(?:themes|plugins)\/[^/]+\/(?:[^/]+\/){0,5}images?\//i.test(
      pathname
    ) ||
    /\/(?:foto[-_]?organigramma|organigramma[-_]?foto|staff[-_]?photos?|team[-_]?photos?)\//i.test(
      pathname
    ) ||
    /\/images\/(?:gallery|slides?|attrezzature(?:[-_][^/]+)?|noleggio[-_]?attrezzature|terapie[-_]?(?:private|convenzionate))\//i.test(
      pathname
    ) ||
    /\/wp-content\/uploads\/elementor\/thumbs\//i.test(pathname) ||
    /^cropped-[^.]+\.(?:png|jpe?g|webp|gif)$/i.test(filename) ||
    /^cropped-.*-\d{2,4}x\d{2,4}\.(?:png|jpe?g|webp|gif)$/i.test(filename)
  );
}

/** Insurer/fund logos displayed on a patient-convention page, not an RC document. */
export function isClearlyPatientConventionLogoUrl(
  url: string,
  parentUrl: string | null | undefined
): boolean {
  if (!parentUrl || isPolicyLikeResourceUrl(url)) return false;
  if (!/\/assicurazioni?-e-convenzioni(?:\/|$|[?#])/i.test(parentUrl)) {
    return false;
  }
  let filename = "";
  try {
    filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    filename = url;
  }
  return /(?:logo|unisalute|allianz|iws(?:-s\.?p\.?a)?|generali(?:-welion)?|welion)/i.test(
    filename
  );
}

/** Product photography on an e-commerce/catalogue page is not a published RC document. */
export function isClearlyCommercialProductImageUrl(
  url: string,
  parentUrl: string | null | undefined
): boolean {
  if (!parentUrl || isPolicyLikeResourceUrl(url)) return false;
  try {
    const parentPath = decodeURIComponent(new URL(parentUrl).pathname);
    return /\/(?:shop|store|e-?commerce|catalogo|prodott[io]|product)(?:[-_/]|$)/i.test(
      parentPath
    );
  } catch {
    return false;
  }
}

/**
 * WordPress commonly serves a downsized `name-254x170.jpg` while the original
 * document/photo remains at `name.jpg`. Schedule the original before allowing
 * a text-poor thumbnail to close.
 */
export function originalImageUrlForThumbnail(url: string): string | null {
  try {
    const parsed = new URL(url);
    const originalPath = parsed.pathname.replace(
      /-\d{2,5}x\d{2,5}(\.(?:png|jpe?g|webp|gif|tiff?|bmp))$/i,
      "$1"
    );
    if (originalPath === parsed.pathname) return null;
    parsed.pathname = originalPath;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isTextResourceType(type: string): boolean {
  return (
    type === "html" ||
    type === "json" ||
    type === "script" ||
    type === "style" ||
    type === "xml" ||
    type === "text"
  );
}

function normalizedHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isSameSiteResource(url: string, website: string): boolean {
  const a = normalizedHost(url);
  const b = normalizedHost(website);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

const POLICY_URL_TERM_RE =
  /polizz|assicur|copertura|contratto|certificat|quietanza|gelli|responsabilit|massimale|appendice/i;
const RC_POLICY_TOKEN_RE = /(?:^|[^a-z])r(?:[._\s-]?c(?:[._\s-]?t|[._\s-]?o))(?:[^a-z]|$)/i;

export function isPolicyLikeResourceUrl(url: string): boolean {
  let searchable = url;
  try {
    const parsed = new URL(url, "https://policy-url.invalid/");
    searchable = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
  } catch {
    try {
      searchable = decodeURIComponent(url);
    } catch {
      /* keep the raw URL */
    }
  }
  return POLICY_URL_TERM_RE.test(searchable) || RC_POLICY_TOKEN_RE.test(searchable);
}

/**
 * Public-site crawl boundary. The exact public host is always in scope. A
 * sibling/subdomain is followed only when it is recognisably a public-content
 * host or exposes a document/policy resource; this prevents a public homepage
 * link from expanding an HR, booking or clinical application into thousands
 * of irrelevant runtime assets.
 */
export function isCrawlScopeResource(
  url: string,
  website: string,
  type: SiteResourceType = resourceTypeForUrl(url)
): boolean {
  let resourceHost = "";
  let websiteHost = "";
  try {
    resourceHost = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    websiteHost = new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }
  if (!resourceHost || !websiteHost) return false;
  if (resourceHost === websiteHost) return true;

  const relatedDomain =
    resourceHost.endsWith(`.${websiteHost}`) ||
    websiteHost.endsWith(`.${resourceHost}`);
  if (!relatedDomain) return false;
  if (isPolicyLikeResourceUrl(url)) return true;
  if (type === "pdf" || type === "office") return true;

  const childHost = resourceHost.endsWith(`.${websiteHost}`)
    ? resourceHost.slice(0, -(websiteHost.length + 1))
    : "";
  const publicContentSubdomain =
    /(?:^|\.)(?:trasparen(?:za|te)?|amministrazione|albo|atti|documenti?|downloads?|public|istituzionale)(?:\.|$)/i.test(
      childHost
    );
  if (publicContentSubdomain) {
    return /^(?:html|json|xml|text|pdf|office|image)$/i.test(type);
  }
  const publicMediaSubdomain =
    /(?:^|\.)(?:cdn|media|static|assets?|img|images|files)(?:\.|$)/i.test(childHost);
  return Boolean(
    publicMediaSubdomain && /^(?:pdf|office|image)$/i.test(type)
  );
}

/**
 * Text used for policy classification must represent the page, not executable
 * source or CSS identifiers embedded in the rendered DOM. Inline and linked
 * resources are still discovered and crawled separately.
 */
export function extractVisibleTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  return $.root().text().replace(/\s+/g, " ").trim();
}

export function shouldFollowExternalResource(
  url: string,
  type: SiteResourceType
): boolean {
  return isPolicyLikeResourceUrl(url) && type !== "html" && type !== "other";
}

export function isGeneratedRuntimeRequestUrl(raw: string): boolean {
  // Insurance-bearing resources are always retained, even when their path
  // resembles a CMS endpoint.
  if (isPolicyLikeResourceUrl(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      url.searchParams.get("jet_blog_ajax") === "1" ||
      url.searchParams.get("na") === "s" ||
      /^\/(?:it\/)?wp-json\/oembed\/1\.0\/embed\/?$/i.test(url.pathname) ||
      /^\/(?:it\/)?wp-json\/wp\/v2\/(?:pages|posts|media)\/\d+\/?$/i.test(
        url.pathname
      ) ||
      /^\/(?:it\/)?wp-json\/contact-form-7\/v1\/contact-forms\/\d+\/(?:refill|feedback\/schema)\/?$/i.test(
        url.pathname
      ) ||
      /^\/(?:it\/)?wp-json\/jet-blocks-api\/v1\/elementor-template\/?$/i.test(
        url.pathname
      ) ||
      /\/embed(?:-legal|-no-markup)?\.json\/?$/i.test(url.pathname) ||
      /\/(?:comments\/)?feed\/?$/i.test(url.pathname) ||
      /\/embed\/?$/i.test(url.pathname) ||
      (url.searchParams.has("p") &&
        [...url.searchParams.keys()].every((key) => key === "p"))
    );
  } catch {
    return (
      /[?&](?:na=s|jet_blog_ajax=1)(?:&|$)/i.test(raw) ||
      /\/(?:comments\/)?feed\/?(?:[?#]|$)|\/embed\/?(?:[?#]|$)|\/wp-json\/oembed\/1\.0\/embed/i.test(
        raw
      )
    );
  }
}

function safeHttpUrl(raw: string, pageUrl: string): string | null {
  let value = String(raw || "")
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/^url\((['"]?)/i, "")
    .replace(/(['"]?)\)$/i, "");
  if (
    !value ||
    value.startsWith("#") ||
    /[{}]|%7B|%7D/i.test(value) ||
    /^(?:mailto|tel|javascript|data|blob):/i.test(value)
  ) {
    return null;
  }
  // Bare external hosts in malformed theme markup (`www.google.it`) must not
  // become fake first-party paths such as `/www.google.it`.
  if (
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/i.test(value)
  ) {
    value = `https://${value}`;
  }
  // Browser error-page/JavaScript property names can appear in serialized DOM
  // attributes and otherwise become fake routes such as `/b.blockedURI`.
  if (
    /^(?:\.?\/)?[A-Za-z_$][\w$]*\.(?:blockedURI|baseURI|documentURI)$/i.test(
      value
    )
  ) {
    return null;
  }
  // Optional-chaining/property expressions copied out of minified JavaScript
  // are not URLs (`/doctor_cat/i.old,c.bg?.image?.src`).
  if (/\?\.[A-Za-z_$]/.test(value)) return null;
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function canFollow(
  url: string,
  website: string,
  type: SiteResourceType,
  directFromFirstParty: boolean,
  source: string
): boolean {
  if (isCrawlScopeResource(url, website, type)) return true;
  if (!directFromFirstParty) return false;
  // Browser rendering already executes third-party JS/CSS and captures its
  // text responses. Re-crawling social widgets, trackers and generic external
  // images creates an unbounded graph. Keep only external documents/assets
  // whose URL itself is policy-related.
  if (
    directFromFirstParty &&
    (type === "pdf" || type === "office") &&
    !/(?:inline|embedded|playwright-network)/i.test(source)
  ) {
    return true;
  }
  return shouldFollowExternalResource(url, type);
}

function pushResource(
  out: Map<string, DiscoveredSiteResource>,
  raw: string,
  pageUrl: string,
  website: string,
  source: string,
  directFromFirstParty: boolean
): void {
  if (/^\s*\+\s*[A-Za-z_$][\w$.-]*\s*\+\s*$/i.test(raw)) return;
  const url = safeHttpUrl(raw, pageUrl);
  if (!url) return;
  if (isGeneratedRuntimeRequestUrl(url)) return;
  if (isRecursiveStaticAssetUrl(url)) return;
  const resourceType = resourceTypeForUrl(url);
  if (resourceType === "other") return;
  if (!canFollow(url, website, resourceType, directFromFirstParty, source)) return;
  if (!out.has(url)) out.set(url, { url, resourceType, discoverySource: source });
}

function addSrcset(
  out: Map<string, DiscoveredSiteResource>,
  value: string,
  pageUrl: string,
  website: string,
  source: string,
  directFromFirstParty: boolean
): void {
  for (const part of value.split(",")) {
    const raw = part.trim().split(/\s+/)[0];
    if (raw) pushResource(out, raw, pageUrl, website, source, directFromFirstParty);
  }
}

const POLICY_RESOURCE_HINT_RE =
  /polizz|assicur|copertura|contratto|certificat|quietanza|rct|rco|gelli|responsabilit|massimale|appendice|trasparen/i;

/**
 * JavaScript bundles often contain quoted property names that begin with `/`.
 * They are expressions, not browser-addressable resources. Real DOM links and
 * browser network requests are collected by separate, authoritative paths.
 */
export function isEmbeddedScriptExpressionArtifactUrl(raw: string): boolean {
  if (!raw || POLICY_RESOURCE_HINT_RE.test(raw)) return false;
  let pathname = raw;
  try {
    pathname = new URL(raw, "https://embedded.invalid/").pathname;
  } catch {
    /* inspect the raw value below */
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* malformed escapes remain inspectable in encoded form */
  }
  const tail = pathname.replace(/\/+$/, "").split("/").pop() || "";
  if (/^\+\s*[A-Za-z_$][\w$.-]*\s*\+$/i.test(tail)) return true;
  if (
    /(?:&quot;|&#0*34;|var\(--|\|\||&&|[()[\]])/i.test(pathname) ||
    /\/(?:image|text|application)\/[a-z0-9.+-]+\/?$/i.test(pathname)
  ) {
    return true;
  }
  if (/^[A-Za-z_$][\w$]?$/.test(tail)) return true;
  if (/^(?:src|href|url|uri|path|pathname|origin|protocol|host|hostname)$/i.test(tail)) {
    return true;
  }
  if (
    /^(?:assertThisInitialized|setPrototypeOf|toPropertyKey|checkPrivateRedeclaration|writeOnlyError|readOnlyError|class(?:Apply|Extract|Private|Static)[A-Za-z0-9_$]*)\.js$/i.test(
      tail
    )
  ) {
    return true;
  }
  if (
    /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|csv|json|xml|css|m?js|cjs|png|jpe?g|gif|webp|svg|tiff?|bmp|ico|woff2?|ttf|eot|mp3|mp4|webm|zip|p7m)$/i.test(
      tail
    )
  ) {
    return false;
  }
  if (
    /^(?:(?:window|document|self|location|this|[A-Za-z_$])\.)+[A-Za-z_$][\w$]*$/i.test(
      tail
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Detect paths produced when a catch-all HTML page is served for a missing
 * static asset. Resolving that shell's relative asset links against the bogus
 * asset URL repeats a vendor/assets directory forever. Genuine documents and
 * policy-looking URLs are deliberately never rejected by this guard.
 */
export function isRecursiveStaticAssetUrl(raw: string): boolean {
  if (!raw || POLICY_RESOURCE_HINT_RE.test(raw)) return false;
  let pathname = raw;
  try {
    pathname = decodeURIComponent(new URL(raw, "https://crawl.invalid/").pathname);
  } catch {
    /* inspect the raw path */
  }
  const parts = pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const staticPart = /^(?:assets?|vendor|resources?|images?|plugins?|themes?|css|js)$/i;
  if (
    parts.length >= 6 &&
    parts.some(
      (part, index) =>
        index > 0 && part === parts[index - 1] && staticPart.test(part)
    )
  ) {
    return true;
  }
  for (let width = 2; width <= Math.min(12, Math.floor(parts.length / 2)); width++) {
    for (let start = 0; start + width * 2 <= parts.length; start++) {
      const first = parts.slice(start, start + width);
      if (!first.some((part) => staticPart.test(part))) continue;
      const second = parts.slice(start + width, start + width * 2);
      if (first.every((part, index) => part === second[index])) return true;
    }
  }
  return false;
}

function discoverEmbeddedUrls(
  text: string,
  pageUrl: string,
  website: string,
  source: string,
  directFromFirstParty: boolean,
  out: Map<string, DiscoveredSiteResource>
): void {
  const candidates = new Set<string>();
  // Absolute URLs are unambiguous even when not quoted.
  for (const match of text.matchAll(
    /\bhttps?:\/\/[^\s"'<>\\)]+/gi
  )) {
    candidates.add(match[0]);
  }
  // Relative and protocol-relative URLs must be complete string literals.
  // Requiring the closing quote prevents minified expressions such as
  // `s.old,y.bg?.image?.src` from becoming thousands of fake routes.
  for (const match of text.matchAll(
    /(["'`])((?:\/\/|\/|\.\.?\/)[A-Za-z0-9_%@+./?=&:#~,-]{2,})\1/g
  )) {
    if (match[2]) candidates.add(match[2]);
  }
  // CSS url(...) only: the lookbehind keeps JS calls such as
  // createObjectURL(blob) / getDownloadURL(storageRef) from matching, and the
  // identifier guard drops bare variable names. Firebase-era SDKs otherwise
  // turn every `...URL(ref)` call into a fake same-site route (k3 2026-07-31).
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_$])url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
  )) {
    if (match[2] && !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(match[2])) {
      candidates.add(match[2]);
    }
  }
  for (const raw of candidates) {
    if (isEmbeddedScriptExpressionArtifactUrl(raw)) continue;
    const relative = /^(?:\/|\.\.?\/)/.test(raw);
    if (relative) {
      const inferred = resourceTypeForUrl(raw);
      if (
        inferred === "html" &&
        !/\/api(?:\/|$)|\/wp-json(?:\/|$)|admin-ajax\.php|polizz|assicur|rct|rco|gelli|trasparen|document/i.test(
          raw
        )
      ) {
        // Bare directory/theme strings inside CSS/JS are not navigable
        // resources. Real HTML routes are already discovered from rendered
        // anchors/forms; API and insurance routes remain included here.
        continue;
      }
    }
    pushResource(out, raw, pageUrl, website, source, directFromFirstParty);
  }
}

/**
 * Some CMS grid widgets emit an ever-increasing data-next-link even after
 * declaring both max-pages=0 and total=0. Treat only that contradictory widget
 * attribute as exhausted; ordinary anchors and real pagination remain intact.
 */
function stripExhaustedWidgetNextLinks(html: string): string {
  return html.replace(/<[^>]+>/g, (tag) => {
    const exhaustedMax =
      /\bdata-(?:max-pages|max_pages)\s*=\s*(["'])0\1/i.test(tag);
    const exhaustedTotal =
      /\bdata-total\s*=\s*(["'])0\1/i.test(tag);
    if (!exhaustedMax || !exhaustedTotal) return tag;
    return tag.replace(
      /\sdata-(?:next-link|next_link)\s*=\s*(?:"[^"]*"|'[^']*')/gi,
      ""
    );
  });
}

/**
 * Extract every browser-addressable resource exposed by a first-party page:
 * static DOM attributes, srcset/data-* lazy assets and inline JS/CSS URLs.
 */
export function discoverResourcesFromHtml(
  html: string,
  pageUrl: string,
  website: string,
  source = "html-resource"
): DiscoveredSiteResource[] {
  const out = new Map<string, DiscoveredSiteResource>();
  const directFromFirstParty = isSameSiteResource(pageUrl, website);
  const $ = cheerio.load(html);
  let documentBaseUrl = pageUrl;
  const declaredBase = $("base[href]").first().attr("href");
  if (declaredBase) {
    try {
      const resolved = new URL(declaredBase, pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        documentBaseUrl = resolved.toString();
      }
    } catch {
      /* invalid base href: preserve normal document URL resolution */
    }
  }
  const attrs = [
    ["a[href]", "href"],
    ["link[href]", "href"],
    ["script[src]", "src"],
    ["iframe[src]", "src"],
    ["embed[src]", "src"],
    ["object[data]", "data"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[poster]", "poster"],
    ["form[action]", "action"],
    ["*[data-href]", "data-href"],
    ["*[data-url]", "data-url"],
    ["*[data-src]", "data-src"],
    ["*[data-download]", "data-download"],
  ] as const;

  for (const [selector, attr] of attrs) {
    $(selector).each((_, element) => {
      const value = $(element).attr(attr);
      if (value) {
        pushResource(out, value, documentBaseUrl, website, source, directFromFirstParty);
      }
    });
  }
  $("*[srcset], *[data-srcset]").each((_, element) => {
    for (const attr of ["srcset", "data-srcset"]) {
      const value = $(element).attr(attr);
      if (value) {
        addSrcset(out, value, documentBaseUrl, website, source, directFromFirstParty);
      }
    }
  });

  discoverEmbeddedUrls(
    stripExhaustedWidgetNextLinks(html),
    documentBaseUrl,
    website,
    `${source}-inline`,
    directFromFirstParty,
    out
  );
  return [...out.values()];
}

/** Extract URLs from JavaScript, JSON, XML, CSS and plain-text resources. */
export function discoverResourcesFromText(
  text: string,
  resourceUrl: string,
  website: string,
  source = "embedded-resource"
): DiscoveredSiteResource[] {
  const out = new Map<string, DiscoveredSiteResource>();
  discoverEmbeddedUrls(
    text,
    resourceUrl,
    website,
    source,
    isSameSiteResource(resourceUrl, website),
    out
  );
  return [...out.values()];
}
