import * as cheerio from "cheerio";
import { externalFetch } from "@/lib/http";
import {
  analyzePolicy,
  isGelliComplianceReportOnly,
  isGelliComplianceReportText,
  type PolicyAnalysis,
} from "@/lib/sanita/detector";
import { isParkedOrForSalePage, isSiteUnderMaintenance } from "@/lib/sanita/website";
import {
  discoverJsonApiUrls,
  extractJsonPolicyText,
  extractPageText,
} from "@/lib/sanita/extract-embedded";
// NB: pdf-parse (e la dipendenza nativa @napi-rs/canvas) viene importato in modo
// LAZY dentro fetchPdfText: l'import statico farebbe crashare `next build` durante
// la fase di "Collecting page data" (caricamento del modulo nativo).

export interface CrawlResult {
  text: string;
  /** Solo Trasparenza/Gelli + PDF polizza — usato per il verdetto (no rumore homepage). */
  policyText: string;
  pagesVisited: string[];
  ok: boolean;
  error: string | null;
  /** true se abbiamo realmente visitato una pagina trasparenza/polizza/assicurazioni. */
  foundRelevantPage: boolean;
  /** Tutti i PDF policy in coda sono stati letti (o polizza già trovata). */
  policyExhaustive: boolean;
  /** PDF policy in coda vs letti — per audit falsi HOT. */
  policyPdfsQueued: number;
  policyPdfsRead: number;
  /** PDF policy probabile solo-immagine e OCR non disponibile/fallito. */
  needsOcrReview: boolean;
  /** Analisi del PDF che ha trovato la polizza — preserva compagnia/scadenza/massimale. */
  policyPdfAnalysis: PolicyAnalysis | null;
  /** URL del PDF che ha certificato la polizza (se trovata in PDF). */
  policyPdfUrl: string | null;
  emails: string[];
  pec: string | null;
  phones: string[];
  piva: string | null;
}

