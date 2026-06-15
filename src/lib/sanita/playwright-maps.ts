/**
 * Scraper Google Maps — port TypeScript dal motore MIRAX (main.py).
 * Playwright sync in worker thread; estrae nome, indirizzo, telefono, sito web.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mapsMatchScore, mapsSearchQueries } from "@/lib/sanita/maps-query";
import { normalizeOfficialWebsite } from "@/lib/sanita/website";

export interface MapsPlace {
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  city: string;
  category: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAPS_POOL_SIZE = Number(process.env.MAPS_POOL_SIZE || 12);
let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let poolInit: Promise<void> | null = null;
const availablePages: Page[] = [];
const pageWaiters: Array<(page: Page) => void> = [];

async function ensureMapsPool(): Promise<void> {
  if (sharedBrowser) return;
  if (!poolInit) {
    poolInit = (async () => {
      const launched = await launchMapsBrowser();
      sharedBrowser = launched.browser;
      sharedContext = launched.context;
      for (let i = 0; i < MAPS_POOL_SIZE; i++) {
        const page = i === 0 ? launched.page : await launched.context.newPage();
        page.setDefaultTimeout(20_000);
        availablePages.push(page);
      }
      await handleMapsConsent(launched.page);
    })();
  }
  await poolInit;
}

export async function acquireMapsPage(): Promise<Page> {
  await ensureMapsPool();
  const page = availablePages.pop();
  if (page) return page;
  return new Promise((resolve) => pageWaiters.push(resolve));
}

export function releaseMapsPage(page: Page): void {
  const waiter = pageWaiters.shift();
  if (waiter) waiter(page);
  else availablePages.push(page);
}

/** Chiude il pool (fine scansione API). */
export async function closeMapsBrowserPool(): Promise<void> {
  poolInit = null;
  pageWaiters.length = 0;
  availablePages.length = 0;
  await sharedContext?.close().catch(() => {});
  await sharedBrowser?.close().catch(() => {});
  sharedContext = null;
  sharedBrowser = null;
}

