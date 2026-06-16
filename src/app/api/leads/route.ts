import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isVercelUiHost, HETZNER_SCAN_ENGINE, getScanEngineUrl } from "@/lib/sanita/scan-engine-url";

const ALLOWED_STATUS = ["NEW", "CONTACTED", "CONVERTED", "LOST"];

async function proxyToEngine(req: Request) {
  const bases = [getScanEngineUrl(), HETZNER_SCAN_ENGINE].filter((v, i, a) => v && a.indexOf(v) === i);
  const url = new URL(req.url);
  for (const base of bases) {
    try {
      const upstream = await fetch(`${base}/api/leads${url.search}`, { cache: "no-store" });
      if (!upstream.ok) continue;
      const body = await upstream.text();
      return new NextResponse(body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      });
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function GET(req: Request) {
  // UI Vercel deve vedere lo stesso DB del motore (Hetzner), altrimenti CRM risulta vuoto.
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req);
    if (proxied) return proxied;
  }
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const region = url.searchParams.get("region");
    const q = (url.searchParams.get("q") ?? "").trim();
    const includePending = url.searchParams.get("includePending") === "1";
    const status = url.searchParams.get("status");

    const leads = await prisma.lead.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(region ? { region } : {}),
        ...(status ? { status } : {}),
        ...(includePending ? {} : { lastScannedAt: { not: null } }),
        ...(q
          ? {
              OR: [
                { companyName: { contains: q } },
                { website: { contains: q } },
                { city: { contains: q } },
                { email: { contains: q } },
                { pec: { contains: q } },
                { phone: { contains: q } },
                { piva: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ reminderAt: "asc" }, { updatedAt: "desc" }],
      take: 2000,
    });

    return NextResponse.json({ success: true, data: leads });
  } catch {
    return NextResponse.json({ success: false, error: "Errore durante il recupero dei lead." }, { status: 500 });
  }
}

// Aggiorna stato commerciale, note e promemoria di un lead (workflow CRM).
export async function PATCH(req: Request) {
  // UI Vercel: patchare sul motore (DB Hetzner) per non perdere gli aggiornamenti CRM.
  if (isVercelUiHost()) {
    const proxied = await proxyToEngine(req);
    if (proxied) return proxied;
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      status?: string;
      notes?: string | null;
      reminderAt?: string | null;
    };
    const { id } = body;
    if (!id) {
      return NextResponse.json({ success: false, error: "ID lead richiesto." }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (!ALLOWED_STATUS.includes(body.status)) {
        return NextResponse.json({ success: false, error: "Stato non valido." }, { status: 400 });
      }
      data.status = body.status;
    }
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.reminderAt !== undefined) {
      data.reminderAt = body.reminderAt ? new Date(body.reminderAt) : null;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ success: false, error: "Nessun campo da aggiornare." }, { status: 400 });
    }

    const lead = await prisma.lead.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: lead });
  } catch {
    return NextResponse.json(
      { success: false, error: "Errore durante l'aggiornamento del lead." },
      { status: 500 }
    );
  }
}