interface ContactSink {
  emails: Set<string>;
  phones: Set<string>;
  piva: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const PIVA_RE =
  /(?:partita\s+iva|p\.?\s*iva|c\.?\s*f\.?\s*(?:e\s*)?p\.?\s*iva|vat(?:\s*number)?)[^\d]{0,12}(\d{11})\b/i;
const PHONE_RE = /(?:\+39[\s.\-]?)?(?:0\d{1,3}[\s.\-\/]?\d{5,8}|3\d{2}[\s.\-]?\d{6,7})/g;

// Bilanci/XBRL non sono polizze: evitano falsi "massimale" e compagnie da nota integrativa.
const FINANCIAL_PDF_HINT = /bilanci?|xbrl|nota[\s-]?integrativa|conto\s+economico|stato\s+patrimoniale/i;
const POLICY_PDF_HINT =
  /polizz|assicuraz|rc\b|rct\b|rco\b|gelli|art\.?\s*10|responsabilit[aà]\s*civile|sinistr|risarciment/i;

// Una email è PEC se locale/dominio richiamano i provider/keyword tipici italiani.
function isPec(email: string): boolean {
  const e = email.toLowerCase();
  const [local, domain = ""] = e.split("@");
  return (
    local === "pec" ||
    domain.startsWith("pec.") ||
    /pec|legalmail|postacert|arubapec|postecert|sicurezzapostale|cert\./.test(domain)
  );
}

// Normalizza un numero a forma nazionale (toglie +39/0039) per dedup affidabile.
function cleanPhone(raw: string): string {
  return raw
    .replace(/[^\d+]/g, "")
    .replace(/^\+39/, "")
    .replace(/^0039/, "")
    .replace(/^\+/, "");
}

// Validazione checksum della Partita IVA italiana (algoritmo di Luhn 11 cifre).
function isValidPiva(piva: string): boolean {
  if (!/^\d{11}$/.test(piva)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let n = piva.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// Email istituzionali preferite come contatto primario.
const EMAIL_PREFERRED = ["direzione", "direttore", "amministrazione", "segreteria", "info", "urp", "protocollo", "ufficio"];
function emailRank(e: string): number {
  const local = e.split("@")[0] || "";
  const i = EMAIL_PREFERRED.findIndex((p) => local.includes(p));
  return i < 0 ? 99 : i;
}

function collectContactsFromHtml($: ReturnType<typeof cheerio.load>, sink: ContactSink) {
  $("a[href^='mailto:']").each((_, el) => {
    const addr = ($(el).attr("href") || "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(addr)) sink.emails.add(addr);
  });
  $("a[href^='tel:']").each((_, el) => {
    const num = cleanPhone(($(el).attr("href") || "").replace(/^tel:/i, ""));
    const digits = num.replace(/^\+/, "");
    if (digits.length >= 8 && digits.length <= 13) sink.phones.add(num);
  });
}

function collectContactsFromText(text: string, sink: ContactSink) {
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/[.,;:]+$/, "");
    if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(e)) continue;
    if (/(example|sentry|wix|wordpress|domain)\./.test(e)) continue;
    sink.emails.add(e);
  }
  if (!sink.piva) {
    const p = text.match(PIVA_RE);
    if (p && isValidPiva(p[1])) sink.piva = p[1];
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const cleaned = cleanPhone(m[0]);
    const digits = cleaned.replace(/^\+/, "");
    // Scarta gli 11 cifre puri (probabile P.IVA/CF) se non in formato internazionale.
    if (digits.length === 11 && !cleaned.startsWith("+")) continue;
    if (digits.length >= 9 && digits.length <= 13) sink.phones.add(cleaned);
  }
}

// Pattern "forte" per link PDF / ranking — non usare "responsabilit" da solo (falsi positivi privacy GDPR).
const STRONG_RELEVANT =
  /trasparen|polizz|assicuraz|gelli|responsabilit[aà]\s*civile|rco\b|rct\b|art\.?\s*10|legge\s*gelli/i;

const PRIVACY_ONLY_URL = /(?:^|\/)(?:privacy|cookie|gdpr|legal-notice|note-legali|informativa-privacy)/i;

const POLICY_BODY_RE =
  /trasparen|polizz|assicuraz|gelli|art\.?\s*10|legge\s*(?:24|gelli)|massimale|rco\b|rct\b|responsabilit[aà]\s*civile/i;

const COOKIE_PRIVACY_BOILERPLATE =
  /cookie|informativa\s+privacy|gdpr|consenso|trattamento\s+(?:dei\s+)?dati|diritto\s+all.?oblio|utilizziamo\s+i\s+cookie/i;

/** Segnale forte RC art.10 — esclude falsi positivi da cookie/GDPR. */
export function hasStrongRcPolicySignal(text: string): boolean {
  const t = policyFocusSlice(text);
  if (/polizza\s+(?:in\s+vigore|rc\b|n[°º.])|numero\s+(?:della\s+)?pratica|codice\s+polizza/i.test(t)) {
    return true;
  }
  if (/responsabilit[aà]\s+civile.{0,140}(?:massimale|rct|rco|€)/i.test(t)) return true;
  if (/massimale.{0,100}(?:rct|rco)|\bR\.?C\.?T\b|\bR\.?C\.?O\b/i.test(t)) return true;
  if (
    /art\.?\s*10.{0,100}gelli|legge\s+(?:24\/2017|gelli)/i.test(t) &&
    /polizz|assicuraz|massimale/i.test(t)
  ) {
    return true;
  }
  if (/autoassicuraz|gestione\s+diretta\s+del\s+rischio/i.test(t)) return true;
  if (/dati\s+assicurazion|sottoscritto\s+(?:con|da)\s+.{3,40}\s+polizza/i.test(t)) return true;
  if (/copertura\s+assicurativa|polizza\s+stipulata/i.test(t) && /unipolsai|generali|am\s*trust|berkshire|hdi/i.test(t)) {
    return true;
  }
  return false;
}

export function isTransparencyUrl(url: string): boolean {
  return /amministrazione-trasparente|societa-trasparente|\/trasparen|\/polizz|\/assicuraz|responsabilit[aà]-civile|note-legali|dati-assicuraz/i.test(
    url.toLowerCase()
  );
}

/** Pagine dove molte strutture pubblicano la polizza RC (non solo /trasparenza). */
export function isPolicyPublicationUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    isTransparencyUrl(u) ||
    /gestione[\-_]?del[\-_]?rischio|rischio[\-_]?clinico|art\.?\s*10|legge[\-_]?gelli|assicurazion|convenzion|note-legali|legal-notice|dati-assicuraz|risk[\-_]?management|qualita[\-_]?e[\-_]?sicurezza|area[\-_]?trasparenza/i.test(
      u
    )
  );
}

