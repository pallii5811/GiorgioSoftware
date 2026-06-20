/** Parametri scansione — tunabili via env senza toccare la logica HOT/PUBLISHED. */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

import { isScanEngineHost } from "@/lib/sanita/scan-engine-url";

/** Durata massima di un round API/SSE (ms). */
export const SCAN_BUDGET_MS = envInt(
  "SCAN_BUDGET_MS",
  isScanEngineHost()
    ? 60 * 60_000
    : process.env.NODE_ENV === "development"
      ? 6 * 60_000
      : 110_000
);

/** Lead analizzati in parallelo per round (crawl paralleli; OCR resta serializzato). */
export const SCAN_ANALYSIS_CONCURRENCY = envInt("SCAN_ANALYSIS_CONCURRENCY", 8);

/** Frazione del round riservata a Maps discovery (resto = analisi siti). */
export const SCAN_DISCOVERY_SHARE = (() => {
  const raw = process.env.SCAN_DISCOVERY_SHARE;
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0 && n < 1) return n;
  }
  return 0.4;
})();

/** Se in coda ci sono almeno N lead con sito, salta discovery e analizza. */
export const SCAN_DISCOVERY_SKIP_BACKLOG = envInt("SCAN_DISCOVERY_SKIP_BACKLOG", 25);

/** UI live: 1 = un lead alla volta in tabella (demo cliente). */
export const SCAN_STREAM_CONCURRENCY = envInt("SCAN_STREAM_CONCURRENCY", 1);

/** Prima scansione da zero: discovery breve così parte subito l'analisi. */
export const SCAN_INITIAL_DISCOVERY_MS = envInt("SCAN_INITIAL_DISCOVERY_MS", 75_000);

/** Tetto discovery per round — evita sessioni bloccate ore su Maps. */
export const SCAN_DISCOVERY_MAX_MS = envInt("SCAN_DISCOVERY_MAX_MS", 90_000);

/** Chunk discovery per round su Hetzner (riconnessioni SSE ~5 min). */
export const SCAN_DISCOVERY_CHUNK_MS = envInt(
  "SCAN_DISCOVERY_CHUNK_MS",
  isScanEngineHost() ? 5 * 60_000 : 90_000
);

/** Su Hetzner nessun limite di round — accuratezza prima di tutto. */
export function scanRoundDeadline(): number {
  if (isScanEngineHost()) return Number.MAX_SAFE_INTEGER;
  return Date.now() + SCAN_BUDGET_MS;
}

/** 0 = nessun limite per-lead (crawl lunghi ok). Default: illimitato su scan engine, 8 min su Vercel/demo. */
export const SCAN_LEAD_MAX_MS = (() => {
  const raw = process.env.SCAN_LEAD_MAX_MS;
  if (raw === "0") return 0;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return isScanEngineHost() ? 0 : 8 * 60_000;
})();

/**
 * Watchdog anti-blocco su Hetzner quando SCAN_LEAD_MAX_MS=0.
 * Non tronca crawl legittimi (NefroCenter ~11 min ok) — salta lead impantanati (Chrome/OCR).
 * 0 = disabilitato esplicitamente.
 */
export const SCAN_LEAD_STALL_MS = (() => {
  const raw = process.env.SCAN_LEAD_STALL_MS;
  if (raw === "0") return 0;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return isScanEngineHost() ? 35 * 60_000 : 0;
})();

/** Tetto URL visitate nel pass Playwright post-crawl (evita ore su siti enormi). */
export const PLAYWRIGHT_POLICY_MAX_URLS = envInt("PLAYWRIGHT_POLICY_MAX_URLS", 16);

/** Tetto solo sul pass Playwright post-crawl (non limita il BFS HTML/PDF). 0 = illimitato. */
export const PLAYWRIGHT_POLICY_MAX_MS = (() => {
  const raw = process.env.PLAYWRIGHT_POLICY_MAX_MS;
  if (raw === "0") return 0;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return isScanEngineHost() ? 20 * 60_000 : 12 * 60_000;
})();
