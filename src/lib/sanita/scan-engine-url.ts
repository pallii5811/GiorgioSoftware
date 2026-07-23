/** Motore scan su Hetzner (Playwright + OCR). Vercel fa solo proxy. */
export const HETZNER_SCAN_ENGINE = "http://167.233.209.13:3000";

/** Istanza Hetzner che esegue Playwright in locale (non proxy). */
export function isScanEngineHost(): boolean {
  return process.env.SCAN_ENGINE_LOCAL === "1";
}

/** UI su Vercel — proxy verso Hetzner. Esclude il motore scan anche se .env.production ha VERCEL=1. */
export function isVercelUiHost(): boolean {
  return process.env.VERCEL === "1" && !isScanEngineHost();
}

/** URL motore scan Hetzner — normalizza spazi/CRLF da dashboard Vercel. */
export function getScanEngineUrl(): string {
  if (isScanEngineHost()) return "";

  let raw = (process.env.SCAN_ENGINE_URL ?? "").trim();
  // Dashboard/CLI Windows possono salvare "\\r\\n" letterali o CRLF reali nel valore.
  raw = raw.replace(/\\r\\n/g, "").replace(/[\r\n]/g, "").trim();
  const cleaned = raw.replace(/\/$/, "");
  if (cleaned) return cleaned;
  if (isVercelUiHost()) return HETZNER_SCAN_ENGINE;
  return "";
}
