import { prisma, ensureSqliteWal } from "@/lib/sanita/db-ready";
import { resolveOfficialWebsite } from "@/lib/sanita/resolve-website";
import { pickOfficialWebsite } from "@/lib/sanita/contacts";
import type { Region } from "@/lib/sanita/discovery";
import { normalizeWebsite } from "@/lib/sanita/discovery";
import { closeMapsBrowserPool } from "@/lib/sanita/playwright-maps";

export type EnrichProgress = {
  done: number;
  total: number;
  found: number;
  region: Region;
  name?: string;
};

const ENRICH_TIMEOUT_MS = Number(process.env.ENRICH_TIMEOUT_MS || 75_000);

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Cerca sito ufficiale su Google Maps, poi Tavily. Aggiorna il lead in DB. */
export async function enrichLeadWebsite(
  lead: {
    id: string;
    companyName: string;
    city: string | null;
    region: string;
    phone: string | null;
  },
  opts?: { perLeadMs?: number; maxQueries?: number }
): Promise<{ found: boolean; website: string | null }> {
  const region = lead.region as Region;
  const perLeadMs = opts?.perLeadMs ?? Number(process.env.ENRICH_PER_LEAD_MS || 180_000);
  const resolved = await resolveOfficialWebsite(lead.companyName, lead.city, region, {
    deadline: Date.now() + perLeadMs,
    maxQueries: opts?.maxQueries ?? Number(process.env.RESOLVE_MAPS_MAX_QUERIES || 20),
  });
  const website = resolved.website
    ? pickOfficialWebsite([normalizeWebsite(resolved.website)!], lead.companyName) ??
      normalizeWebsite(resolved.website)
    : null;
  const phone = resolved.phone ?? lead.phone;
  const city = resolved.city ?? lead.city;

  if (website || phone !== lead.phone || city !== lead.city) {
    await writeWithRetry(() =>
      prisma.lead.update({
        where: { id: lead.id },
        data: {
          ...(website ? { website } : {}),
          ...(phone && phone !== lead.phone ? { phone } : {}),
          ...(city && city !== lead.city ? { city } : {}),
        },
      })
    );
  }

  return { found: Boolean(website), website };
}

/** Riprova write su lock/timeout SQLite (P1008/P2034) — robustezza scan parallelo. */
async function writeWithRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = (e as { code?: string })?.code;
      if (code !== "P1008" && code !== "P2034" && code !== "P2024") throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1) + Math.random() * 200));
    }
  }
  throw lastErr;
}

export async function runBatch<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
  }
}

/** Arricchisce tutti i lead senza sito in anagrafica (OSM / Min. Salute). */
export async function bulkEnrichMissingWebsites(
  regions: Region[],
  opts?: {
    concurrency?: number;
    perLeadMs?: number;
    maxQueries?: number;
    onProgress?: (p: EnrichProgress) => void;
  }
): Promise<{ total: number; found: number }> {
  await ensureSqliteWal();
  const concurrency = opts?.concurrency ?? 3;
  let grandFound = 0;

  for (const region of regions) {
    const leads = await prisma.lead.findMany({
      where: {
        type: "HEALTHCARE",
        region,
        OR: [{ website: null }, { website: "" }],
      },
      select: { id: true, companyName: true, city: true, region: true, phone: true },
      orderBy: { companyName: "asc" },
    });

    let done = 0;
    let found = 0;

    await runBatch(leads, concurrency, async (lead) => {
      try {
        const r = await enrichLeadWebsite(lead, {
          perLeadMs: opts?.perLeadMs,
          maxQueries: opts?.maxQueries,
        });
        if (r.found) found++;
      } catch {
        /* lead saltato: rimane senza sito → analizzato via portali regionali */
      } finally {
        done++;
        opts?.onProgress?.({ done, total: leads.length, found, region, name: lead.companyName });
      }
    });

    grandFound += found;
    console.log(`  ✓ ${region}: sito trovato per ${found}/${leads.length} (mancavano in anagrafica)`);
  }

  await closeMapsBrowserPool().catch(() => {});
  const total = await prisma.lead.count({
    where: {
      type: "HEALTHCARE",
      region: { in: regions },
      OR: [{ website: null }, { website: "" }],
    },
  });

  return { total, found: grandFound };
}
