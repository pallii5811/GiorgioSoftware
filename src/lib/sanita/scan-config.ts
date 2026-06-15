/** Parametri scansione — tunabili via env senza toccare la logica HOT/PUBLISHED. */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Durata massima di un round API/SSE (ms). */
export const SCAN_BUDGET_MS = envInt(
  "SCAN_BUDGET_MS",
  process.env.NODE_ENV === "development" ? 6 * 60_000 : 110_000
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

/** Timeout singolo lead se POLICY_EXHAUSTIVE disattivo (ms). */
export const SCAN_LEAD_TIMEOUT_MS = envInt("SCAN_LEAD_TIMEOUT_MS", 12 * 60_000);

/** Prima scansione da zero: discovery breve così parte subito l'analisi. */
export const SCAN_INITIAL_DISCOVERY_MS = envInt("SCAN_INITIAL_DISCOVERY_MS", 75_000);
