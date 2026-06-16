import * as cheerio from "cheerio";
import { externalFetch } from "@/lib/http";
import { analyzePolicy, type PolicyAnalysis } from "@/lib/sanita/detector";
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

/** Pagina conta come Trasparenza/polizza per certificare HOT (no privacy GDPR). */
export function pageCountsAsPolicyRelevant(url: string, pageText: string): boolean {
  const u = url.toLowerCase();
  const t = pageText.slice(0, 8000);
  const policyInText =
    /trasparen|polizz|assicuraz|gelli|art\.?\s*10|legge\s*(?:24|gelli)|massimale|rco\b|rct\b|responsabilit[aà]\s*civile/i.test(
      t
    );
  const policyInUrl =
    /trasparen|polizz|assicuraz|gelli|amministrazione-trasparente|societa-trasparente|responsabilit[aà]-civile|\/documenti/i.test(
      u
    );
  if (PRIVACY_ONLY_URL.test(u) && !policyInUrl) {
    return policyInText && /responsabilit[aà]\s*civile|polizza\s*rc|massimale|art\.?\s*10/i.test(t);
  }
  return policyInUrl || policyInText;
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
];

const FAST = process.env.SCAN_FAST !== "0" && process.env.SCAN_FAST !== "false";
/** Crawl policy sempre esaustivo: zero falsi HOT (polizza pubblicata ma non vista). */
const POLICY_EXHAUSTIVE = process.env.POLICY_EXHAUSTIVE !== "0" && process.env.POLICY_EXHAUSTIVE !== "false";
const MAX_SUBPAGES = POLICY_EXHAUSTIVE ? 14 : FAST ? 10 : 14;
const MAX_TOTAL_CHARS = 64_000;
const MAX_POLICY_CHARS = 120_000;
/** Nessun limite PDF in modalità esaustiva — ogni PDF trovato DEVE essere letto. */
const MAX_PDFS = POLICY_EXHAUSTIVE ? Number.POSITIVE_INFINITY : FAST ? 8 : 14;
const MAX_PDF_BYTES = 12_000_000;
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
    emails: [],
    pec: null,
    phones: [],
    piva: null,
    ...partial,
  };
}

/** Percorsi tipici della sezione Trasparenza / polizza Gelli sui siti italiani. */
const PROBE_PATHS = [
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
  "/wp-content/uploads",
];

function extractText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
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