/** Focus su sezione polizza se la pagina ha molto rumore (news/blog prima dell'art.10). */
function policyFocusSlice(pageText: string): string {
  const t = pageText.trim();
  const idx = t.search(
    /art\.?\s*10|legge\s+gelli|polizza\s+n\.?|copertura\s+assicurativa|responsabilit[aà]\s+civile\s+verso/i
  );
  if (idx > 400) return t.slice(Math.max(0, idx - 400), idx + 8000);
  return t.slice(0, 16_000);
}

/** Pagina conta come Trasparenza/polizza per certificare HOT (no privacy GDPR). */
export function pageCountsAsPolicyRelevant(url: string, pageText: string): boolean {
  const t = policyFocusSlice(pageText).trim();
  if (t.length < 40) return false;
  if (isSiteUnderMaintenance(pageText)) return false;
  if (analyzePolicy(t).policyFound || analyzePolicy(pageText).policyFound) return true;

  const u = url.toLowerCase();

  const onTransparencyUrl = isTransparencyUrl(u);
  const onPolicyUrl = isPolicyPublicationUrl(u);
  const strong = hasStrongRcPolicySignal(t);

  if (onTransparencyUrl || onPolicyUrl) {
    return (
      strong ||
      /eventi\s+avversi|risarcimenti\s+erogat|bilanci?\s+di\s+esercizio|attestazione.{0,50}anac/i.test(t)
    );
  }

  let path = "/";
  try {
    path = new URL(url).pathname.replace(/\/$/, "") || "/";
  } catch {
    /* ignore */
  }
  if (path === "/" && !strong) return false;
  if (COOKIE_PRIVACY_BOILERPLATE.test(t) && !strong) return false;
  return strong;
}

export function policyTextHasSubstance(text: string): boolean {
  const t = text.trim();
  return t.length >= 60 && hasStrongRcPolicySignal(t);
}

/** Trasparenza visitata e tutti i PDF in coda analizzati (anche 0/0). */
export function transparencyCrawlComplete(crawl: {
  pagesVisited: string[];
  foundRelevantPage: boolean;
  policyPdfsQueued: number;
  policyPdfsRead: number;
  needsOcrReview: boolean;
}): boolean {
  const visitedPolicyish = crawl.pagesVisited.some(
    (u) => isTransparencyUrl(u) || isPolicyPublicationUrl(u)
  );
  const allPdfsRead =
    crawl.policyPdfsQueued === 0 || crawl.policyPdfsRead === crawl.policyPdfsQueued;
  return (
    visitedPolicyish &&
    crawl.foundRelevantPage &&
    allPdfsRead &&
    !crawl.needsOcrReview
  );
}

// Parole chiave che indicano pagine rilevanti per la polizza Gelli
const RELEVANT_LINK_KEYWORDS = [
  "trasparente",
  "trasparenza",
  "polizza",
  "polizze",
  "assicuraz",
  "gelli",
  "responsabilit",
  "risarciment",
  "rischio clinico",
  "gestione del rischio",
  "risk management",
  "assicurazioni",
  "convenzioni",
  "amministrazione",
  "qualita",
  "qualità",
  "certificazion",
  "carta-dei-servizi",
  "carta dei servizi",
  "privacy",
  "chi-siamo",
  "la-struttura",
  "contatti",
  "contatto",
  "recapiti",
  "dove-siamo",
  "note-legali",
  "note legali",
  "documenti",
  "allegati",
  "download",
  "modulistica",
  "sicurezza",
];

const FAST = process.env.SCAN_FAST !== "0" && process.env.SCAN_FAST !== "false";
/** Crawl policy sempre esaustivo: zero falsi HOT (polizza pubblicata ma non vista). */
const POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false";
/** Esaustivo: BFS su tutte le pagine HTML del dominio (fino al tetto). */
const MAX_HTML_PAGES = POLICY_EXHAUSTIVE ? 150 : FAST ? 12 : 40;
const MAX_TOTAL_CHARS = POLICY_EXHAUSTIVE ? 200_000 : 64_000;
const MAX_POLICY_CHARS = 200_000;
/** Esaustivo: tutta la coda PDF scoperta sul sito. */
const MAX_PDFS = POLICY_EXHAUSTIVE ? Number.MAX_SAFE_INTEGER : FAST ? 8 : 20;
const MAX_PDF_BYTES = 12_000_000;
const PDF_FETCH_TIMEOUT_MS = POLICY_EXHAUSTIVE ? 90_000 : 25_000;
const PDF_READ_RETRIES = POLICY_EXHAUSTIVE ? 3 : 1;