export async function launchMapsBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--lang=it-IT", "--disable-blink-features=AutomationControlled", "--no-default-browser-check"],
  });
  const context = await browser.newContext({
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    userAgent: UA,
    viewport: { width: 1400, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  return { browser, context, page };
}

/** Cookie/consenso Google — stessi testi MIRAX. */
export async function handleMapsConsent(page: Page): Promise<void> {
  const texts = ["Accetta tutto", "Rifiuta tutto", "I agree", "Accept all", "Reject all"];

  async function clickInFrame(frame: typeof page): Promise<boolean> {
    try {
      const btnCss = frame.locator("#L2AGLb");
      if ((await btnCss.count()) > 0 && (await btnCss.isVisible())) {
        await btnCss.click({ timeout: 2000 });
        await page.waitForTimeout(600);
        return true;
      }
    } catch {
      /* ignore */
    }
    for (const t of texts) {
      try {
        const btn = frame.getByRole("button", { name: t }).first();
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          await btn.click({ timeout: 2500 });
          await page.waitForTimeout(700);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  try {
    if (await clickInFrame(page)) return;
  } catch {
    /* ignore */
  }
  for (const fr of page.frames()) {
    try {
      if (fr === page.mainFrame()) continue;
      if (await clickInFrame(fr as unknown as Page)) return;
    } catch {
      continue;
    }
  }
}

function normalizePhoneText(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.replace(/\s+/g, " ").trim();
  v = v.replace(/^telefono\s*:?\s*/i, "");
  return v || null;
}

/** Estrae telefono dal pannello dettaglio Maps (selettori MIRAX). */
export async function extractPhoneFromPanel(page: Page): Promise<string | null> {
  try {
    const v = await page.locator('button[data-item-id^="phone"]').first().textContent({ timeout: 1700 });
    const nv = normalizePhoneText(v);
    if (nv) return nv;
  } catch {
    /* ignore */
  }
  try {
    const href = await page.locator('a[href^="tel:"]').first().getAttribute("href", { timeout: 1400 });
    if (href) {
      const hv = href.split(":", 2)[1]?.split("?")[0];
      return normalizePhoneText(hv);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Estrae sito web dal pannello dettaglio Maps (selettori MIRAX). */
export async function extractWebsiteFromPanel(page: Page): Promise<string | null> {
  try {
    const href = await page.locator('a[data-item-id="authority"]').first().getAttribute("href", { timeout: 1700 });
    if (href?.startsWith("http")) return href;
  } catch {
    /* ignore */
  }
  const candidates = [
    'a[aria-label^="Sito"]',
    'a[aria-label^="Website"]',
    'a[aria-label*="Sito web"]',
    'a[href^="http"]',
  ];
  for (const css of candidates) {
    try {
      const href = await page.locator(css).first().getAttribute("href", { timeout: 900 });
      if (href?.startsWith("http") && !href.includes("google.com/maps")) return href;
    } catch {
      continue;
    }
  }
  return null;
}

import { isGelliSubjectStructure } from "./gelli-scope";

function composeQuery(category: string, city: string): string {
  return `${category} ${city}`;
}

/** True se la scheda Maps è una struttura soggetta art. 10 Gelli (polizza obbligatoria). */
export function isHealthcarePlace(name: string, panelCategory: string | null): boolean {
  return isGelliSubjectStructure(name, panelCategory);
}

/** Categoria dichiarata sul pannello dettaglio Maps (es. "Casa di cura"). */
async function extractCategoryFromPanel(page: Page): Promise<string | null> {
  try {
    const cat = await page
      .locator('button[jsaction*="category"]')
      .first()
      .textContent({ timeout: 1200 });
    return cat?.trim() || null;
  } catch {
    return null;
  }
}

async function searchMaps(page: Page, query: string, expectedCity: string, warm = false): Promise<void> {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=it&gl=it&entry=ttu`;

  if (warm) {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await handleMapsConsent(page);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);
    return;
  }

  // Navigazione diretta all'URL di ricerca (query+città già nell'URL): molto più
  // veloce del riempimento manuale della searchbox (no waits da 5s+3s per query).
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await handleMapsConsent(page);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(700);
}

async function pickFromMapsResults(
  page: Page,
  name: string,
  loc: string
): Promise<MapsPlace | null> {
  const feed = page.locator('div[role="feed"]').first();
  await feed.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});

  let cards = feed.locator('div[role="article"]');
  if ((await cards.count()) === 0) cards = feed.locator("div.Nv2PK");

  if ((await cards.count()) === 0) {
    const singleName = await page.locator("h1.DUwDvf").first().textContent({ timeout: 2500 }).catch(() => null);
    if (singleName?.trim()) {
      return {
        name: singleName.trim(),
        address: await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 2000 }).catch(() => null),
        phone: await extractPhoneFromPanel(page),
        website: await extractWebsiteFromPanel(page),
        city: loc,
        category: "Struttura sanitaria",
      };
    }
    return null;
  }

  const count = Math.min(await cards.count(), 10);
  const ranked: { score: number; index: number; cardName: string }[] = [];

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const cardName =
      (await card.locator(".fontHeadlineSmall").first().textContent({ timeout: 1500 }).catch(() => ""))?.trim() || "";
    if (!cardName) continue;
    const score = mapsMatchScore(name, cardName);
    if (score < 0) continue;
    ranked.push({ score, index: i, cardName });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;

  let fallback: MapsPlace | null = null;

  for (const pick of ranked.slice(0, 4)) {
    const card = cards.nth(pick.index);
    await card.click();
    await page.waitForTimeout(1800);
    try {
      await page.locator('a[data-item-id="authority"]').first().waitFor({ state: "attached", timeout: 7000 });
    } catch {
      /* ignore */
    }

    const website = normalizeOfficialWebsite(await extractWebsiteFromPanel(page));
    const place: MapsPlace = {
      name: pick.cardName,
      address: await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 1500 }).catch(() => null),
      phone: await extractPhoneFromPanel(page),
      website,
      city: loc,
      category: "Struttura sanitaria",
    };

    if (website) return place;
    if (!fallback) fallback = place;

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }

  return fallback;
}

export interface MapsLookupOptions {
  /** Numero massimo di query da provare (default: tutte). */
  maxQueries?: number;
  /** Timestamp limite (Date.now() + ms): si ferma quando superato. */
  deadline?: number;
}

/** Ricerca singola struttura su Maps (arricchimento sito/telefono). */
export async function lookupBusinessOnMaps(
  name: string,
  city: string | null,
  region: string,
  opts?: MapsLookupOptions
): Promise<MapsPlace | null> {
  let queries = mapsSearchQueries(name, city, region);
  if (opts?.maxQueries && opts.maxQueries > 0) {
    queries = queries.slice(0, opts.maxQueries);
  }
  const page = await acquireMapsPage();

  try {
    let best: MapsPlace | null = null;

    for (const { query, loc } of queries) {
      if (opts?.deadline && Date.now() >= opts.deadline) break;
      await searchMaps(page, query, loc, Boolean(sharedBrowser));
      const hit = await pickFromMapsResults(page, name, loc);
      if (!hit) continue;
      if (hit.website) return hit;
      if (!best) best = hit;
    }

    return best;
  } catch {
    return null;
  } finally {
    releaseMapsPage(page);
  }
}

/** Scoperta strutture per categoria+città (lista Maps). */
export async function scrapeMapsCategoryCity(
  category: string,
  city: string,
  maxResults: number,
  deadline?: number
): Promise<MapsPlace[]> {
  const query = composeQuery(category, city);
  const results: MapsPlace[] = [];
  const seen = new Set<string>();
  const page = await acquireMapsPage();

  try {
    await searchMaps(page, query, city, Boolean(sharedBrowser));

    const feed = page.locator('div[role="feed"]').first();
    // Comuni piccoli spesso non hanno feed: timeout breve per non sprecare il budget.
    const hasFeed = await feed
      .waitFor({ state: "visible", timeout: 12_000 })
      .then(() => true)
      .catch(() => false);

    // Scroll per caricare href unici (virtualizzazione MIRAX)
    const seenHrefs = new Set<string>();
    const maxScroll = Math.min(10, Math.ceil(maxResults / 5) + 2);
    for (let round = 0; hasFeed && round < maxScroll && seenHrefs.size < maxResults * 2; round++) {
      if (deadline && Date.now() >= deadline) break;
      try {
        const hrefs = await feed.evaluate((el) =>
          Array.from(el.querySelectorAll("a.hfpxzc"))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter(Boolean)
        );
        if (Array.isArray(hrefs)) hrefs.forEach((h) => seenHrefs.add(String(h)));
      } catch {
        /* ignore */
      }
      await feed.evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1000);
    }

    let cards = feed.locator('div[role="article"]');
    if ((await cards.count()) === 0) cards = feed.locator("div.Nv2PK");
    const visible = Math.min(await cards.count(), maxResults + 10);

    for (let idx = 0; idx < visible && results.length < maxResults; idx++) {
      if (deadline && Date.now() >= deadline) break;
      const card = cards.nth(idx);
      const placeName =
        (await card.locator(".fontHeadlineSmall").first().textContent({ timeout: 1500 }).catch(() => ""))?.trim() ||
        (await card.getAttribute("aria-label", { timeout: 900 }).catch(() => ""))?.trim() ||
        "";

      if (!placeName) continue;
      const key = placeName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      await card.click().catch(() => {});
      await page.waitForTimeout(1300);

      try {
        await page.locator('a[data-item-id="authority"]').first().waitFor({ state: "attached", timeout: 3000 });
      } catch {
        /* ignore */
      }

      const address = await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 1500 }).catch(() => null);

      // Integrità città (MIRAX)
      if (address && city && !address.toLowerCase().includes(city.toLowerCase())) continue;

      // Solo strutture sanitarie: Maps mischia immobiliari/hotel/ristoranti nei risultati.
      const panelCategory = await extractCategoryFromPanel(page);
      if (!isHealthcarePlace(placeName, panelCategory)) continue;

      results.push({
        name: placeName,
        address: address?.trim() || null,
        phone: await extractPhoneFromPanel(page),
        // Normalizza e scarta directory/social: solo siti istituzionali veri.
        website: normalizeOfficialWebsite(await extractWebsiteFromPanel(page)),
        city,
        category: panelCategory || category,
      });
    }
  } catch {
    /* ignore */
  } finally {
    releaseMapsPage(page);
  }

  return results;
}