function scoreLink(text: string, href: string): number {
  const hay = (text + " " + href).toLowerCase();
  let score = 0;
  for (const kw of RELEVANT_LINK_KEYWORDS) {
    if (hay.includes(kw)) score += 1;
  }
  // Priorità massima alle pagine di trasparenza / polizza
  if (/trasparen|polizza|gelli|assicuraz/.test(hay)) score += 3;
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

function isPolicyPdfUrl(url: string): boolean {
  return /polizz|assicuraz|rcg\d|risarcimenti-erogat|gelli|responsabilit|\/rc[-_]/i.test(url);
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
    const res = await externalFetch(url, { timeoutMs: 25_000, redirect: "follow" });
    if (!res.ok) return { text: null, needsOcr: false };
    const ct = res.headers.get("content-type") || "";
    if (!/pdf/i.test(ct) && !/\.pdf(?:$|\?|#)/i.test(url)) return { text: null, needsOcr: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) return { text: null, needsOcr: false };

    const prevOcr = process.env.OCR_ENABLED;
    const policyPdf = opts?.forceOcr || isPolicyPdfUrl(url);
    if (policyPdf) process.env.OCR_ENABLED = "1";

    try {
      const { extractPdfFullText, isOcrEnabled } = await import("./ocr");
      const { text, digital, ocr } = await extractPdfFullText(buf);
      const needsOcr =
        policyPdf &&
        (digital?.length ?? 0) < 200 &&
        !ocr &&
        !isOcrEnabled();
      return { text: text || null, needsOcr };
    } finally {
      if (policyPdf) process.env.OCR_ENABLED = prevOcr ?? "0";
    }
  } catch {
    return { text: null, needsOcr: false };
  }
}

/** Su pagina Trasparenza: TUTTI i PDF. Altrimenti solo link con anchor policy. */
function collectPdfsFromPage(
  $: ReturnType<typeof cheerio.load>,
  base: URL,
  pageIsRelevant = false
): string[] {
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!/\.pdf(?:$|\?|#)/i.test(href)) return;
    const text = $(el).text() || "";
    const meta = `${text} ${href}`;
    // In Trasparenza spesso ci sono bilanci (XBRL) che NON vanno letti come polizza RC.
    // Permetti solo PDF "bilancio" se nel link appare anche un chiaro riferimento assicurativo.
    if (FINANCIAL_PDF_HINT.test(meta) && !POLICY_PDF_HINT.test(meta)) return;
    if (!pageIsRelevant && !STRONG_RELEVANT.test(`${text} ${href}`)) return;
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

/** Priorità PDF: la polizza RC deve essere letta anche se il testo HTML ha già riempito il budget. */
function scorePdfUrl(url: string): number {
  const h = url.toLowerCase();
  // Bilanci/XBRL: mai prioritari per polizza RC (solo se linkato esplicitamente come assicurazione).
  if (FINANCIAL_PDF_HINT.test(h) && !POLICY_PDF_HINT.test(h)) return -50;
  // PARM/risarcimenti erogati: obbligo art.4, NON è la polizza RC art.10 → mai top priority.
  if (/risarcimenti-erogat|risarcimenti_erogat|parm/.test(h)) return 40;
  if (/polizz|rcg\d|_rc_|\/rc-/.test(h)) return 100;
  if (/assicuraz/.test(h)) return 90;
  if (/trasparen|gelli|responsabilit/.test(h)) return 60;
  return 0;
}

function sortPdfQueue(urls: Iterable<string>): string[] {
  return [...urls].sort((a, b) => scorePdfUrl(b) - scorePdfUrl(a));
}

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

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return emptyCrawl({ error: "URL non valido" });
  }

  const home = await fetchHomepage(base);
  if (home === null) {
    return emptyCrawl({ error: "Sito irraggiungibile o non in formato HTML" });
  }
  const homeHtml = home.html;
  // Usa l'host che ha effettivamente risposto come base per i link relativi.
  base = home.url;

  const contacts: ContactSink = { emails: new Set(), phones: new Set(), piva: null };

  pagesVisited.push(base.toString());
  combined += extractText(homeHtml);

  // Trova e ordina i link rilevanti nella homepage
  const $ = cheerio.load(homeHtml);
  collectContactsFromHtml($, contacts);
  const candidates = new Map<string, number>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const linkText = $(el).text() || "";
    const abs = sameHost(base, href);
    if (!abs || abs === base.toString()) return;
    const score = scoreLink(linkText, href);
    if (score > 0) {
      candidates.set(abs, Math.max(candidates.get(abs) ?? 0, score));
    }
  });

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SUBPAGES)
    .map(([url]) => url);

  // Coda dei PDF rilevanti: prima quelli linkati in homepage
  const pdfQueue = new Set<string>(collectPdfsFromPage($, base));

  const visitedSet = new Set(pagesVisited);

  for (const url of ranked) {
    if (combined.length >= MAX_TOTAL_CHARS) break;
    const html = await fetchHtml(url);
    if (html) {
      pagesVisited.push(url);
      visitedSet.add(url);
      const pageText = extractText(html);
      combined += " \n " + pageText;
      const pageRelevant = pageCountsAsPolicyRelevant(url, pageText);
      if (pageRelevant) {
        foundRelevantPage = true;
        policyText = appendPolicy(policyText, pageText);
      }
      const sub = cheerio.load(html);
      collectContactsFromHtml(sub, contacts);
      for (const p of collectPdfsFromPage(sub, base, pageRelevant)) pdfQueue.add(p);
    }
  }

  // Probe diretto dei path standard (molti CMS non linkano bene la Trasparenza dalla home)
  for (const path of PROBE_PATHS) {
    if (!POLICY_EXHAUSTIVE && combined.length >= MAX_TOTAL_CHARS) break;
    if (pagesVisited.length >= MAX_SUBPAGES + PROBE_PATHS.length) break;
    try {
      const probeUrl = new URL(path, base).toString();
      if (visitedSet.has(probeUrl)) continue;
      const html = await fetchHtml(probeUrl);
      if (!html) continue;
      pagesVisited.push(probeUrl);
      visitedSet.add(probeUrl);
      const pageText = extractText(html);
      combined += " \n " + pageText;
      const probeRelevant = pageCountsAsPolicyRelevant(probeUrl, pageText);
      if (probeRelevant) {
        foundRelevantPage = true;
        policyText = appendPolicy(policyText, pageText);
      }
      const sub = cheerio.load(html);
      collectContactsFromHtml(sub, contacts);
      for (const p of collectPdfsFromPage(sub, base, probeRelevant)) pdfQueue.add(p);
    } catch {
      /* path assente sul dominio */
    }
  }

  // PDF: TUTTI letti, senza eccezioni. Nessun "PDF non letto" ammesso.
  const sortedPdfs = sortPdfQueue(pdfQueue);
  const policyPdfsQueued = sortedPdfs.length;
  let policyPdfsRead = 0;
  let needsOcrReview = false;
  let policyFoundInPdf = false;
  let policyPdfAnalysis: PolicyAnalysis | null = null;

  for (const pdfUrl of sortedPdfs) {
    if (!POLICY_EXHAUSTIVE && policyPdfsRead >= MAX_PDFS) break;

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
    if (pdfAnalysis.policyFound) {
      policyFoundInPdf = true;
      // Conserva l'analisi del PDF vincente: scadenza/massimale non vanno persi
      // quando il verdetto viene ricalcolato sul corpus aggregato.
      policyPdfAnalysis = pdfAnalysis;
      policyText = appendPolicy(policyText, text);
      combined = (text + " \n " + combined).substring(0, MAX_TOTAL_CHARS);
      break;
    }
    if (isPolicyPdf) {
      combined =
        combined.length < MAX_TOTAL_CHARS ? combined + " \n " + text : combined;
    }
  }

  if (!policyFoundInPdf && analyzePolicy(policyText || combined).policyFound) {
    policyFoundInPdf = true;
  }

  const allPdfsRead = policyPdfsQueued === 0 || policyPdfsRead === policyPdfsQueued;
  const policyExhaustive =
    policyFoundInPdf ||
    (allPdfsRead &&
      !needsOcrReview &&
      ((policyPdfsQueued === 0 && foundRelevantPage && policyText.trim().length >= 120) ||
        policyPdfsQueued > 0));

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
    emails: emailList,
    pec,
    phones: [...contacts.phones],
    piva: contacts.piva,
  };
}