function emptyCrawl(partial: Partial<CrawlResult> = {}): CrawlResult {
  return {
    text: "",
    policyText: "",
    pagesVisited: [],
    ok: false,
    error: null,
    foundRelevantPage: false,
    policyExhaustive: false,
    policyPdfsQueued: 0,
    policyPdfsRead: 0,
    needsOcrReview: false,
    policyPdfAnalysis: null,
    policyPdfUrl: null,
    emails: [],
    pec: null,
    phones: [],
    piva: null,
    ...partial,
  };
}

/** Percorsi tipici della sezione Trasparenza / polizza Gelli sui siti italiani. */
const PROBE_PATHS = [
  "/note-legali",
  "/note-legali/",
  "/it-it/note-legali",
  "/it-it/note-legali/",
  "/it/note-legali",
  "/legal",
  "/societa-trasparente",
  "/societa-trasparente/",
  "/amministrazione-trasparente",
  "/amministrazione-trasparente/",
  "/trasparenza",
  "/it/amministrazione-trasparente",
  "/chi-siamo/amministrazione-trasparente",
  "/documenti/trasparenza",
  "/assicurazione",
  "/polizza-rc",
  "/polizza-responsabilita-civile",
  "/responsabilita-civile",
  "/rc-professionale",
  "/documenti",
  "/download",
  "/allegati",
  "/modulistica",
  "/it/trasparenza",
  "/it/chi-siamo/trasparenza",
  "/chi-siamo/gestione-del-rischio-clinico",
  "/gestione-del-rischio-clinico",
  "/cuore/q-service/gestione-del-rischio-clinico",
  "/assicurazioni-e-convenzioni",
  "/assicurazioni",
  "/wp-content/uploads",
  // Varianti aggiuntive trovate su siti strutture italiane reali
  "/la-struttura/amministrazione-trasparente",
  "/it/la-struttura/amministrazione-trasparente",
  "/chi-siamo/trasparenza",
  "/dati-assicurazione",
  "/dati-assicurativi",
  "/polizza-assicurativa",
  "/info/trasparenza",
  "/info/note-legali",
  "/it/societa-trasparente",
  "/la-clinica/amministrazione-trasparente",
  "/la-clinica/trasparenza",
  "/la-struttura/trasparenza",
  "/rischio-clinico",
  "/risk-management",
  "/gestione-rischio",
  "/qualita-e-sicurezza",
  "/qualita",
  "/sito/amministrazione-trasparente",
  "/it/documenti",
  "/area-trasparenza",
];

function extractText(html: string): string {
  return extractPageText(html);
}

