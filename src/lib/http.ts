import { Agent } from "undici";

/**
 * Helper per chiamate HTTP verso fonti ESTERNE (OpenStreetMap, siti delle RSA).
 *
 * NOTA SICUREZZA: la rete locale di questo ambiente intercetta il traffico TLS
 * (proxy/antivirus) e questo fa fallire la verifica dei certificati per host esterni.
 * Per questo motivo usiamo un Agent dedicato con `rejectUnauthorized: false` SOLO
 * per le chiamate di scraping esterne. Il resto dell'app (DB, API interne) resta sicuro.
 *
 * In un deploy su server "pulito" basta impostare INSECURE_EXTERNAL_TLS=false
 * (o rimuovere il dispatcher) per ripristinare la verifica completa dei certificati.
 */
const allowInsecure = process.env.INSECURE_EXTERNAL_TLS !== "false";

const insecureAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
    timeout: 15_000,
  },
  headersTimeout: 20_000,
  bodyTimeout: 20_000,
});

const DEFAULT_UA =
  "LeadSniperCRM/1.0 (Insurance lead generation tool; contact: admin@leadsniper.local)";

export interface ExternalFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * fetch robusto verso host esterni con:
 * - User-Agent descrittivo (richiesto dalle policy di Overpass/OSM)
 * - timeout configurabile con AbortController
 * - gestione contenuta dell'intercettazione TLS
 */
export async function externalFetch(
  url: string,
  options: ExternalFetchOptions = {}
): Promise<Response> {
  const { timeoutMs = 20_000, headers, ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...rest,
      headers: {
        "User-Agent": DEFAULT_UA,
        ...headers,
      },
      signal: controller.signal,
      // dispatcher è un'opzione undici supportata dal fetch globale di Node
      ...(allowInsecure ? { dispatcher: insecureAgent } : {}),
    } as RequestInit);

    return response;
  } finally {
    clearTimeout(timer);
  }
}
