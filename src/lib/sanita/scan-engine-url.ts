/** URL motore scan Hetzner — normalizza spazi/CRLF da dashboard Vercel. */
export function getScanEngineUrl(): string {
  let raw = (process.env.SCAN_ENGINE_URL ?? "").trim();
  // Dashboard/CLI Windows possono salvare "\\r\\n" letterali o CRLF reali nel valore.
  raw = raw.replace(/\\r\\n/g, "").replace(/[\r\n]/g, "").trim();
  const cleaned = raw.replace(/\/$/, "");
  if (cleaned) return cleaned;
  // Fallback produzione: motore scan su Hetzner (Vercel non esegue Playwright).
  if (process.env.VERCEL === "1" || process.env.VERCEL === "true") {
    return "http://168.119.253.47:3000";
  }
  return "";
}