async function fetchJsonApiText(url: string): Promise<string | null> {
  try {
    const res = await externalFetch(url, { timeoutMs: 12_000, redirect: "follow" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("json") && !url.toLowerCase().includes(".json")) return null;
    const raw = await res.text();
    if (!raw.trim() || raw.length > 2_000_000) return null;
    const t = extractJsonPolicyText(raw);
    return t || null;
  } catch {
    return null;
  }
}

function sameHost(base: URL, href: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Sotto-pagina su portale corporate (es. kosgroup.com/it/centri/villa-…):
 * non espandere a tutto il dominio — solo prefisso struttura + link policy/trasparenza.
 */
function crawlPathPrefix(entry: URL): string | null {
  const p = entry.pathname.replace(/\/$/, "") || "/";
  if (p === "/") return null;
  const segments = p.split("/").filter(Boolean);
  return segments.length >= 2 ? p : null;
}

function sameHostScoped(base: URL, href: string, scopePrefix: string | null): string | null {
  const abs = sameHost(base, href);
  if (!abs || !scopePrefix) return abs;
  try {
    const path = new URL(abs).pathname;
    if (path === scopePrefix || path.startsWith(`${scopePrefix}/`)) return abs;
    const hay = abs.toLowerCase();
    if (/\.pdf(?:$|\?|#)/i.test(hay) && POLICY_PDF_HINT.test(hay)) return abs;
  if (/trasparen|amministrazione-trasparente|societa-trasparente|polizza|assicuraz|\/documenti|gestione[\-_]?del[\-_]?rischio|rischio[\-_]?clinico/.test(hay)) {
      return abs;
    }
    return null;
  } catch {
    return null;
  }
}

function scoreLink(text: string, href: string): number {
  const hay = (text + " " + href).toLowerCase();
  let score = 0;
  for (const kw of RELEVANT_LINK_KEYWORDS) {
    if (hay.includes(kw)) score += 1;
  }
  // Priorità massima alle pagine di trasparenza / polizza / art.10
  if (/trasparen|polizza|gelli|assicuraz|rischio\s+clinico|gestione.{0,20}rischio/.test(hay)) score += 3;
  return score;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await externalFetch(url, { timeoutMs: 15_000, redirect: "follow" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Varianti host da provare quando la homepage non risponde (www↔apex, http↔https). */
function homepageVariants(base: URL): string[] {
  const variants = new Set<string>();
  const hosts: string[] = [base.hostname];
  if (base.hostname.startsWith("www.")) hosts.push(base.hostname.slice(4));
  else hosts.push(`www.${base.hostname}`);

  for (const host of hosts) {
    for (const proto of ["https:", "http:"]) {
      const u = new URL(base.toString());
      u.protocol = proto;
      u.hostname = host;
      variants.add(u.toString());
    }
  }
  // Mantieni l'URL originale come primo tentativo.
  return [base.toString(), ...[...variants].filter((v) => v !== base.toString())];
}

/** Homepage robusta: prova www↔apex e https↔http finché una risponde HTML. */
async function fetchHomepage(base: URL): Promise<{ html: string; url: URL } | null> {
  for (const variant of homepageVariants(base)) {
    const html = await fetchHtml(variant);
    if (html !== null) return { html, url: new URL(variant) };
  }
  return null;
}

/** Esclude PDF noti non-assicurativi dal nome file. PARM/PARS vanno letti e filtrati sul testo. */
function isNonPolicyDocumentPdf(url: string): boolean {
  const h = url.toLowerCase();
  // Se il nome file contiene keyword assicurative, NON escludere mai (priorità policy).
  if (/polizz|assicuraz|rcg\d|responsabilit|rc[-_]|appendice|rinnovo/i.test(h)) return false;
  return /carta[\-_]?dei[\-_]?servizi|carta[\-_]?servizi|service[\-_]?charter|bilancio|xbrl|privacy|gdpr|modulo[\-_]|regolamento|organigramma|costi[\-_]?contabilizzat|conto[\-_]?economico|stato[\-_]?patrimoniale|relazione[\-_]?(?:annuale|finanziaria|gestione|sindaci|revisore)|\bcv[-_.]|curriculum[\-_]?vitae/i.test(
    h
  );
}

function isPolicyPdfUrl(url: string): boolean {
  const h = url.toLowerCase();
  if (isNonPolicyDocumentPdf(h)) return false;
  return /polizz|assicuraz|rcg\d|responsabilit[aà]|\/rc[-_]|appendice|rinnovo|pol\.-|pol[\-_]\d/i.test(h);
}

/** Legge un PDF con retry — se esiste sul sito, deve essere letto (mai "PDF non letto"). */
export async function fetchPdfTextWithRetry(
  url: string,
  opts?: { forceOcr?: boolean }
): Promise<{ text: string | null; needsOcr: boolean }> {
  let lastNeedsOcr = false;
  let lastText: string | null = null;

  for (let attempt = 0; attempt < PDF_READ_RETRIES; attempt++) {
    const forceOcr = opts?.forceOcr || attempt > 0 || POLICY_EXHAUSTIVE;
    const result = await fetchPdfText(url, { forceOcr });
    lastNeedsOcr = result.needsOcr || lastNeedsOcr;
    lastText = result.text;

    if (result.text?.trim()) {
      if (result.text.trim().length >= 40 || analyzePolicy(result.text).policyFound) {
        return result;
      }
    }
    if (attempt < PDF_READ_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  return { text: lastText, needsOcr: lastNeedsOcr };
}

// Scarica un PDF — su URL policy forza OCR per non perdere polizze scannerizzate (mai falso HOT).
async function fetchPdfText(
  url: string,
  opts?: { forceOcr?: boolean }
): Promise<{ text: string | null; needsOcr: boolean }> {
  try {
    const res = await externalFetch(url, { timeoutMs: PDF_FETCH_TIMEOUT_MS, redirect: "follow" });
    if (!res.ok) return { text: null, needsOcr: false };
    const ct = res.headers.get("content-type") || "";
    if (!/pdf/i.test(ct) && !/\.pdf(?:$|\?|#)/i.test(url)) return { text: null, needsOcr: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) return { text: null, needsOcr: false };

    const prevOcr = process.env.OCR_ENABLED;
    const policyPdf = opts?.forceOcr || isPolicyPdfUrl(url) || POLICY_EXHAUSTIVE;
    if (policyPdf) process.env.OCR_ENABLED = "1";

    try {
      const { extractPdfFullText } = await import("./ocr");
      const { text, digital, ocr } = await extractPdfFullText(buf);
      // Documento candidato-polizza ma ILLEGGIBILE (né testo digitale né OCR):
      // non possiamo certificare l'assenza polizza → REVIEW, MAI falso HOT.
      // (Indipendente da OCR on/off: se non abbiamo letto nulla, è un dubbio.)
      const unreadable = (digital?.length ?? 0) < 200 && !(ocr && ocr.trim());
      const needsOcr = policyPdf && unreadable;
      return { text: text || null, needsOcr };
    } finally {
      if (policyPdf) process.env.OCR_ENABLED = prevOcr ?? "0";
    }
  } catch {
    return { text: null, needsOcr: false };
  }
}

/** Su pagina Trasparenza: TUTTI i PDF (PARM/PARS inclusi). Esaustivo: ogni PDF del sito. */
function collectPdfsFromPage(
  $: ReturnType<typeof cheerio.load>,
  base: URL,
  pageIsRelevant = false,
  pageUrl?: string
): string[] {
  const out: string[] = [];
  const onTransparency = pageUrl ? isTransparencyUrl(pageUrl) : false;
  const onPolicyUrl = pageUrl ? isPolicyPublicationUrl(pageUrl) : false;
  const collectAll = POLICY_EXHAUSTIVE || pageIsRelevant || onTransparency || onPolicyUrl;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!/\.pdf(?:$|\?|#)/i.test(href)) return;
    const text = $(el).text() || "";
    const meta = `${text} ${href}`;
    if (FINANCIAL_PDF_HINT.test(meta) && !POLICY_PDF_HINT.test(meta)) return;
    if (!collectAll && !STRONG_RELEVANT.test(meta) && !/parm|pars[\-_./]/i.test(href)) return;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = "";
      out.push(u.toString());
    } catch {
      /* ignora */
    }
  });
  return out;
}

function isSkippableAssetUrl(href: string): boolean {
  return /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|css|js|woff2?)(?:$|\?|#)/i.test(
    href
  );
}

function discoverHtmlLinks(
  $: ReturnType<typeof cheerio.load>,
  base: URL,
  scopePrefix: string | null,
  sink: (url: string) => void
) {
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return;
    if (isSkippableAssetUrl(href)) return;
    const abs = sameHostScoped(base, href, scopePrefix);
    if (!abs || abs === base.toString()) return;
    sink(abs);
  });
}

/** Priorità PDF: la polizza RC deve essere letta anche se il testo HTML ha già riempito il budget. */
function scorePdfUrl(url: string): number {
  const h = url.toLowerCase();
  // Bilanci/XBRL: mai prioritari per polizza RC (solo se linkato esplicitamente come assicurazione).
  if (FINANCIAL_PDF_HINT.test(h) && !POLICY_PDF_HINT.test(h)) return -50;
  // PARM/PARS con RC art.10: priorità alta (spesso unica fonte polizza su Trasparenza).
  if (/parm|pars[\-_./]|[\-_/]pars[\-_./]|risk[\-_]?management|clinical[\-_]?risk|mcrm/i.test(h)) return 95;
  if (/polizz|rcg\d|_rc_|\/rc-/.test(h)) return 100;
  if (/assicuraz/.test(h)) return 90;
  if (/trasparen|gelli|responsabilit/.test(h)) return 60;
  return 0;
}

function sortPdfQueue(urls: Iterable<string>): string[] {
  return [...urls].sort((a, b) => scorePdfUrl(b) - scorePdfUrl(a));
}

export { sortPdfQueue };

/**
 * Naviga il sito di una struttura sanitaria partendo dalla homepage,
 * individua e visita le pagine più rilevanti per la polizza Gelli e
 * restituisce il testo aggregato per l'analisi.
 */
function appendPolicy(policyText: string, chunk: string): string {
  if (!chunk.trim()) return policyText;
  const merged = policyText ? `${policyText} \n ${chunk}` : chunk;
  return merged.length > MAX_POLICY_CHARS ? merged.slice(0, MAX_POLICY_CHARS) : merged;
}

export async function crawlSite(baseUrl: string): Promise<CrawlResult> {
  // OCR attivo per tutta la sessione crawl — polizze scannerizzate non devono sfuggire.
  const prevOcr = process.env.OCR_ENABLED;
  if (POLICY_EXHAUSTIVE) process.env.OCR_ENABLED = "1";

  const pagesVisited: string[] = [];
  let combined = "";
  let policyText = "";
  let foundRelevantPage = false;

  try {
    const inner = await crawlSiteInner(baseUrl, pagesVisited, combined, policyText, foundRelevantPage);
    if (process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false") {
      const { enrichCrawlWithPlaywright } = await import("@/lib/sanita/policy-playwright");
      return enrichCrawlWithPlaywright(baseUrl, inner);
    }
    return inner;
  } finally {
    if (POLICY_EXHAUSTIVE) process.env.OCR_ENABLED = prevOcr ?? "0";
  }
}

async function crawlSiteInner(
  baseUrl: string,
  pagesVisited: string[],
  combined: string,
  policyText: string,
  foundRelevantPage: boolean
): Promise<CrawlResult> {

  let entry: URL;
  try {
    entry = new URL(baseUrl);
  } catch {
    return emptyCrawl({ error: "URL non valido" });
  }
  const scopePrefix = crawlPathPrefix(entry);
  let base = entry;

  const home = await fetchHomepage(base);
  if (home === null) {
    return emptyCrawl({ error: "Sito irraggiungibile o non in formato HTML" });
  }
  if (isParkedOrForSalePage(home.html, home.url.toString())) {
    return emptyCrawl({ error: "Dominio parcheggiato o in vendita — non è un sito istituzionale" });
  }
  const homeHtml = home.html;
  // Usa l'host che ha effettivamente risposto come base per i link relativi.
  base = home.url;

  const contacts: ContactSink = { emails: new Set(), phones: new Set(), piva: null };

  pagesVisited.push(base.toString());
  combined += extractText(homeHtml);

  const $ = cheerio.load(homeHtml);
  collectContactsFromHtml($, contacts);

  const pdfQueue = new Set<string>(collectPdfsFromPage($, base, false, base.toString()));
  const jsonApiQueue = new Set<string>(discoverJsonApiUrls(homeHtml, base.toString()));
  const visitedSet = new Set(pagesVisited);
  const htmlQueue: string[] = [];
  const enqueuedHtml = new Set<string>();

  const enqueueHtml = (url: string, front = false) => {
    if (visitedSet.has(url) || enqueuedHtml.has(url)) return;
    enqueuedHtml.add(url);
    if (front) htmlQueue.unshift(url);
    else htmlQueue.push(url);
  };

  // Probe path noti (note-legali, trasparenza) in testa alla coda.
  for (const path of PROBE_PATHS) {
    try {
      enqueueHtml(new URL(path, base).toString(), true);
    } catch {
      /* path assente */
    }
  }
  discoverHtmlLinks($, base, scopePrefix, (u) => enqueueHtml(u));

  let policyFoundInHtml = false;
  let bfsComplete = false;
  let policyPdfAnalysis: PolicyAnalysis | null = null;
  let policyPdfUrl: string | null = null;

  while (htmlQueue.length > 0 && visitedSet.size < MAX_HTML_PAGES) {
    const url = htmlQueue.shift()!;
    if (visitedSet.has(url)) continue;

    const html = await fetchHtml(url);
    if (!html) continue;
    if (isParkedOrForSalePage(html, url)) continue;

    visitedSet.add(url);
    pagesVisited.push(url);
    const pageText = extractText(html);
    combined += " \n " + pageText;

    const pageRelevant = pageCountsAsPolicyRelevant(url, pageText);
    if (pageRelevant) {
      foundRelevantPage = true;
      policyText = appendPolicy(policyText, pageText);
    }

    const pageAnalysis = analyzePolicy(pageText);
    if (pageAnalysis.policyFound) {
      policyFoundInHtml = true;
      foundRelevantPage = true;
      policyText = appendPolicy(policyText, pageText);
      if (!policyPdfAnalysis) policyPdfAnalysis = pageAnalysis;
    }

    const sub = cheerio.load(html);
    collectContactsFromHtml(sub, contacts);
    for (const p of collectPdfsFromPage(sub, base, pageRelevant || pageAnalysis.policyFound, url)) {
      pdfQueue.add(p);
    }
    for (const j of discoverJsonApiUrls(html, url)) jsonApiQueue.add(j);
    discoverHtmlLinks(sub, base, scopePrefix, (u) => enqueueHtml(u));

    if (policyFoundInHtml && POLICY_EXHAUSTIVE) {
      // Polizza trovata in HTML — continua a raccogliere PDF link ma non espandere altre pagine.
      bfsComplete = true;
      break;
    }
  }

  if (!bfsComplete) {
    bfsComplete = htmlQueue.length === 0 || visitedSet.size >= MAX_HTML_PAGES;
  }

  for (const apiUrl of jsonApiQueue) {
    if (pagesVisited.includes(apiUrl)) continue;
    const apiText = await fetchJsonApiText(apiUrl);
    if (!apiText) continue;
    pagesVisited.push(apiUrl);
    combined += ` \n ${apiText}`;
    if (analyzePolicy(apiText).policyFound) {
      foundRelevantPage = true;
      policyText = appendPolicy(policyText, apiText);
    }
  }

  // PDF: TUTTI letti, senza eccezioni. Nessun "PDF non letto" ammesso.
  const sortedPdfs = sortPdfQueue(pdfQueue);
  const policyPdfsQueued = sortedPdfs.length;
  let policyPdfsRead = 0;
  let needsOcrReview = false;
  let policyFoundInPdf = policyFoundInHtml;

  for (const pdfUrl of sortedPdfs) {
    if (policyPdfsRead >= MAX_PDFS) break;

    const { text, needsOcr } = await fetchPdfTextWithRetry(pdfUrl, {
      forceOcr: POLICY_EXHAUSTIVE || isPolicyPdfUrl(pdfUrl),
    });

    pagesVisited.push(pdfUrl);
    policyPdfsRead++;

    if (needsOcr && !text?.trim()) needsOcrReview = true;
    if (!text?.trim()) continue;

    const isPolicyPdf =
      isPolicyPdfUrl(pdfUrl) ||
      /articolo\s+10|art\.?\s*10|polizza\s+assicurativa|n\.?\s*polizza\s+rct/i.test(text);
    if (isPolicyPdf) {
      policyText = appendPolicy(policyText, text);
      foundRelevantPage = true;
    }
    const pdfAnalysis = analyzePolicy(text);
    const complianceDoc = isGelliComplianceReportOnly(text, pdfUrl);
    const nonPolicyDoc = isNonPolicyDocumentPdf(pdfUrl);
    if (pdfAnalysis.policyFound && !complianceDoc && !nonPolicyDoc) {
      policyFoundInPdf = true;
      // Conserva l'analisi del PDF vincente: scadenza/massimale non vanno persi
      // quando il verdetto viene ricalcolato sul corpus aggregato.
      policyPdfAnalysis = pdfAnalysis;
      policyPdfUrl = pdfUrl;
      policyText = appendPolicy(policyText, text);
      combined = (text + " \n " + combined).substring(0, MAX_TOTAL_CHARS);
      break;
    }
    if (isPolicyPdf) {
      combined =
        combined.length < MAX_TOTAL_CHARS ? combined + " \n " + text : combined;
    }
  }

  if (!policyFoundInPdf) {
    const fallback = analyzePolicy(policyText || combined);
    if (fallback.policyFound) {
      policyFoundInPdf = true;
      policyPdfAnalysis = policyPdfAnalysis ?? fallback;
      policyPdfUrl =
        policyPdfUrl ??
        sortedPdfs.find((u) => /parm|pars|polizz|assicuraz/i.test(u.toLowerCase())) ??
        null;
    }
  }

  const allPdfsRead = policyPdfsQueued === 0 || policyPdfsRead === policyPdfsQueued;
  const crawlMeta = {
    pagesVisited,
    foundRelevantPage,
    policyPdfsQueued,
    policyPdfsRead,
    needsOcrReview,
  };
  const policyExhaustive =
    !isSiteUnderMaintenance(combined) &&
    (policyFoundInPdf ||
      (bfsComplete &&
        allPdfsRead &&
        !needsOcrReview &&
        (foundRelevantPage || policyPdfsQueued > 0)) ||
      transparencyCrawlComplete(crawlMeta));

  if (isSiteUnderMaintenance(combined)) {
    foundRelevantPage = false;
  }

  collectContactsFromText(combined, contacts);
  const emailList = [...contacts.emails].sort((a, b) => emailRank(a) - emailRank(b));
  const pec = emailList.find(isPec) ?? null;

  return {
    text: combined.substring(0, MAX_TOTAL_CHARS),
    policyText,
    pagesVisited,
    ok: true,
    error: null,
    foundRelevantPage,
    policyExhaustive,
    policyPdfsQueued,
    policyPdfsRead,
    needsOcrReview,
    policyPdfAnalysis,
    policyPdfUrl,
    emails: emailList,
    pec,
    phones: [...contacts.phones],
    piva: contacts.piva,
  };
}
