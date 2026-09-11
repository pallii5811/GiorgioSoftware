/**
 * Dove gira il motore di scansione (Playwright + OCR). Vercel fa solo da proxy.
 *
 * Storia di questa costante, perche' spiega perche' esiste ancora:
 * il motore e' stato su due server Hetzner (168.119.253.47, poi 167.233.209.13)
 * e su un terzo che non e' mai entrato in servizio. Ogni volta l'indirizzo era
 * scritto QUI e anche nella variabile SCAN_ENGINE_URL su Vercel, e ogni volta
 * cambiarne uno solo lasciava il ripiego a puntare su una macchina morta.
 *
 * Il 9 settembre 2026 Hetzner e' sparito e il prodotto e' rimasto fermo tre
 * giorni: la pagina rispondeva 200, l'API dava 500, e nessuno se n'e' accorto.
 * Dal 11 settembre 2026 il motore e' su Scaleway.
 */
export const MOTORE_SCAN_PREDEFINITO = "http://151.115.147.134:3000";

/** Vecchio nome, tenuto perche' importato altrove. */
export const HETZNER_SCAN_ENGINE = MOTORE_SCAN_PREDEFINITO;

/**
 * Quanto aspettare il motore prima di rinunciare.
 *
 * Senza questo il proxy restava appeso finche' non scadeva la funzione su
 * Vercel: con il motore morto ogni richiesta pagava l'attesa intera — 16
 * secondi misurati il 9 settembre — per poi dare 500 lo stesso. Meglio
 * fallire in fretta: un motore che non risponde in dieci secondi non sta
 * rispondendo.
 */
export const TIMEOUT_MOTORE_MS = 10_000;

/** Istanza che esegue Playwright in locale (non proxy). */
export function isScanEngineHost(): boolean {
  return process.env.SCAN_ENGINE_LOCAL === "1";
}

/** UI su Vercel — proxy verso il motore. Esclude il motore anche se .env.production ha VERCEL=1. */
export function isVercelUiHost(): boolean {
  return process.env.VERCEL === "1" && !isScanEngineHost();
}

/** URL del motore — normalizza spazi/CRLF da dashboard Vercel. */
export function getScanEngineUrl(): string {
  if (isScanEngineHost()) return "";

  let raw = (process.env.SCAN_ENGINE_URL ?? "").trim();
  // Dashboard/CLI Windows possono salvare "\\r\\n" letterali o CRLF reali nel valore.
  raw = raw.replace(/\\r\\n/g, "").replace(/[\r\n]/g, "").trim();
  const cleaned = raw.replace(/\/$/, "");
  if (cleaned) return cleaned;
  if (isVercelUiHost()) return MOTORE_SCAN_PREDEFINITO;
  return "";
}
