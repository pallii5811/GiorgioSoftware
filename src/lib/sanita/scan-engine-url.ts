/** URL motore scan Hetzner — normalizza spazi/CRLF da dashboard Vercel. */
export function getScanEngineUrl(): string {
  const raw = process.env.SCAN_ENGINE_URL ?? "";
  return raw.trim().replace(/[\r\n]+/g, "").replace(/\/$/, "");
}
