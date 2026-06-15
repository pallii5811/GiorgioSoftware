/** Motore scan su Hetzner (Playwright + OCR). Vercel fa solo proxy. */
export const HETZNER_SCAN_ENGINE = "http://168.119.253.47:3000";

/** URL motore scan Hetzner — normalizza spazi/CRLF da dashboard Vercel. */
export function getScanEngineUrl(): string {
  let raw = (process.env.SCAN_ENGINE_URL ?? "").trim();
  // Dashboard/CLI Windows possono salvare "\\r\\n" letterali o CRLF reali nel valore.
  raw = raw.replace(/\\r\\n/g, "").replace(/[\r\n]/g, "").trim();
  const cleaned = raw.replace(/\/$/, "");
  if (cleaned) return cleaned;
  if (process.env.VERCEL_ENV === "production" || process.env.VERCEL === "1") {
    return HETZNER_SCAN_ENGINE;
  }
  return "";
}
